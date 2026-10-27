import * as http from 'http';
import * as path from 'path';
import * as zlib from 'zlib';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

import { config } from './config';
import { Generation } from './firmware';
import { FirmwareUpload, Instance, InstanceManager } from './instances';
import { LinkManager } from './links';
import { deleteMonitor, listMonitors, monitorJSON, setMonitor } from './monitor';
import { UdpRelay } from './udpRelay';
import { UdpDebugConsole } from './udpConsole';

const manager = new InstanceManager();
const links = new LinkManager(manager);
const udpConsole = new UdpDebugConsole();
const relay = new UdpRelay(udpConsole);
const app = express();

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, '../public')));

type Handler = (req: express.Request, res: express.Response) => Promise<any> | any;

// Wraps a handler so thrown errors become JSON 400 responses.
function api(fn: Handler) {
    return async (req: express.Request, res: express.Response) => {
        try {
            const result = await fn(req, res);
            if (!res.headersSent) {
                res.json(result ?? { ok: true });
            }
        } catch (e: any) {
            res.status(e.status || 400).json({ error: e.message });
        }
    };
}

function instance(req: express.Request): Instance {
    const inst = manager.get(req.params.id);
    if (!inst) {
        throw Object.assign(new Error('instance not found'), { status: 404 });
    }
    return inst;
}

function png(width: number, height: number, rgb: Buffer): Buffer {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
    }
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
});

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (const b of buf) {
        c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

// ---- REST API ----

app.get('/api/info', api(() => ({
    relayPort: config.relayPort,
    httpForwardBase: config.httpForwardBase,
    subnet: `${config.subnetPrefix}0/24`,
    relay: { ...relay.stats, clients: relay.clientList() },
})));

// Tibbo monitor per generation; used by instances started after it is set.
app.get('/api/monitors', api(() => listMonitors()));

// Body: { name, bin: base64 } (the plain monitor image, not the encrypted update file)
app.put('/api/monitors/:gen(g2|g3)', api((req) => {
    const { name, bin } = req.body || {};
    if (!bin) {
        throw new Error('bin (base64) is required');
    }
    return monitorJSON(setMonitor(req.params.gen as Generation, name, Buffer.from(bin, 'base64')));
}));

app.delete('/api/monitors/:gen(g2|g3)', api((req) => {
    if (!deleteMonitor(req.params.gen as Generation)) {
        throw Object.assign(new Error('no monitor set'), { status: 404 });
    }
}));

app.get('/api/instances', api(() => manager.list()));

// Uploaded files as sent in a request: { elf?: base64, elfName?, dts?: text, bin?: base64, binName?,
// binAddress? }. elf is the app (dts its devicetree); bin is written into flash at binAddress (a
// number, or a hex string such as "0x08008000"), by default 0x08000000: the monitor/bootloader.
function firmwareUpload(body: any): FirmwareUpload | undefined {
    const { elf, elfName, dts, bin, binName, binAddress } = body || {};
    if (!elf && !bin && !dts) {
        return undefined;
    }
    return {
        elf: elf ? { name: elfName || 'zephyr.elf', data: Buffer.from(elf, 'base64') } : undefined,
        dts: dts ? Buffer.from(dts, 'utf8') : undefined,
        bin: bin ? { name: binName || 'image.bin', data: Buffer.from(bin, 'base64'), address: parseAddress(binAddress) } : undefined,
    };
}

function parseAddress(v: any): number | undefined {
    if (v === undefined || v === null || v === '') {
        return undefined;
    }
    const n = typeof v === 'number' ? v : /^(0x)?[0-9a-f]+$/i.test(String(v).trim()) ? parseInt(String(v).trim().replace(/^0x/i, ''), 16) : NaN;
    if (!Number.isInteger(n)) {
        throw new Error(`binAddress ${v} is not a hex address`);
    }
    return n;
}

// Body: { board: 'tpp2g2'|'tpp3g2'|'tpp2g3'|'tpp3g3', name?, count?, start?, index?, ...files (see firmwareUpload) }.
// Without an elf the instance has no app: it boots into its monitor's Loader for an upload over UDP,
// or waits for an upload. Without a bin it uses the generation's default monitor, if one is set.
// index (with count 1) picks the instance number, and so its MAC, IP and ports; it must be free.
app.post('/api/instances', api(async (req) => {
    const { board, name, count, start, index } = req.body || {};
    const upload = firmwareUpload(req.body);
    const n = Math.max(1, Math.min(16, parseInt(count, 10) || 1));
    if (index !== undefined && n > 1) {
        throw new Error('index needs count 1');
    }
    const created: Instance[] = [];
    try {
        for (let i = 0; i < n; i++) {
            created.push(await manager.create({ board, upload, name: n > 1 && name ? `${name} ${i + 1}` : name, start, index }));
        }
    } finally {
        broadcastInstances();
    }
    return created;
}));

app.patch('/api/instances/:id', api(async (req) => {
    const { name } = req.body || {};
    return manager.update(instance(req).id, { name });
}));

// Body: files as for POST /api/instances (elf and/or bin, dts with elf). Without a dts the
// instance keeps its current one; without a bin, its current monitor.
app.put('/api/instances/:id/firmware', api(async (req) => {
    const upload = firmwareUpload(req.body);
    if (!upload) {
        throw new Error('elf or bin (base64) is required');
    }
    return manager.upload(instance(req).id, upload);
}));

// Drops what .bin uploads wrote into the monitor area: the default monitor (if any) comes back.
app.delete('/api/instances/:id/monitor', api(async (req) => manager.useDefaultMonitor(instance(req).id)));

app.delete('/api/instances/:id', api(async (req) => {
    await manager.remove(instance(req).id);
    broadcastInstances();
}));

app.post('/api/instances/:id/:action(start|stop|restart|reflash|reset|pause|resume)', api(async (req) => {
    const inst = instance(req);
    switch (req.params.action) {
    case 'start': await manager.setRunning(inst.id, true); break;
    case 'stop': await manager.setRunning(inst.id, false); break;
    case 'restart': await inst.restart(); break;
    case 'reflash': await inst.reflash(); break;
    case 'reset': inst.reset(); break;
    case 'pause': inst.pause(); break;
    case 'resume': inst.resume(); break;
    }
    return inst;
}));

// Body: { attached: bool }. Reading debug print dequeues it, so the reader only runs once the
// user attaches it; otherwise the entries stay for a tide-proxy client to fetch.
app.put('/api/instances/:id/debug-print', api((req) => {
    const inst = instance(req);
    inst.debugPrintAttached = !!(req.body || {}).attached;
    syncUdpConsole(inst);
    broadcastInstances();
    return inst;
}));

// Wiring between instances. Body: { kind: 'uart'|'gpio', name?, endpoints: [{ instance, port }] }
// (gpio: endpoints[0] drives the rest).
app.get('/api/links', api(() => ({ links: links.list(), stats: links.statsJSON() })));

app.post('/api/links', api((req) => links.create(req.body || {})));

// Body: { name?, endpoints? }
app.patch('/api/links/:id', api((req) => {
    const { name, endpoints } = req.body || {};
    return links.update(req.params.id, { name, endpoints });
}));

app.delete('/api/links/:id', api((req) => {
    links.remove(req.params.id);
}));

// Body: { button: id, pressed: bool } or { port, pin, level: 0|1|null }
app.post('/api/instances/:id/input', api((req) => {
    applyInput(instance(req), req.body || {});
}));

app.get('/api/instances/:id/log', api((req) => instance(req).log));

app.get('/api/instances/:id/console/:uart', (req, res) => {
    const inst = manager.get(req.params.id);
    if (!inst) {
        res.status(404).end();
        return;
    }
    res.type('text/plain').send(inst.consoleBacklog(req.params.uart));
});

app.get('/api/instances/:id/screen.png', (req, res) => {
    const fb = manager.get(req.params.id)?.lcd;
    if (!fb) {
        res.status(404).json({ error: 'no LCD frame yet' });
        return;
    }
    res.type('image/png').send(png(fb.width, fb.height, fb.rgb));
});

function applyInput(inst: Instance, body: any): void {
    if (body.button !== undefined) {
        const btn = inst.profile.buttons.find((b) => b.id === body.button);
        if (!btn) {
            throw new Error(`unknown button ${body.button}`);
        }
        // Pressed drives the active level; released drives the inactive level.
        const pressed = !!body.pressed;
        inst.setPin(btn.port, btn.pin, btn.activeLow ? !pressed : pressed);
        return;
    }
    const level = body.level === null || body.level === undefined ? null : !!Number(body.level);
    inst.setPin(String(body.port).toUpperCase(), Number(body.pin), level);
}

// ---- WebSocket ----
// Client -> server JSON: {t:'sub', lcd:'*'|[ids], detail:id|null}, {t:'input', id, ...},
//                        {t:'console', id, uart, data}
// Server -> client JSON: {t:'instances', list}, {t:'state', id, state}, {t:'uart', id, uart, data},
//                        {t:'log', id, line}, {t:'backlog', id, uart, data},
//                        {t:'links', links, stats}, {t:'linkStats', stats}
// Server -> client binary: [idLength u8][id utf8][x u16][y u16][w u16][h u16][RGB888...]

interface Client {
    ws: WebSocket;
    lcd: Set<string> | '*';
    detail?: string;
}

const clients = new Set<Client>();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function send(c: Client, msg: any) {
    if (c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify(msg));
    }
}

function wantsLcd(c: Client, id: string) {
    return c.lcd === '*' || c.lcd.has(id) || c.detail === id;
}

function sendLcd(c: Client, id: string, payload: Buffer) {
    if (c.ws.readyState !== WebSocket.OPEN || c.ws.bufferedAmount > 4 * 1024 * 1024) {
        return;
    }
    const idBuf = Buffer.from(id, 'utf8');
    c.ws.send(Buffer.concat([Buffer.from([idBuf.length]), idBuf, payload]));
}

function broadcastInstances() {
    const list = manager.list().map((i) => i.toJSON());
    clients.forEach((c) => send(c, { t: 'instances', list }));
}

function broadcastLinks() {
    const msg = { t: 'links', links: links.list(), stats: links.statsJSON() };
    clients.forEach((c) => send(c, msg));
}

function attach(inst: Instance) {
    if ((inst as any).__wsAttached) {
        return;
    }
    (inst as any).__wsAttached = true;
    links.attach(inst);
    inst.on('state', (state) => clients.forEach((c) => send(c, { t: 'state', id: inst.id, state })));
    inst.on('lcd', (payload: Buffer) => clients.forEach((c) => wantsLcd(c, inst.id) && sendLcd(c, inst.id, payload)));
    inst.on('uart', (uart: string, data: Buffer) =>
        clients.forEach((c) => c.detail === inst.id && send(c, { t: 'uart', id: inst.id, uart, data: data.toString('base64') })));
    inst.on('log', (line: string) => clients.forEach((c) => c.detail === inst.id && send(c, { t: 'log', id: inst.id, line })));
}

// Debug-print reader runs while the instance is up and the user has attached it.
function syncUdpConsole(inst: Instance) {
    if (inst.status === 'running' && inst.debugPrintAttached) {
        udpConsole.attach({ tibboMac: inst.tibboMac, onText: (t) => inst.appendConsole('udp', Buffer.from(t, 'utf8')) });
    } else {
        udpConsole.detach(inst.tibboMac);
    }
}

manager.on('changed', (inst: Instance) => {
    attach(inst);
    syncUdpConsole(inst);
    broadcastInstances();
});

manager.on('removed', (inst: Instance) => {
    udpConsole.detach(inst.tibboMac);
    links.removeInstance(inst.id);
});

links.on('changed', broadcastLinks);
links.on('stats', (stats) => clients.forEach((c) => send(c, { t: 'linkStats', stats })));

wss.on('connection', (ws) => {
    const client: Client = { ws, lcd: '*' };
    clients.add(client);
    send(client, { t: 'instances', list: manager.list().map((i) => i.toJSON()) });
    send(client, { t: 'links', links: links.list(), stats: links.statsJSON() });
    manager.list().forEach((inst) => {
        const full = inst.fullLcdPayload();
        if (full) {
            sendLcd(client, inst.id, full);
        }
    });

    ws.on('message', (raw) => {
        let msg: any;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }
        const inst = msg.id ? manager.get(msg.id) : undefined;
        try {
            switch (msg.t) {
            case 'sub':
                client.lcd = msg.lcd === '*' ? '*' : new Set<string>(msg.lcd || []);
                if (msg.detail !== client.detail) {
                    client.detail = msg.detail || undefined;
                    const d = client.detail ? manager.get(client.detail) : undefined;
                    if (d) {
                        for (const uart of d.consoles) {
                            send(client, { t: 'backlog', id: d.id, uart, data: d.consoleBacklog(uart).toString('base64') });
                        }
                        send(client, { t: 'logBacklog', id: d.id, lines: d.log });
                        const full = d.fullLcdPayload();
                        if (full) {
                            sendLcd(client, d.id, full);
                        }
                    }
                }
                break;
            case 'input':
                if (inst) {
                    applyInput(inst, msg);
                }
                break;
            case 'console':
                inst?.sendConsole(msg.uart, msg.data);
                break;
            }
        } catch (e: any) {
            send(client, { t: 'error', message: e.message });
        }
    });
    ws.on('close', () => clients.delete(client));
});

async function main() {
    manager.load();
    links.load();
    manager.list().forEach(attach);
    udpConsole.start();
    relay.start();
    server.listen(config.httpPort, () => console.log(`sim-manager on http://0.0.0.0:${config.httpPort}`));
    await manager.autoStart();
}

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log('stopping instances...');
    await manager.stopAll();
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

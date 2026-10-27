import * as dgram from 'dgram';
import * as crypto from 'crypto';

import { config } from './config';

// Reads the Zephyr "debug print" log (udp_fwloader + log_udp) the way TIDE does:
//   PC            -> state; 'P' in the 2nd state char means log entries are pending
//   GM0000,02     -> length of the oldest entry (2 bytes, little endian)
//   GM<2+n>,10    -> 16-byte chunk at offset n
//   PR            -> dequeue the entry
// The device also sends a 'J' notification to the last host that talked to it when a
// new entry is queued, so polling only needs to be slow.
//
// Reading dequeues, so when a tide-proxy client (via the relay) is fetching debug print
// itself, the reader backs off and rebuilds the entries from that client's traffic instead.

const DEVICE_PORT = 65535;
const REQUEST_TIMEOUT_MS = 700;
const IDLE_POLL_MS = 1000;
const EXTERNAL_HOLDOFF_MS = 5000;
const CHUNK = 16;

export interface ConsoleTarget {
    // Dotted-decimal MAC, e.g. 0.36.119.254.0.1
    tibboMac: string;
    onText(text: string): void;
}

interface Passive {
    length: number;
    chunks: Map<number, Buffer>;
    requests: Map<string, number>; // nonce -> GM address
}

interface Device {
    key: string; // zero-padded MAC as used on the wire
    target: ConsoleTarget;
    running: boolean;
    wake?: () => void;
    externalUntil: number;
    passive: Passive;
}

export function padMac(dotted: string): string {
    return dotted.split('.').map((o) => o.padStart(3, '0')).join('.');
}

function splitPacket(msg: Buffer): { mac: string; body: string; nonce: string } | undefined {
    const s = msg.toString('latin1');
    const m = s.match(/^_?\[([0-9.]+)\]([\s\S]*)$/);
    if (!m) {
        return undefined;
    }
    const bar = m[2].lastIndexOf('|');
    return {
        mac: m[1].split('.').map((o) => o.padStart(3, '0')).join('.'),
        body: bar >= 0 ? m[2].slice(0, bar) : m[2],
        nonce: bar >= 0 ? m[2].slice(bar + 1) : '',
    };
}

// Parses "&hXXXXXXXX: 48,65,6C" -> { address, bytes }
function parseMemory(body: string): { address: number; bytes: Buffer } | undefined {
    const m = body.match(/&h([0-9A-Fa-f]{1,8}):\s*([0-9A-Fa-f,\s]*)/);
    if (!m) {
        return undefined;
    }
    const bytes = m[2].split(',').map((x) => x.trim()).filter(Boolean).map((x) => parseInt(x, 16));
    return { address: parseInt(m[1], 16), bytes: Buffer.from(bytes) };
}

function logPending(body: string): boolean {
    // "A**P*/00/L:3" or "J*P*..." : reply code, then the 3-char state; [1] is the log flag.
    return body.length >= 4 && body[2] === 'P';
}

function normalize(entry: string): string {
    const text = entry.replace(/\0+$/, '').replace(/\r?\n/g, '\r\n');
    return text.endsWith('\n') ? text : text + '\r\n';
}

export class UdpDebugConsole {
    private sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    private devices = new Map<string, Device>();
    private waiting = new Map<string, (body: string) => void>();

    start(): void {
        this.sock.on('message', (msg) => this.onReply(msg));
        this.sock.on('error', (e) => console.error(`udp console socket: ${e.message}`));
        this.sock.bind(0, config.bridgeIp, () => this.sock.setBroadcast(true));
    }

    attach(target: ConsoleTarget): void {
        const key = padMac(target.tibboMac);
        if (this.devices.has(key)) {
            return;
        }
        const dev: Device = {
            key,
            target,
            running: true,
            externalUntil: 0,
            passive: { length: -1, chunks: new Map(), requests: new Map() },
        };
        this.devices.set(key, dev);
        this.loop(dev).catch((e) => console.error(`udp console ${key}: ${e.message}`));
    }

    detach(tibboMac: string): void {
        const dev = this.devices.get(padMac(tibboMac));
        if (dev) {
            dev.running = false;
            dev.wake?.();
            this.devices.delete(dev.key);
        }
    }

    // ---- passive capture of a relay client's debug-print traffic ----

    observeClientPacket(msg: Buffer): void {
        const p = splitPacket(msg);
        const dev = p && this.devices.get(p.mac);
        if (!p || !dev) {
            return;
        }
        if (p.body.startsWith('GM')) {
            dev.externalUntil = Date.now() + EXTERNAL_HOLDOFF_MS;
            dev.passive.requests.set(p.nonce, parseInt(p.body.slice(2), 16) || 0);
        } else if (p.body.startsWith('PR')) {
            dev.externalUntil = Date.now() + EXTERNAL_HOLDOFF_MS;
            this.flushPassive(dev);
        }
    }

    observeDevicePacket(msg: Buffer): void {
        const p = splitPacket(msg);
        const dev = p && this.devices.get(p.mac);
        if (!p || !dev) {
            return;
        }
        const address = dev.passive.requests.get(p.nonce);
        if (address === undefined) {
            return;
        }
        dev.passive.requests.delete(p.nonce);
        const mem = parseMemory(p.body);
        if (!mem) {
            return;
        }
        if (address === 0) {
            dev.passive.length = mem.bytes.length >= 2 ? mem.bytes[0] | (mem.bytes[1] << 8) : 0;
            dev.passive.chunks.clear();
        } else if (address >= 2) {
            dev.passive.chunks.set(address - 2, mem.bytes);
        }
    }

    private flushPassive(dev: Device): void {
        const { length, chunks } = dev.passive;
        if (length > 0 && chunks.size > 0) {
            const buf = Buffer.alloc(length);
            for (const [offset, bytes] of chunks) {
                bytes.copy(buf, offset, 0, Math.max(0, Math.min(bytes.length, length - offset)));
            }
            dev.target.onText(normalize(buf.toString('utf8')));
        }
        dev.passive.length = -1;
        dev.passive.chunks.clear();
    }

    // ---- active reader ----

    private async loop(dev: Device): Promise<void> {
        while (dev.running) {
            if (Date.now() < dev.externalUntil) {
                await this.sleep(dev, 500);
                continue;
            }
            const state = await this.request(dev, 'PC', '');
            if (state !== undefined && logPending(state)) {
                await this.drain(dev);
                continue;
            }
            await this.sleep(dev, IDLE_POLL_MS);
        }
    }

    private async drain(dev: Device): Promise<void> {
        for (let i = 0; i < 100 && dev.running && Date.now() >= dev.externalUntil; i++) {
            const lenReply = await this.request(dev, 'GM', '0000,02');
            const lenMem = lenReply !== undefined ? parseMemory(lenReply) : undefined;
            if (!lenMem) {
                return;
            }
            const length = lenMem.bytes.length >= 2 ? lenMem.bytes[0] | (lenMem.bytes[1] << 8) : 0;
            if (length > 0) {
                const buf = Buffer.alloc(length);
                for (let offset = 0; offset < length; offset += CHUNK) {
                    const count = Math.min(CHUNK, length - offset);
                    const addr = (offset + 2).toString(16).padStart(4, '0');
                    const reply = await this.request(dev, 'GM', `${addr},${count.toString(16).padStart(2, '0')}`);
                    const mem = reply !== undefined ? parseMemory(reply) : undefined;
                    if (!mem) {
                        return;
                    }
                    mem.bytes.copy(buf, offset, 0, Math.min(mem.bytes.length, length - offset));
                }
                dev.target.onText(normalize(buf.toString('utf8')));
            }
            const next = await this.request(dev, 'PR', '');
            if (next === undefined || !logPending(next)) {
                return;
            }
        }
    }

    private request(dev: Device, cmd: string, data: string): Promise<string | undefined> {
        return new Promise((resolve) => {
            let tries = 0;
            const nonce = crypto.randomBytes(4).toString('hex');
            const send = () => {
                tries++;
                // Broadcast (addressed by MAC) so devices with any static IP still hear it.
                this.sock.send(Buffer.from(`_[${dev.key}]${cmd}${data}|${nonce}`, 'latin1'), DEVICE_PORT, '255.255.255.255');
            };
            const timer = setInterval(() => {
                if (tries >= 3 || !dev.running) {
                    clearInterval(timer);
                    this.waiting.delete(nonce);
                    resolve(undefined);
                } else {
                    send();
                }
            }, REQUEST_TIMEOUT_MS);
            this.waiting.set(nonce, (body) => {
                clearInterval(timer);
                this.waiting.delete(nonce);
                resolve(body);
            });
            send();
        });
    }

    private onReply(msg: Buffer): void {
        const p = splitPacket(msg);
        if (!p) {
            return;
        }
        if (p.body.startsWith('J')) {
            this.devices.get(p.mac)?.wake?.();
            return;
        }
        this.waiting.get(p.nonce)?.(p.body);
    }

    private sleep(dev: Device, ms: number): Promise<void> {
        return new Promise((resolve) => {
            const t = setTimeout(done, ms);
            function done() {
                clearTimeout(t);
                dev.wake = undefined;
                resolve();
            }
            dev.wake = done;
        });
    }
}

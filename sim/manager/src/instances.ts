import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';

import { config, instancesDir } from './config';
import { FirmwareInfo, getFirmware } from './firmware';
import { createTap, deleteTap, writeDhcpHosts, TcpForward } from './network';

const UART_INDEX: Record<string, number> = { usart1: 0, usart2: 1, usart3: 2, uart4: 3, uart5: 4, usart6: 5 };
const CONSOLE_HISTORY_BYTES = 64 * 1024;
const LOG_LINES = 400;

export interface InstanceConfig {
    id: string;
    name: string;
    index: number;
    firmwareId: string;
    autoStart: boolean;
}

export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'exited';

export interface LcdFrame {
    width: number;
    height: number;
    rgb: Buffer;
}

function hex2(n: number): string {
    return n.toString(16).padStart(2, '0');
}

export class Instance extends EventEmitter {
    status: InstanceStatus = 'stopped';
    state: any;
    lcd?: LcdFrame;
    log: string[] = [];
    exitCode?: number | null;

    private proc?: ChildProcess;
    private bridge?: net.Socket;
    private uarts = new Map<string, net.Socket>();
    private consoleHistory = new Map<string, Buffer[]>();
    private forward: TcpForward;
    private stopping = false;

    constructor(public cfg: InstanceConfig) {
        super();
        this.forward = new TcpForward(this.httpPort, this.ip, 80);
    }

    get id(): string {
        return this.cfg.id;
    }

    get dir(): string {
        return path.join(instancesDir(), this.cfg.id);
    }

    get mac(): string {
        return `${config.macPrefix}:${hex2(this.cfg.index)}`;
    }

    // Dotted-decimal form tide-proxy uses (e.g. 0.36.119.254.0.1).
    get tibboMac(): string {
        return this.mac.split(':').map((h) => parseInt(h, 16)).join('.');
    }

    get ip(): string {
        return `${config.subnetPrefix}${config.ipBase + this.cfg.index}`;
    }

    get tap(): string {
        return `tap${this.cfg.index}`;
    }

    get httpPort(): number {
        return config.httpForwardBase + this.cfg.index;
    }

    get monitorPort(): number {
        return config.monitorPortBase + this.cfg.index;
    }

    get bridgePort(): number {
        return config.bridgePortBase + this.cfg.index;
    }

    uartPort(uart: string): number {
        return config.uartPortBase + this.cfg.index * 8 + UART_INDEX[uart];
    }

    get firmware(): FirmwareInfo | undefined {
        return getFirmware(this.cfg.firmwareId);
    }

    save(): void {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, 'config.json'), JSON.stringify(this.cfg, null, 2));
    }

    toJSON() {
        const fw = this.firmware;
        return {
            ...this.cfg,
            status: this.status,
            exitCode: this.exitCode,
            mac: this.mac,
            tibboMac: this.tibboMac,
            ip: this.ip,
            httpPort: this.httpPort,
            monitorPort: this.monitorPort,
            firmware: fw ? { id: fw.id, name: fw.name, generation: fw.generation, profile: fw.profile } : undefined,
            consoles: this.consoles,
            state: this.state,
        };
    }

    // Console channels: 'udp' (debug print over the Tibbo UDP protocol) first, then the UARTs.
    get consoles(): string[] {
        return ['udp', ...(this.firmware?.profile.uarts || []).filter((u) => u in UART_INDEX)];
    }

    consoleBacklog(name: string): Buffer {
        return Buffer.concat(this.consoleHistory.get(name) || []);
    }

    appendConsole(name: string, data: Buffer): void {
        const hist = this.consoleHistory.get(name) || [];
        hist.push(data);
        let total = hist.reduce((n, b) => n + b.length, 0);
        while (total > CONSOLE_HISTORY_BYTES && hist.length > 1) {
            total -= hist.shift()!.length;
        }
        this.consoleHistory.set(name, hist);
        this.emit('uart', name, data);
    }

    async start(): Promise<void> {
        if (this.status === 'starting' || this.status === 'running') {
            return;
        }
        const fw = this.firmware;
        if (!fw) {
            throw new Error(`firmware ${this.cfg.firmwareId} not found`);
        }
        this.stopping = false;
        this.exitCode = undefined;
        this.state = undefined;
        this.lcd = undefined;
        this.consoleHistory.clear();
        this.setStatus('starting');

        fs.mkdirSync(this.dir, { recursive: true });
        const resc = path.join(this.dir, 'instance.resc');
        fs.writeFileSync(resc, this.renderResc(fw));
        await createTap(this.tap);

        this.addLog(`starting renode (${fw.generation}, ${fw.name})`);
        // --console with an open stdin puts monitor output (script errors included) on stdout.
        const proc = spawn(config.renodeBin, ['--disable-gui', '--console', '-P', String(this.monitorPort), '-e', `include @${resc}`], {
            cwd: this.dir,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc = proc;
        const onData = (d: Buffer) => d.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((l) => this.addLog(l));
        proc.stdout?.on('data', onData);
        proc.stderr?.on('data', onData);
        proc.on('exit', (code) => {
            this.addLog(`renode exited (${code})`);
            this.exitCode = code;
            this.proc = undefined;
            this.disconnect();
            deleteTap(this.tap);
            this.setStatus(this.stopping ? 'stopped' : 'exited');
        });

        this.connectBridge();
        for (const uart of fw.profile.uarts) {
            if (uart in UART_INDEX) {
                this.connectUart(uart);
            }
        }
        this.forward.start();
    }

    async stop(): Promise<void> {
        this.stopping = true;
        this.forward.stop();
        const proc = this.proc;
        if (!proc) {
            this.disconnect();
            this.setStatus('stopped');
            return;
        }
        await new Promise<void>((resolve) => {
            const term = setTimeout(() => proc.kill('SIGTERM'), 3000);
            const kill = setTimeout(() => proc.kill('SIGKILL'), 8000);
            proc.once('exit', () => {
                clearTimeout(term);
                clearTimeout(kill);
                resolve();
            });
            proc.stdin?.write('quit\n');
        });
    }

    async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    reset(): void {
        this.bridgeCommand('reset');
    }

    pause(): void {
        this.bridgeCommand('pause');
    }

    resume(): void {
        this.bridgeCommand('resume');
    }

    // level: true = high, false = low, null = release (Hi-Z).
    setPin(port: string, pin: number, level: boolean | null): void {
        if (!/^[A-I]$/.test(port) || pin < 0 || pin > 15) {
            return;
        }
        this.bridgeCommand(level === null ? `release ${port} ${pin}` : `drive ${port} ${pin} ${level ? 1 : 0}`);
    }

    sendConsole(uart: string, data: string | Buffer): void {
        this.uarts.get(uart)?.write(data);
    }

    private renderResc(fw: FirmwareInfo): string {
        const r = config.renodeDir;
        const hex = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');
        const lines = [
            `include @${r}/peripherals/TibboSim.cs`,
            `mach create "${this.cfg.id}"`,
            `machine LoadPlatformDescription @${r}/tibbo_${fw.generation}.repl`,
            `logLevel 2`,
            `logLevel 3 sysbus.ethernet`,
            `logLevel 3 sysbus.ethernet.phy`,
            `sysbus LoadELF @${fw.elfPath}`,
            // Stand-in for the Tibbo monitor at the start of flash: boot into the app on any reset.
            `sysbus WriteDoubleWord 0x08000000 ${hex(fw.initialSp)}`,
            `sysbus WriteDoubleWord 0x08000004 ${hex(fw.resetVector)}`,
            `cpu VectorTableOffset ${hex(fw.flashBase)}`,
            `cpu PerformanceInMips ${fw.generation === 'g3' ? 180 : 120}`,
            `eeprom BackingFile @${path.join(this.dir, 'eeprom.bin')}`,
            `eeprom InitMac "${this.mac}"`,
            `spi1.at45 BackingFile @${path.join(this.dir, 'at45.bin')}`,
        ];
        for (const uart of fw.profile.uarts) {
            if (uart in UART_INDEX) {
                lines.push(`emulation CreateServerSocketTerminal ${this.uartPort(uart)} "term_${uart}" false`);
                lines.push(`connector Connect sysbus.${uart} term_${uart}`);
            }
        }
        lines.push(
            `emulation CreateSwitch "switch"`,
            `emulation CreateTap "${this.tap}" "tap"`,
            `connector Connect host.tap switch`,
            `connector Connect sysbus.ethernet switch`,
            `bridge Port ${this.bridgePort}`,
            `start`,
        );
        return lines.join('\n') + '\n';
    }

    private connectWithRetry(port: number, onSocket: (s: net.Socket) => void): void {
        const attempt = () => {
            if (this.stopping || !this.proc) {
                return;
            }
            const sock = net.connect(port, '127.0.0.1');
            sock.once('connect', () => onSocket(sock));
            sock.once('error', () => {
                sock.destroy();
                setTimeout(attempt, 500);
            });
        };
        attempt();
    }

    private connectBridge(): void {
        this.connectWithRetry(this.bridgePort, (sock) => {
            this.bridge = sock;
            sock.setNoDelay(true);
            // Buttons idle at their inactive level (the board has pull resistors on them).
            for (const b of this.firmware?.profile.buttons || []) {
                this.setPin(b.port, b.pin, b.activeLow);
            }
            this.setStatus('running');
            let pending: Buffer = Buffer.alloc(0);
            sock.on('data', (chunk) => {
                pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
                while (pending.length >= 5) {
                    const len = pending.readUInt32LE(1);
                    if (pending.length < 5 + len) {
                        break;
                    }
                    const type = pending[0];
                    const payload = pending.subarray(5, 5 + len);
                    pending = pending.subarray(5 + len);
                    if (type === 1) {
                        this.onState(JSON.parse(payload.toString('utf8')));
                    } else if (type === 2) {
                        this.onLcdRect(Buffer.from(payload));
                    }
                }
            });
            sock.on('close', () => {
                if (this.bridge === sock) {
                    this.bridge = undefined;
                }
            });
            sock.on('error', () => undefined);
        });
    }

    private connectUart(uart: string): void {
        this.connectWithRetry(this.uartPort(uart), (sock) => {
            this.uarts.set(uart, sock);
            sock.on('data', (d) => this.appendConsole(uart, d));
            sock.on('close', () => {
                if (this.uarts.get(uart) === sock) {
                    this.uarts.delete(uart);
                }
            });
            sock.on('error', () => undefined);
        });
    }

    private onState(state: any): void {
        this.state = state;
        const lcd = state.lcd;
        if (lcd && (!this.lcd || this.lcd.width !== lcd.width || this.lcd.height !== lcd.height)) {
            this.lcd = { width: lcd.width, height: lcd.height, rgb: Buffer.alloc(lcd.width * lcd.height * 3) };
        }
        this.emit('state', state);
    }

    private onLcdRect(payload: Buffer): void {
        const x = payload.readUInt16LE(0);
        const y = payload.readUInt16LE(2);
        const w = payload.readUInt16LE(4);
        const h = payload.readUInt16LE(6);
        const fb = this.lcd;
        if (fb && x + w <= fb.width && y + h <= fb.height) {
            for (let row = 0; row < h; row++) {
                payload.copy(fb.rgb, ((y + row) * fb.width + x) * 3, 8 + row * w * 3, 8 + (row + 1) * w * 3);
            }
        }
        this.emit('lcd', payload);
    }

    // Whole panel as an LCD rect payload, for clients that just connected.
    fullLcdPayload(): Buffer | undefined {
        const fb = this.lcd;
        if (!fb) {
            return undefined;
        }
        const header = Buffer.alloc(8);
        header.writeUInt16LE(0, 0);
        header.writeUInt16LE(0, 2);
        header.writeUInt16LE(fb.width, 4);
        header.writeUInt16LE(fb.height, 6);
        return Buffer.concat([header, fb.rgb]);
    }

    private bridgeCommand(cmd: string): void {
        this.bridge?.write(cmd + '\n');
    }

    private disconnect(): void {
        this.bridge?.destroy();
        this.bridge = undefined;
        this.uarts.forEach((s) => s.destroy());
        this.uarts.clear();
    }

    private setStatus(status: InstanceStatus): void {
        this.status = status;
        this.emit('status', status);
    }

    private addLog(line: string): void {
        // Renode colours its log; keep the text only.
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
        this.log.push(clean);
        if (this.log.length > LOG_LINES) {
            this.log.splice(0, this.log.length - LOG_LINES);
        }
        this.emit('log', clean);
    }
}

export class InstanceManager extends EventEmitter {
    private instances = new Map<string, Instance>();

    load(): void {
        fs.mkdirSync(instancesDir(), { recursive: true });
        for (const id of fs.readdirSync(instancesDir())) {
            const file = path.join(instancesDir(), id, 'config.json');
            if (fs.existsSync(file)) {
                this.track(new Instance(JSON.parse(fs.readFileSync(file, 'utf8'))));
            }
        }
        this.updateDhcp();
    }

    async autoStart(): Promise<void> {
        for (const inst of this.instances.values()) {
            if (inst.cfg.autoStart) {
                await inst.start().catch((e) => console.error(`${inst.id}: ${e.message}`));
            }
        }
    }

    list(): Instance[] {
        return Array.from(this.instances.values()).sort((a, b) => a.cfg.index - b.cfg.index);
    }

    get(id: string): Instance | undefined {
        return this.instances.get(id);
    }

    async create(opts: { name?: string; firmwareId: string; start?: boolean }): Promise<Instance> {
        if (!getFirmware(opts.firmwareId)) {
            throw new Error(`firmware ${opts.firmwareId} not found`);
        }
        const used = new Set(this.list().map((i) => i.cfg.index));
        let index = 1;
        while (used.has(index)) {
            index++;
        }
        if (index > config.maxInstances) {
            throw new Error(`instance limit (${config.maxInstances}) reached`);
        }
        const inst = new Instance({
            id: `sim${index}-${crypto.randomBytes(2).toString('hex')}`,
            name: opts.name || `TPP sim ${index}`,
            index,
            firmwareId: opts.firmwareId,
            autoStart: opts.start !== false,
        });
        inst.save();
        this.track(inst);
        this.updateDhcp();
        if (opts.start !== false) {
            await inst.start();
        }
        return inst;
    }

    async update(id: string, changes: { name?: string; firmwareId?: string }): Promise<Instance> {
        const inst = this.mustGet(id);
        if (changes.firmwareId && !getFirmware(changes.firmwareId)) {
            throw new Error(`firmware ${changes.firmwareId} not found`);
        }
        const firmwareChanged = !!changes.firmwareId && changes.firmwareId !== inst.cfg.firmwareId;
        Object.assign(inst.cfg, changes);
        inst.save();
        if (firmwareChanged && (inst.status === 'running' || inst.status === 'starting')) {
            await inst.restart();
        }
        this.emit('changed', inst);
        return inst;
    }

    async setRunning(id: string, run: boolean): Promise<Instance> {
        const inst = this.mustGet(id);
        inst.cfg.autoStart = run;
        inst.save();
        if (run) {
            await inst.start();
        } else {
            await inst.stop();
        }
        return inst;
    }

    async remove(id: string, wipe = true): Promise<void> {
        const inst = this.mustGet(id);
        await inst.stop();
        this.instances.delete(id);
        if (wipe) {
            fs.rmSync(inst.dir, { recursive: true, force: true });
        }
        this.updateDhcp();
        this.emit('removed', inst);
    }

    usesFirmware(firmwareId: string): boolean {
        return this.list().some((i) => i.cfg.firmwareId === firmwareId);
    }

    async stopAll(): Promise<void> {
        await Promise.all(this.list().map((i) => i.stop()));
    }

    private mustGet(id: string): Instance {
        const inst = this.instances.get(id);
        if (!inst) {
            throw new Error(`instance ${id} not found`);
        }
        return inst;
    }

    private track(inst: Instance): void {
        this.instances.set(inst.id, inst);
        inst.on('status', () => this.emit('changed', inst));
    }

    private updateDhcp(): void {
        writeDhcpHosts(this.list().map((i) => ({ mac: i.mac, ip: i.ip })));
    }
}

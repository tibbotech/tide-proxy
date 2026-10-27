import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';

import { config, instancesDir, legacyFirmwareDir } from './config';
import { BoardProfile } from './dts';
import { APP_BASE, Board, FLASH_SIZE, FirmwareInfo, Generation, boardGeneration, defaultProfile, isBoard, loadFirmware, saveFirmware } from './firmware';
import {
    FLASH_START, LOADER_SIGNATURE, LOADER_SIGNATURE_ADDRESS, checkFlashWrite, flashWrites, forgetFlashApp, getMonitor,
    prepareFlash, useDefaultMonitor, writeFlash,
} from './monitor';
import { createTap, deleteTap, writeDhcpHosts, TcpForward } from './network';

const UART_INDEX: Record<string, number> = { usart1: 0, usart2: 1, usart3: 2, uart4: 3, uart5: 4, usart6: 5 };
const CONSOLE_HISTORY_BYTES = 64 * 1024;
const LOG_LINES = 400;

export interface InstanceConfig {
    id: string;
    name: string;
    index: number;
    board: Board;
    autoStart: boolean;
}

// Files uploaded to an instance: an app ELF (+ DTS), and/or a .bin written into flash at `address`
// (0x08000000, the monitor, by default).
export interface FirmwareUpload {
    elf?: { name: string; data: Buffer };
    dts?: Buffer;
    bin?: { name: string; data: Buffer; address?: number };
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
    // The user attached the UDP debug-print reader (not persisted; survives restarts).
    debugPrintAttached = false;

    private proc?: ChildProcess;
    private bridge?: net.Socket;
    private uarts = new Map<string, net.Socket>();
    private consoleHistory = new Map<string, Buffer[]>();
    private forward: TcpForward;
    private stopping = false;
    // Booted through the real Tibbo monitor from a persistent flash image (vs. the boot stub).
    private monitorBoot = false;
    // Loaded from <dir>/firmware on first use; null when none has been uploaded.
    private fw?: FirmwareInfo | null;

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

    get generation(): Generation {
        return boardGeneration(this.cfg.board);
    }

    get firmwareDir(): string {
        return path.join(this.dir, 'firmware');
    }

    get firmware(): FirmwareInfo | undefined {
        if (this.fw === undefined) {
            this.fw = loadFirmware(this.firmwareDir) || null;
        }
        return this.fw || undefined;
    }

    // Buttons, LEDs and UARTs: from the firmware's DTS, else the TPP defaults for the board.
    get profile(): BoardProfile {
        return this.firmware?.profile || defaultProfile(this.cfg.board);
    }

    // The monitor at 0x08000000: one a .bin upload wrote there, else the generation's default.
    get bootMonitor(): { name: string; own: boolean } | null {
        const own = flashWrites(this.dir).ownMonitor;
        if (own) {
            return { name: own, own: true };
        }
        const def = getMonitor(this.generation);
        return def ? { name: def.name, own: false } : null;
    }

    // Something to boot: an app from the ELF, a monitor (its Loader waits for a UDP upload), or code a
    // .bin upload put into flash.
    get canStart(): boolean {
        return !!this.firmware || !!this.bootMonitor || flashWrites(this.dir).writes.length > 0;
    }

    save(): void {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, 'config.json'), JSON.stringify(this.cfg, null, 2));
    }

    toJSON() {
        const fw = this.firmware;
        return {
            ...this.cfg,
            generation: this.generation,
            status: this.status,
            exitCode: this.exitCode,
            mac: this.mac,
            tibboMac: this.tibboMac,
            ip: this.ip,
            httpPort: this.httpPort,
            monitorPort: this.monitorPort,
            profile: this.profile,
            firmware: fw ? { name: fw.name, uploadedAt: fw.uploadedAt, hasDts: fw.hasDts } : undefined,
            monitor: this.monitorBoot,
            // The monitor the next start uses; own = written by a .bin upload (not the default).
            bootMonitor: this.bootMonitor,
            flashWrites: flashWrites(this.dir).writes,
            canStart: this.canStart,
            consoles: this.consoles,
            debugPrintAttached: this.debugPrintAttached,
            state: this.state,
        };
    }

    // Console channels: 'udp' (debug print over the Tibbo UDP protocol) first, then the UARTs.
    get consoles(): string[] {
        return ['udp', ...this.profile.uarts.filter((u) => u in UART_INDEX)];
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
        const gen = this.generation;
        if (!this.canStart) {
            throw new Error(`no firmware: upload one, or set the ${gen.toUpperCase()} monitor to upload over UDP`);
        }
        fs.mkdirSync(this.dir, { recursive: true });
        const resc = path.join(this.dir, 'instance.resc');
        fs.writeFileSync(resc, this.renderResc(fw));

        this.stopping = false;
        this.exitCode = undefined;
        this.state = undefined;
        this.lcd = undefined;
        this.consoleHistory.clear();
        this.setStatus('starting');
        await createTap(this.tap);

        this.addLog(`starting renode (${this.cfg.board}, ${fw ? fw.name : 'no firmware'})`);
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
        for (const uart of this.profile.uarts) {
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
            if (this.monitorBoot) {
                proc.stdin?.write('bridge SaveFlash\n');
            }
            proc.stdin?.write('quit\n');
        });
    }

    async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    // Reinstall the app from the firmware ELF, replacing one uploaded over UDP.
    async reflash(): Promise<void> {
        if (!this.firmware) {
            throw new Error('no firmware uploaded to reflash from');
        }
        await this.whileStopped(() => forgetFlashApp(this.dir));
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

    // Takes an uploaded ELF (+ DTS) as the app and/or writes a .bin into flash at its address, with
    // the instance stopped (a running one keeps flash in memory) and restarted afterwards. Both are
    // checked before either is kept.
    async upload(u: FirmwareUpload): Promise<void> {
        if (!u.elf && !u.bin) {
            throw new Error('upload a .elf or a .bin');
        }
        if (u.dts && !u.elf) {
            throw new Error('a .dts goes with a .elf');
        }
        const address = u.bin?.address ?? FLASH_START;
        if (u.bin) {
            checkFlashWrite(this.generation, address, u.bin.data);
        }
        await this.whileStopped(() => {
            if (u.elf) {
                this.fw = saveFirmware(this.firmwareDir, this.cfg.board, u.elf.name, u.elf.data, u.dts);
            }
            if (u.bin) {
                writeFlash(this.dir, this.generation, getMonitor(this.generation), this.firmware, address, u.bin.data, u.bin.name);
            }
        });
    }

    // Drops what .bin uploads wrote into the monitor area: the default monitor (if any) comes back.
    async useDefaultMonitor(): Promise<void> {
        await this.whileStopped(() => useDefaultMonitor(this.dir, this.generation));
    }

    // Runs fn with the instance stopped, restarting it afterwards if it was running.
    private async whileStopped(fn: () => void): Promise<void> {
        const running = this.status === 'running' || this.status === 'starting';
        if (running) {
            await this.stop();
        }
        try {
            fn();
        } finally {
            if (running) {
                await this.start();
            }
        }
    }

    private renderResc(fw: FirmwareInfo | undefined): string {
        const r = config.renodeDir;
        const hex = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');
        const gen = this.generation;
        const flash = prepareFlash(this.dir, gen, getMonitor(gen), fw);
        this.monitorBoot = flash.boot === 'monitor';
        let boot: string[];
        if (flash.boot === 'monitor') {
            // Boots like a board; flash.bin is written back on reset and stop.
            const mon = this.bootMonitor;
            this.addLog(`booting through monitor ${mon ? mon.name : 'in flash'}`);
            boot = [
                `sysbus LoadBinary @${flash.file} 0x08000000`,
                `bridge FlashSize ${FLASH_SIZE[gen]}`,
                `bridge FlashFile @${flash.file}`,
            ];
            // No app to start: power up as if an app had asked for a UDP upload (QF), so the
            // monitor's network Loader waits for one instead of blinking "Update system".
            const sig = LOADER_SIGNATURE_ADDRESS[gen];
            if (!flash.appValid && sig !== undefined) {
                this.addLog('no app in flash: starting the monitor\'s network Loader for an upload from TIDE');
                boot.push(`sysbus WriteDoubleWord ${hex(sig)} ${hex(LOADER_SIGNATURE)}`);
            } else if (!flash.appValid) {
                this.addLog(`no app in flash, and the ${gen.toUpperCase()} Loader can't be started without one: upload an ELF`);
            }
        } else if (fw) {
            boot = [
                // Flash as .bin uploads left it, then the app from the ELF.
                `sysbus LoadBinary @${flash.file} 0x08000000`,
                `sysbus LoadELF @${fw.elfPath}`,
                // Stand-in for the Tibbo monitor at the start of flash: boot into the app on any reset.
                `sysbus WriteDoubleWord 0x08000000 ${hex(fw.initialSp)}`,
                `sysbus WriteDoubleWord 0x08000004 ${hex(fw.resetVector)}`,
                `cpu VectorTableOffset ${hex(fw.flashBase)}`,
            ];
        } else if (flash.boot === 'app') {
            // No monitor and no ELF: the app a .bin upload put at the app base, through the boot stub.
            this.addLog('no monitor: booting the app in flash through the boot stub');
            boot = [
                `sysbus LoadBinary @${flash.file} 0x08000000`,
                `sysbus WriteDoubleWord 0x08000000 ${hex(flash.appSp)}`,
                `sysbus WriteDoubleWord 0x08000004 ${hex(flash.appReset)}`,
                `cpu VectorTableOffset ${hex(APP_BASE[gen])}`,
            ];
        } else {
            throw new Error('nothing to boot: no monitor or app in flash and no firmware');
        }
        const lines = [
            `include @${r}/peripherals/TibboSim.cs`,
            `mach create "${this.cfg.id}"`,
            `machine LoadPlatformDescription @${r}/tibbo_${gen}.repl`,
            `logLevel 2`,
            `logLevel 3 sysbus.ethernet`,
            `logLevel 3 sysbus.ethernet.phy`,
            ...boot,
            `cpu PerformanceInMips ${gen === 'g3' ? 180 : 120}`,
            `eeprom BackingFile @${path.join(this.dir, 'eeprom.bin')}`,
            `eeprom InitMac "${this.mac}"`,
            `spi1.at45 BackingFile @${path.join(this.dir, 'at45.bin')}`,
        ];
        for (const uart of this.profile.uarts) {
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
            for (const b of this.profile.buttons) {
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
                const cfg = migrateConfig(path.dirname(file), JSON.parse(fs.readFileSync(file, 'utf8')));
                migrateOwnMonitor(path.dirname(file), cfg);
                this.track(new Instance(cfg));
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

    async create(opts: {
        name?: string;
        board: Board;
        upload?: FirmwareUpload;
        start?: boolean;
    }): Promise<Instance> {
        if (!isBoard(opts.board)) {
            throw new Error('board must be tpp2g2, tpp3g2, tpp2g3 or tpp3g3');
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
            board: opts.board,
            autoStart: false,
        });
        // The ELF (and DTS) is checked against the board, and a .bin as a monitor image, before the
        // instance is kept.
        if (opts.upload) {
            try {
                await inst.upload(opts.upload);
            } catch (e) {
                fs.rmSync(inst.dir, { recursive: true, force: true });
                throw e;
            }
        }
        // Without firmware or a monitor there is nothing to boot yet; it can start after an upload.
        inst.cfg.autoStart = opts.start !== false && inst.canStart;
        inst.save();
        this.track(inst);
        this.updateDhcp();
        if (inst.cfg.autoStart) {
            await inst.start();
        }
        return inst;
    }

    async update(id: string, changes: { name?: string }): Promise<Instance> {
        const inst = this.mustGet(id);
        if (changes.name) {
            inst.cfg.name = changes.name;
        }
        inst.save();
        this.emit('changed', inst);
        return inst;
    }

    async upload(id: string, u: FirmwareUpload): Promise<Instance> {
        const inst = this.mustGet(id);
        await inst.upload(u);
        this.emit('changed', inst);
        return inst;
    }

    async useDefaultMonitor(id: string): Promise<Instance> {
        const inst = this.mustGet(id);
        await inst.useDefaultMonitor();
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

// Instances from before per-instance firmware referenced a shared firmware/<firmwareId>. Copy it
// into the instance (same id, so a monitor flash image stays as it is) and record the board: the
// firmware's DTS board, else TPP2 of the firmware's (or a recorded) generation.
function migrateConfig(dir: string, cfg: any): InstanceConfig {
    if (isBoard(cfg.board)) {
        return cfg;
    }
    const src = cfg.firmwareId ? path.join(legacyFirmwareDir(), cfg.firmwareId) : '';
    const dst = path.join(dir, 'firmware');
    if (src && fs.existsSync(path.join(src, 'meta.json')) && !fs.existsSync(dst)) {
        fs.cpSync(src, dst, { recursive: true });
    }
    const fw = loadFirmware(dst);
    const gen: Generation = fw?.generation || (cfg.generation === 'g3' ? 'g3' : 'g2');
    const fwBoard = fw?.profile.board;
    const board: Board = isBoard(fwBoard) && boardGeneration(fwBoard) === gen ? fwBoard : `tpp2${gen}`;
    const { firmwareId, generation, ...rest } = cfg;
    const migrated: InstanceConfig = { ...rest, board };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(migrated, null, 2));
    return migrated;
}

// An instance's own monitor used to be kept as monitor.bin; it is now written into its flash.
function migrateOwnMonitor(dir: string, cfg: InstanceConfig): void {
    const bin = path.join(dir, 'monitor.bin');
    const meta = path.join(dir, 'monitor.json');
    if (!fs.existsSync(bin)) {
        return;
    }
    const gen = boardGeneration(cfg.board);
    const name = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, 'utf8')).name : 'monitor.bin';
    writeFlash(dir, gen, getMonitor(gen), loadFirmware(path.join(dir, 'firmware')), FLASH_START, fs.readFileSync(bin), name);
    fs.rmSync(bin, { force: true });
    fs.rmSync(meta, { force: true });
}

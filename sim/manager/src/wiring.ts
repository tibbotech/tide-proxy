import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

import { config } from './config';
import { FieldDevice, FieldDeviceManager } from './fielddevices';
import { Instance, InstanceManager } from './instances';
import { Dir, McuPin, Role } from './tibbits';

// Field wiring: wires between terminals, kept in <data>/wires.json. A terminal is on a terminal-block
// Tibbit of a TPP, or on a field device (a Wiegand reader, a Modbus slave, an I/O panel). Terminals
// joined by wires are one net, and what a net does follows from the roles of its terminals:
//  - RS485 (a/b): every device whose A and B are on the same two nets shares a bus. Bytes a TPP sends
//    reach the other TPPs' UARTs and the slaves, a slave's reply goes back to the TPPs. A and B reversed
//    between two devices is a polarity error: nothing crosses.
//  - RS232 (tx/rx): bytes a TPP sends reach the UARTs of the TPPs whose RX is on its TX net.
//  - MCU pins (w0/w1/io): the net is driven by a field device (a reader idles high, a panel channel
//    switches) or else by a TPP output; the other pins on it follow. An output Tibbit's terminal (a
//    relay) only drives: its pin is never driven from the net. An input Tibbit's terminal never drives,
//    and reads high when nothing drives it (no wire, or nothing on its net). Wiegand pulses
//    themselves are made inside Renode, in virtual time (Instance.wiegand).
// Wires that cannot be right (A to B, TX to TX, D0 to W1, ...) are reported as warnings.

export interface TermRef {
    owner: string;
    term: string;
}

export interface Wire {
    id: string;
    a: TermRef;
    b: TermRef;
}

export interface Warning {
    text: string;
    wires: string[];
}

export interface WiringSnapshot {
    wires: Wire[];
    warnings: Warning[];
    // For each field-device terminal ("owner/term"): the MCU pins on its net, for the lamps on a panel.
    pins: Record<string, Array<{ instance: string; port: string }>>;
}

interface Node {
    key: string;
    ref: TermRef;
    label: string;
    role?: Role;
    instance?: Instance;
    device?: FieldDevice;
    mcu?: McuPin;
    uart?: string;
    socket?: string;
    dir?: Dir;
}

type Dest = { kind: 'uart'; instance: string; uart: string } | { kind: 'slave'; id: string };

interface Bus {
    owner: string;
    uart?: string;
    slave?: boolean;
    a: string;
    b: string;
}

const keyOf = (ref: TermRef) => `${ref.owner}/${ref.term}`;
const sameRef = (a: TermRef, b: TermRef) => a.owner === b.owner && a.term === b.term;
const pinName = (p: McuPin) => `P${p.port}${p.pin}`;
const REPLY_DELAY_MS = 3;

const FAMILY: Partial<Record<Role, string>> = { a: 'RS485', b: 'RS485', tx: 'RS232', rx: 'RS232', rts: 'RS232', cts: 'RS232', w0: 'GPIO', w1: 'GPIO', io: 'GPIO', vcc: 'power' };

export class WiringManager extends EventEmitter {
    private wires: Wire[] = [];
    private warnings: Warning[] = [];
    private pins: WiringSnapshot['pins'] = {};
    private nets = new Map<string, Node[]>(); // net id -> its terminals
    private netOf = new Map<string, string>(); // terminal key -> net id
    private routes = new Map<string, Dest[]>();
    private ioInstances = new Set<string>();
    private applied = new Map<string, { inst: Instance; pin: McuPin; level: boolean | null }>();
    private lastJson = '';
    private links: () => Array<{ kind: 'uart' | 'gpio'; endpoints: Array<{ instance: string; port: string }> }> = () => [];

    constructor(private instances: InstanceManager, private fields: FieldDeviceManager) {
        super();
    }

    private get file(): string {
        return path.join(config.dataDir, 'wires.json');
    }

    load(): void {
        if (fs.existsSync(this.file)) {
            this.wires = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        }
        this.rebuild();
    }

    snapshot(): WiringSnapshot {
        return { wires: this.wires, warnings: this.warnings, pins: this.pins };
    }

    // ---- wires ----
    create(a: TermRef, b: TermRef): Wire {
        const na = this.node(a);
        const nb = this.node(b);
        if (!na || !nb) {
            throw new Error(`unknown terminal ${keyOf(na ? b : a)}`);
        }
        if (sameRef(a, b)) {
            throw new Error('a wire needs two different terminals');
        }
        if (this.wires.some((w) => (sameRef(w.a, a) && sameRef(w.b, b)) || (sameRef(w.a, b) && sameRef(w.b, a)))) {
            throw new Error('these terminals are already wired together');
        }
        const wire: Wire = { id: `wire-${crypto.randomBytes(3).toString('hex')}`, a: { ...a }, b: { ...b } };
        this.wires.push(wire);
        this.save();
        this.rebuild();
        return wire;
    }

    remove(id: string): void {
        if (!this.wires.some((w) => w.id === id)) {
            throw Object.assign(new Error('wire not found'), { status: 404 });
        }
        this.wires = this.wires.filter((w) => w.id !== id);
        this.save();
        this.rebuild();
    }

    // A device or instance went away, or its terminals changed: wires to terminals that are gone go too.
    refresh(): void {
        this.rebuild();
    }

    // The links (/api/links), so a port that is both linked and wired can be reported.
    setLinks(get: () => Array<{ kind: 'uart' | 'gpio'; endpoints: Array<{ instance: string; port: string }> }>): void {
        this.links = get;
        this.rebuild();
    }

    // If wires already carry an instance's UART (an RS485/RS232 Tibbit's terminals) or pin (a terminal's
    // MCU line), says which terminals; a link on it as well would deliver everything twice.
    wiredPort(instance: string, port: string, kind: 'uart' | 'gpio'): string | null {
        const inst = this.instances.get(instance);
        if (!inst) {
            return null;
        }
        const t = inst.terminals.find((x) => (kind === 'uart' ? x.uart === port && x.role && ['a', 'b', 'tx', 'rx'].includes(x.role) : x.mcu && pinName(x.mcu) === port) && this.netOf.has(`${instance}/${x.id}`));
        return t ? `${inst.cfg.name} ${port} is already wired through terminal ${t.n} of socket ${t.block}` : null;
    }

    // ---- wiring to hardware ----
    attach(inst: Instance): void {
        inst.on('uart', (uart: string, data: Buffer) => this.onUart(inst, uart, data));
        inst.on('state', () => {
            if (this.ioInstances.has(inst.id)) {
                this.applyIo();
            }
        });
        inst.on('status', (status: string) => {
            for (const key of [...this.applied.keys()]) {
                if (key.startsWith(`${inst.id}/`)) {
                    this.applied.delete(key);
                }
            }
            if (status === 'running') {
                this.applyIo();
            }
        });
    }

    // Sends a card swipe from a reader down its lines as Wiegand pulses. Returns the TPPs reached.
    swipe(deviceId: string, bits: string): string[] {
        const device = this.fields.get(deviceId);
        if (!device) {
            throw Object.assign(new Error('device not found'), { status: 404 });
        }
        const pinsOn = (term: string) => (this.nets.get(this.netOf.get(`${deviceId}/${term}`) || '') || []).filter((n) => n.instance && n.mcu);
        const d0 = pinsOn('D0');
        const d1 = pinsOn('D1');
        const reached = new Map<Instance, { d0: McuPin[]; d1: McuPin[] }>();
        const slot = (n: Node) => {
            let s = reached.get(n.instance!);
            if (!s) {
                reached.set(n.instance!, (s = { d0: [], d1: [] }));
            }
            return s;
        };
        d0.forEach((n) => slot(n).d0.push(n.mcu!));
        d1.forEach((n) => slot(n).d1.push(n.mcu!));
        const live = [...reached.keys()].filter((i) => i.status === 'running');
        if (!reached.size) {
            throw new Error(`${device.name}: D0 and D1 are not wired to a TPP terminal`);
        }
        if (!live.length) {
            throw new Error(`${device.name}: the TPP it is wired to is not running`);
        }
        for (const inst of live) {
            const s = reached.get(inst)!;
            inst.wiegand(s.d0, s.d1, bits, device.props.pulseUs, device.props.gapUs);
        }
        return live.map((i) => i.id);
    }

    // ---- graph ----
    private node(ref: TermRef): Node | undefined {
        const inst = this.instances.get(ref.owner);
        if (inst) {
            const t = inst.terminals.find((x) => x.id === ref.term);
            return t && { key: keyOf(ref), ref, label: t.label || String(t.n), role: t.role, instance: inst, mcu: t.mcu, uart: t.uart, socket: t.socket, dir: t.dir };
        }
        const dev = this.fields.get(ref.owner);
        if (dev) {
            const t = this.fields.terminals(dev).find((x) => x.id === ref.term);
            return t && { key: keyOf(ref), ref, label: t.label, role: t.role, device: dev };
        }
        return undefined;
    }

    private rebuild(): void {
        // Wires to terminals that no longer exist are dropped.
        const valid = this.wires.filter((w) => this.node(w.a) && this.node(w.b));
        if (valid.length !== this.wires.length) {
            this.wires = valid;
            this.save();
        }

        const parent = new Map<string, string>();
        const find = (k: string): string => {
            let r = k;
            while (parent.get(r) !== r) {
                r = parent.get(r)!;
            }
            parent.set(k, r);
            return r;
        };
        const nodes = new Map<string, Node>();
        for (const w of this.wires) {
            for (const ref of [w.a, w.b]) {
                nodes.set(keyOf(ref), this.node(ref)!);
                if (!parent.has(keyOf(ref))) {
                    parent.set(keyOf(ref), keyOf(ref));
                }
            }
            parent.set(find(keyOf(w.a)), find(keyOf(w.b)));
        }
        this.nets = new Map();
        this.netOf = new Map();
        for (const [k, n] of nodes) {
            const root = find(k);
            this.netOf.set(k, root);
            const list = this.nets.get(root) || [];
            list.push(n);
            this.nets.set(root, list);
        }

        this.warnings = [];
        this.routes = new Map();
        this.checkNets();
        this.buildBuses();
        this.buildSerial();
        for (const link of this.links()) {
            for (const e of link.endpoints) {
                const why = this.wiredPort(e.instance, e.port, link.kind);
                if (why) {
                    this.warnings.push({ text: `${why} and also linked in the Links tab: ${link.kind === 'uart' ? 'its bytes arrive twice' : 'two things drive it'}. Delete the link.`, wires: [] });
                }
            }
        }
        this.ioInstances = new Set();
        for (const net of this.nets.values()) {
            if (net.some((n) => n.mcu)) {
                net.forEach((n) => n.instance && n.mcu && this.ioInstances.add(n.instance.id));
            }
        }
        this.pins = {};
        for (const net of this.nets.values()) {
            const mcu = net.filter((n) => n.instance && n.mcu).map((n) => ({ instance: n.instance!.id, port: pinName(n.mcu!) }));
            for (const n of net) {
                if (n.device) {
                    this.pins[n.key] = mcu;
                }
            }
        }
        this.applyIo();

        const json = JSON.stringify(this.snapshot());
        if (json !== this.lastJson) {
            this.lastJson = json;
            this.emit('changed');
        }
    }

    private netId(owner: string, term: string): string | undefined {
        return this.netOf.get(`${owner}/${term}`);
    }

    private wiresIn(net: Node[]): string[] {
        const keys = new Set(net.map((n) => n.key));
        return this.wires.filter((w) => keys.has(keyOf(w.a)) && keys.has(keyOf(w.b))).map((w) => w.id);
    }

    private describe(n: Node): string {
        return `${n.instance ? n.instance.cfg.name : n.device!.name} ${n.label}`;
    }

    // Terminals that must not meet on one net.
    private checkNets(): void {
        for (const net of this.nets.values()) {
            const roles = net.map((n) => n.role);
            const has = (r: Role) => net.filter((n) => n.role === r);
            const warn = (text: string) => this.warnings.push({ text, wires: this.wiresIn(net) });
            const families = new Set(net.map((n) => (n.role ? FAMILY[n.role] : undefined)).filter(Boolean));
            // Both terminals of one device on a net: a short. Two devices with A on B is a polarity error instead (buildBuses).
            const shorted = (r1: Role, r2: Role) => has(r1).find((x) => has(r2).some((y) => y.ref.owner === x.ref.owner && y.socket === x.socket));
            const shortA = shorted('a', 'b');
            const shortW = shorted('w0', 'w1');
            if (shortA) {
                warn(`${this.describe(shortA)} and its other RS485 terminal are on the same net: the pair is shorted`);
            }
            if (shortW) {
                warn(`${this.describe(shortW)} and its other Wiegand line are on the same net: D0 and D1 are shorted`);
            } else if (has('w0').length && has('w1').length) {
                const [x, y] = [has('w0')[0], has('w1')[0]];
                warn(`${this.describe(x)} and ${this.describe(y)} are on the same net: Wiegand D0 and D1 are swapped, so bits arrive inverted`);
            }
            if (has('tx').length > 1) {
                warn(`${this.describe(has('tx')[0])} and ${this.describe(has('tx')[1])} are both transmitters on one net: connect TX to RX`);
            } else if (families.size > 1) {
                const mixed = net.filter((n) => n.role && FAMILY[n.role]).map((n) => this.describe(n));
                warn(`${mixed.join(', ')} are on one net, but they are different kinds of signal`);
            } else if (roles.includes('gnd') && families.size > 0) {
                warn(`${net.map((n) => this.describe(n)).join(', ')}: a signal or supply is wired to ground`);
            }
        }
    }

    private addRoute(from: string, to: Dest): void {
        const list = this.routes.get(from) || [];
        list.push(to);
        this.routes.set(from, list);
    }

    // RS485: devices with A and B wired. Same nets = one bus; crossed nets = reversed polarity.
    private buildBuses(): void {
        const buses: Bus[] = [];
        const consider = (owner: string, aKey: string, bKey: string, name: string, extra: Partial<Bus>) => {
            const a = this.netOf.get(aKey);
            const b = this.netOf.get(bKey);
            if (!a && !b) {
                return;
            }
            if (!a || !b) {
                this.warnings.push({ text: `${name}: only ${a ? 'A (485+)' : 'B (485-)'} is wired; an RS485 bus needs both`, wires: this.wires.filter((w) => [keyOf(w.a), keyOf(w.b)].some((k) => k === aKey || k === bKey)).map((w) => w.id) });
                return;
            }
            buses.push({ owner, a, b, ...extra });
        };
        for (const inst of this.instances.list()) {
            const bySocket = new Map<string, { a?: string; b?: string; uart?: string }>();
            for (const t of inst.terminals) {
                if ((t.role === 'a' || t.role === 'b') && t.socket) {
                    const s = bySocket.get(t.socket) || {};
                    s[t.role] = `${inst.id}/${t.id}`;
                    s.uart = t.uart;
                    bySocket.set(t.socket, s);
                }
            }
            for (const s of bySocket.values()) {
                if (s.a && s.b && s.uart) {
                    consider(inst.id, s.a, s.b, `${inst.cfg.name} ${s.uart}`, { uart: s.uart });
                    if ((this.netOf.get(s.a) || this.netOf.get(s.b)) && inst.firmware && !inst.profile.uarts.includes(s.uart)) {
                        this.warnings.push({ text: `${inst.cfg.name}: ${s.uart} is not enabled in the firmware's devicetree, so nothing reaches it`, wires: [] });
                    }
                }
            }
        }
        for (const dev of this.fields.list()) {
            if (dev.kind === 'modbus-slave') {
                consider(dev.id, `${dev.id}/A`, `${dev.id}/B`, dev.name, { slave: true });
            }
        }
        const source = (b: Bus) => (b.slave ? `slave:${b.owner}` : `${b.owner}/${b.uart}`);
        const dest = (b: Bus): Dest => (b.slave ? { kind: 'slave', id: b.owner } : { kind: 'uart', instance: b.owner, uart: b.uart! });
        for (let i = 0; i < buses.length; i++) {
            for (let j = i + 1; j < buses.length; j++) {
                const x = buses[i];
                const y = buses[j];
                if (x.a === y.a && x.b === y.b) {
                    if (!(x.slave && y.slave)) {
                        this.addRoute(source(x), dest(y));
                        this.addRoute(source(y), dest(x));
                    }
                } else if (x.a === y.b && x.b === y.a) {
                    const names = [x, y].map((b) => this.instances.get(b.owner)?.cfg.name || this.fields.get(b.owner)?.name || b.owner);
                    this.warnings.push({ text: `${names[0]} and ${names[1]}: RS485 polarity is reversed (A to B), so they cannot hear each other`, wires: this.wires.map((w) => w.id).filter((id) => {
                        const w = this.wires.find((q) => q.id === id)!;
                        return [x, y].some((b) => w.a.owner === b.owner || w.b.owner === b.owner);
                    }) });
                }
            }
        }
    }

    // RS232: a TPP's TX net reaches the RX of the TPPs on it.
    private buildSerial(): void {
        interface Port { inst: Instance; uart: string; tx?: string; rx?: string }
        const ports: Port[] = [];
        for (const inst of this.instances.list()) {
            const bySocket = new Map<string, Port>();
            for (const t of inst.terminals) {
                if ((t.role === 'tx' || t.role === 'rx') && t.socket && t.uart) {
                    const p = bySocket.get(t.socket) || { inst, uart: t.uart };
                    p[t.role] = this.netOf.get(`${inst.id}/${t.id}`);
                    bySocket.set(t.socket, p);
                }
            }
            ports.push(...bySocket.values());
        }
        for (const from of ports) {
            if (!from.tx) {
                continue;
            }
            for (const to of ports) {
                if (to !== from && to.rx && to.rx === from.tx) {
                    this.addRoute(`${from.inst.id}/${from.uart}`, { kind: 'uart', instance: to.inst.id, uart: to.uart });
                }
            }
        }
    }

    // ---- traffic ----
    private deliver(dest: Dest, data: Buffer, fromSlave = false): void {
        if (dest.kind === 'uart') {
            this.instances.get(dest.instance)?.sendConsole(dest.uart, data);
            return;
        }
        if (fromSlave) {
            return;
        }
        for (const reply of this.fields.feed(dest.id, data)) {
            setTimeout(() => (this.routes.get(`slave:${dest.id}`) || []).forEach((d) => this.deliver(d, reply, true)), REPLY_DELAY_MS);
        }
    }

    private onUart(inst: Instance, uart: string, data: Buffer): void {
        for (const dest of this.routes.get(`${inst.id}/${uart}`) || []) {
            this.deliver(dest, data);
        }
    }

    // ---- MCU pins ----
    private fieldLevel(n: Node): boolean | null {
        const dev = n.device!;
        if (dev.kind === 'wiegand-reader') {
            return n.role === 'w0' || n.role === 'w1' ? true : null;
        }
        if (dev.kind === 'io-panel' && /^C\d$/.test(n.ref.term)) {
            const c = dev.props.channels[Number(n.ref.term.slice(1)) - 1];
            return c === null || c === undefined ? null : !!c;
        }
        return null;
    }

    private pinOutput(n: Node): boolean | null {
        const state = n.instance!.state;
        if (!state || !n.mcu) {
            return null;
        }
        const bit = 1 << n.mcu.pin;
        return ((state.out?.[n.mcu.port] ?? 0) & bit) !== 0 ? ((state.pins?.[n.mcu.port] ?? 0) & bit) !== 0 : null;
    }

    private applyIo(): void {
        const want = new Map<string, { inst: Instance; pin: McuPin; level: boolean | null }>();
        for (const net of this.nets.values()) {
            const tpp = net.filter((n) => n.instance && n.mcu);
            if (!tpp.length) {
                continue;
            }
            let level: boolean | null = null;
            let driver: Node | undefined;
            // An output Tibbit (a relay) drives whatever else is on the net.
            for (const n of tpp) {
                if (n.dir === 'out' && level === null) {
                    level = this.pinOutput(n);
                }
            }
            for (const n of net) {
                if (n.device && level === null) {
                    level = this.fieldLevel(n);
                }
            }
            if (level === null) {
                for (const n of tpp) {
                    const out = n.dir ? null : this.pinOutput(n);
                    if (out !== null) {
                        level = out;
                        driver = n;
                        break;
                    }
                }
            }
            for (const n of tpp) {
                if (n !== driver && n.dir !== 'out') {
                    want.set(`${n.instance!.id}/${pinName(n.mcu!)}`, { inst: n.instance!, pin: n.mcu!, level: level === null && n.dir === 'in' ? true : level });
                }
            }
        }
        // An input with no wire is open: its pull-up holds it high.
        for (const inst of this.instances.list()) {
            for (const t of inst.terminals) {
                if (t.dir === 'in' && t.mcu && !this.netOf.has(`${inst.id}/${t.id}`)) {
                    want.set(`${inst.id}/${pinName(t.mcu)}`, { inst, pin: t.mcu, level: true });
                }
            }
        }
        for (const [key, a] of [...this.applied]) {
            if (!want.has(key)) {
                a.inst.setPin(a.pin.port, a.pin.pin, null);
                this.applied.delete(key);
            }
        }
        for (const [key, w] of want) {
            const prev = this.applied.get(key);
            if (!prev || prev.level !== w.level) {
                w.inst.setPin(w.pin.port, w.pin.pin, w.level);
                this.applied.set(key, w);
            }
        }
    }

    private save(): void {
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.wires, null, 2));
    }
}

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

import { config } from './config';
import { Register, RegisterType, RequestFramer, handleRequest } from './modbus';
import { Role } from './tibbits';

// Devices on the DIN rail next to the TPPs: what the field wiring ends at. They have terminals, not
// firmware. Kept in <data>/devices.json.
//  - wiegand-reader: a card reader on D0/D1. swipe() makes the bit string; the wiring engine turns it
//    into pulses on the lines' MCU pins inside Renode.
//  - modbus-slave:   an RTU slave on an RS485 bus (A/B), answering the masters wired to it from its
//    register table.
//  - io-panel:       four switch/lamp channels on direct I/O lines.

export type FieldKind = 'wiegand-reader' | 'modbus-slave' | 'io-panel';

export interface FieldTerminal {
    id: string;
    label: string;
    role: Role;
}

export interface FieldDevice {
    id: string;
    kind: FieldKind;
    name: string;
    props: Record<string, any>;
}

export const FIELD_KINDS: Record<FieldKind, { title: string; terminals: FieldTerminal[] }> = {
    'wiegand-reader': {
        title: 'Wiegand reader',
        terminals: [{ id: 'D0', label: 'D0', role: 'w0' }, { id: 'D1', label: 'D1', role: 'w1' }, { id: 'GND', label: 'GND', role: 'gnd' }],
    },
    'modbus-slave': {
        title: 'Modbus RTU slave',
        terminals: [{ id: 'A', label: 'A', role: 'a' }, { id: 'B', label: 'B', role: 'b' }, { id: 'GND', label: 'GND', role: 'gnd' }],
    },
    'io-panel': {
        title: 'I/O panel',
        terminals: [1, 2, 3, 4].map((n) => ({ id: `C${n}`, label: `${n}`, role: 'io' as Role })).concat([{ id: 'GND', label: 'GND', role: 'gnd' }]),
    },
};

export const isFieldKind = (k: any): k is FieldKind => typeof k === 'string' && k in FIELD_KINDS;

const WIEGAND_FORMATS: Record<number, [number, number]> = { 26: [8, 16], 34: [16, 16], 37: [16, 19] };

// Wiegand frame: even parity over the first half of the data, the data, odd parity over the second half.
export function wiegandBits(format: number, facility: number, card: number): string {
    const widths = WIEGAND_FORMATS[format];
    if (!widths) {
        throw new Error(`format must be ${Object.keys(WIEGAND_FORMATS).join(', ')} or raw`);
    }
    const [fw, cw] = widths;
    if (!Number.isInteger(facility) || facility < 0 || facility >= 2 ** fw) {
        throw new Error(`facility must be 0-${2 ** fw - 1} for ${format}-bit`);
    }
    if (!Number.isInteger(card) || card < 0 || card >= 2 ** cw) {
        throw new Error(`card must be 0-${2 ** cw - 1} for ${format}-bit`);
    }
    const data = facility.toString(2).padStart(fw, '0') + card.toString(2).padStart(cw, '0');
    const half = data.length / 2;
    const ones = (s: string) => s.split('').filter((c) => c === '1').length;
    const even = ones(data.slice(0, half)) % 2 === 0 ? '0' : '1';
    const odd = ones(data.slice(half)) % 2 === 0 ? '1' : '0';
    return even + data + odd;
}

const clampInt = (v: any, lo: number, hi: number, def: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

const REGISTER_TYPES: RegisterType[] = ['holding', 'input', 'coil', 'discrete'];

function defaults(kind: FieldKind): Record<string, any> {
    switch (kind) {
    case 'wiegand-reader':
        return { format: 26, facility: 12, card: 3456, bits: '', pulseUs: 100, gapUs: 1000 };
    case 'modbus-slave':
        return {
            unit: 1,
            registers: [
                { type: 'holding', address: 0, name: 'Setpoint', value: 250 },
                { type: 'holding', address: 1, name: 'Mode', value: 1 },
                { type: 'input', address: 0, name: 'Temperature x10', value: 215 },
                { type: 'input', address: 1, name: 'Humidity x10', value: 480 },
                { type: 'coil', address: 0, name: 'Relay', value: 0 },
                { type: 'discrete', address: 0, name: 'Door contact', value: 1 },
            ] as Register[],
        };
    case 'io-panel':
        return { channels: [null, null, null, null] };
    }
}

// Checks and normalises props; anything missing keeps its current value.
function cleanProps(kind: FieldKind, current: Record<string, any>, incoming: Record<string, any>): Record<string, any> {
    const next = { ...current };
    switch (kind) {
    case 'wiegand-reader':
        if (incoming.format !== undefined) {
            next.format = incoming.format === 'raw' ? 'raw' : clampInt(incoming.format, 26, 37, 26);
            if (next.format !== 'raw' && !WIEGAND_FORMATS[next.format]) {
                throw new Error('format must be 26, 34, 37 or raw');
            }
        }
        if (incoming.facility !== undefined) next.facility = clampInt(incoming.facility, 0, 65535, 0);
        if (incoming.card !== undefined) next.card = clampInt(incoming.card, 0, 524287, 0);
        if (incoming.bits !== undefined) {
            const bits = String(incoming.bits).replace(/\s+/g, '');
            if (!/^[01]{0,128}$/.test(bits)) {
                throw new Error('bits must be 0s and 1s');
            }
            next.bits = bits;
        }
        if (incoming.pulseUs !== undefined) next.pulseUs = clampInt(incoming.pulseUs, 20, 5000, 100);
        if (incoming.gapUs !== undefined) next.gapUs = clampInt(incoming.gapUs, 200, 50000, 1000);
        break;
    case 'modbus-slave':
        if (incoming.unit !== undefined) next.unit = clampInt(incoming.unit, 1, 247, 1);
        if (incoming.registers !== undefined) {
            if (!Array.isArray(incoming.registers) || incoming.registers.length > 500) {
                throw new Error('registers must be a list of up to 500');
            }
            const seen = new Set<string>();
            next.registers = incoming.registers.map((r: any) => {
                const type = r?.type;
                if (!REGISTER_TYPES.includes(type)) {
                    throw new Error(`register type must be ${REGISTER_TYPES.join(', ')}`);
                }
                const address = clampInt(r.address, 0, 65535, 0);
                const key = `${type}:${address}`;
                if (seen.has(key)) {
                    throw new Error(`${type} register ${address} is listed twice`);
                }
                seen.add(key);
                const bit = type === 'coil' || type === 'discrete';
                return { type, address, name: String(r.name || '').slice(0, 40), value: bit ? (Number(r.value) ? 1 : 0) : clampInt(r.value, 0, 65535, 0) };
            });
        }
        break;
    case 'io-panel':
        if (incoming.channels !== undefined) {
            if (!Array.isArray(incoming.channels) || incoming.channels.length !== 4) {
                throw new Error('channels must be a list of 4: null (released), 0 or 1');
            }
            next.channels = incoming.channels.map((c: any) => (c === null || c === undefined ? null : Number(c) ? 1 : 0));
        }
        break;
    }
    return next;
}

const ACTIVITY_LINES = 40;

export class FieldDeviceManager extends EventEmitter {
    private devices: FieldDevice[] = [];
    private framers = new Map<string, RequestFramer>();
    private activity = new Map<string, string[]>();

    private get file(): string {
        return path.join(config.dataDir, 'devices.json');
    }

    load(): void {
        if (fs.existsSync(this.file)) {
            this.devices = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        }
    }

    list(): FieldDevice[] {
        return this.devices;
    }

    get(id: string): FieldDevice | undefined {
        return this.devices.find((d) => d.id === id);
    }

    terminals(device: FieldDevice): FieldTerminal[] {
        return FIELD_KINDS[device.kind].terminals;
    }

    toJSON() {
        return this.devices.map((d) => ({ ...d, title: FIELD_KINDS[d.kind].title, terminals: FIELD_KINDS[d.kind].terminals, activity: this.activity.get(d.id) || [] }));
    }

    create(input: { kind?: string; name?: string; props?: Record<string, any> }): FieldDevice {
        if (!isFieldKind(input.kind)) {
            throw new Error(`kind must be ${Object.keys(FIELD_KINDS).join(', ')}`);
        }
        const kind = input.kind;
        const same = this.devices.filter((d) => d.kind === kind).length;
        const device: FieldDevice = {
            id: `dev-${crypto.randomBytes(3).toString('hex')}`,
            kind,
            name: (input.name || `${FIELD_KINDS[kind].title} ${same + 1}`).slice(0, 60),
            props: cleanProps(kind, defaults(kind), input.props || {}),
        };
        this.devices.push(device);
        this.commit();
        return device;
    }

    update(id: string, input: { name?: string; props?: Record<string, any> }): FieldDevice {
        const device = this.mustGet(id);
        if (input.name !== undefined) {
            device.name = String(input.name).slice(0, 60);
        }
        if (input.props) {
            device.props = cleanProps(device.kind, device.props, input.props);
        }
        this.commit();
        return device;
    }

    remove(id: string): void {
        const device = this.mustGet(id);
        this.devices = this.devices.filter((d) => d !== device);
        this.framers.delete(id);
        this.activity.delete(id);
        this.commit();
        this.emit('removed', device);
    }

    // The bits a reader sends for a swipe: the raw string, or the format with facility and card.
    swipe(id: string, input: { format?: any; facility?: any; card?: any; bits?: string }): { device: FieldDevice; bits: string } {
        const device = this.mustGet(id);
        if (device.kind !== 'wiegand-reader') {
            throw new Error('only a Wiegand reader swipes cards');
        }
        const merged = cleanProps('wiegand-reader', device.props, { format: input.format, facility: input.facility, card: input.card, bits: input.bits });
        const bits = input.bits !== undefined || merged.format === 'raw' ? merged.bits : wiegandBits(merged.format, merged.facility, merged.card);
        if (!bits) {
            throw new Error('no bits to send');
        }
        this.note(device.id, `swipe ${bits.length} bits: ${bits}`);
        this.emit('changed');
        return { device, bits };
    }

    // Bytes from a master reached a Modbus slave; returns the replies to put on the bus.
    feed(id: string, data: Buffer): Buffer[] {
        const device = this.devices.find((d) => d.id === id && d.kind === 'modbus-slave');
        if (!device) {
            return [];
        }
        let framer = this.framers.get(id);
        if (!framer) {
            this.framers.set(id, (framer = new RequestFramer()));
        }
        const replies: Buffer[] = [];
        let changed = false;
        let wrote = false;
        for (const frame of framer.push(data)) {
            const out = handleRequest(frame, device.props.unit, device.props.registers);
            this.note(id, `${out.reply ? '→' : '·'} ${out.note}`);
            if (out.reply) {
                replies.push(out.reply);
            }
            changed = true;
            wrote = wrote || !!out.wrote;
        }
        if (changed) {
            this.commit(wrote);
        }
        return replies;
    }

    private note(id: string, line: string): void {
        const log = this.activity.get(id) || [];
        log.push(`${new Date().toLocaleTimeString('en-GB')} ${line}`);
        if (log.length > ACTIVITY_LINES) {
            log.splice(0, log.length - ACTIVITY_LINES);
        }
        this.activity.set(id, log);
    }

    private mustGet(id: string): FieldDevice {
        const device = this.get(id);
        if (!device) {
            throw Object.assign(new Error('device not found'), { status: 404 });
        }
        return device;
    }

    private commit(save = true): void {
        if (save) {
            fs.mkdirSync(config.dataDir, { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.devices, null, 2));
        }
        this.emit('changed');
    }
}

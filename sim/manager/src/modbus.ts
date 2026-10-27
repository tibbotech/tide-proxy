// Modbus RTU slave: frame splitting and request handling. Pure functions over a register list, so
// the simulated device (fielddevices.ts) only has to feed it bytes and send the reply.

export type RegisterType = 'holding' | 'input' | 'coil' | 'discrete';

export interface Register {
    type: RegisterType;
    address: number;
    name: string;
    value: number;
}

export function crc16(buf: Buffer): number {
    let crc = 0xffff;
    for (const b of buf) {
        crc ^= b;
        for (let i = 0; i < 8; i++) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
        }
    }
    return crc;
}

export function withCrc(body: Buffer): Buffer {
    const out = Buffer.alloc(body.length + 2);
    body.copy(out);
    out.writeUInt16LE(crc16(body), body.length);
    return out;
}

// Length of the request at the start of buf: 0 while more bytes are needed, -1 for a function code
// this slave does not frame (the buffer is then dropped).
export function requestLength(buf: Buffer): number {
    if (buf.length < 2) {
        return 0;
    }
    const fn = buf[1];
    if (fn >= 1 && fn <= 6) {
        return 8;
    }
    if (fn === 0x0f || fn === 0x10) {
        return buf.length < 7 ? 0 : 9 + buf[6];
    }
    return -1;
}

// Cuts a byte stream into request frames. RTU frames are normally told apart by the 3.5-character
// gap; the simulated UARTs carry no timing, so frames are cut by their length instead.
export class RequestFramer {
    private buf: Buffer = Buffer.alloc(0);

    push(data: Buffer): Buffer[] {
        this.buf = Buffer.concat([this.buf, data]);
        const frames: Buffer[] = [];
        for (;;) {
            const len = requestLength(this.buf);
            if (len < 0) {
                this.buf = Buffer.alloc(0);
                break;
            }
            if (len === 0 || this.buf.length < len) {
                break;
            }
            frames.push(this.buf.subarray(0, len));
            this.buf = this.buf.subarray(len);
        }
        return frames;
    }

    reset(): void {
        this.buf = Buffer.alloc(0);
    }
}

const EXC_FUNCTION = 1;
const EXC_ADDRESS = 2;
const EXC_VALUE = 3;

export interface Outcome {
    reply?: Buffer;
    wrote?: boolean; // a register changed
    note: string; // one line for the device's log
}

const FN_NAMES: Record<number, string> = { 1: 'read coils', 2: 'read discrete inputs', 3: 'read holding registers', 4: 'read input registers', 5: 'write coil', 6: 'write register', 15: 'write coils', 16: 'write registers' };

// Handles one request frame. Frames for another unit, with a bad CRC or broadcasts get no reply.
export function handleRequest(frame: Buffer, unit: number, regs: Register[]): Outcome {
    if (frame.length < 4 || crc16(frame.subarray(0, frame.length - 2)) !== frame.readUInt16LE(frame.length - 2)) {
        return { note: 'bad CRC' };
    }
    const addr = frame[0];
    const fn = frame[1];
    if (addr !== unit && addr !== 0) {
        return { note: `for unit ${addr}` };
    }
    const quiet = addr === 0;
    const name = FN_NAMES[fn] || `function ${fn}`;
    const fail = (code: number, why: string): Outcome => ({
        reply: quiet ? undefined : withCrc(Buffer.from([unit, fn | 0x80, code])),
        note: `${name}: exception ${code} (${why})`,
    });
    const find = (type: RegisterType, address: number) => regs.find((r) => r.type === type && r.address === address);
    const start = frame.readUInt16BE(2);

    switch (fn) {
    case 1:
    case 2: {
        const qty = frame.readUInt16BE(4);
        const type: RegisterType = fn === 1 ? 'coil' : 'discrete';
        if (qty < 1 || qty > 2000) {
            return fail(EXC_VALUE, `quantity ${qty}`);
        }
        const bytes = Buffer.alloc(Math.ceil(qty / 8));
        for (let i = 0; i < qty; i++) {
            const r = find(type, start + i);
            if (!r) {
                return fail(EXC_ADDRESS, `${start + i}`);
            }
            if (r.value) {
                bytes[i >> 3] |= 1 << (i & 7);
            }
        }
        return { reply: quiet ? undefined : withCrc(Buffer.concat([Buffer.from([unit, fn, bytes.length]), bytes])), note: `${name} ${start}+${qty}` };
    }
    case 3:
    case 4: {
        const qty = frame.readUInt16BE(4);
        const type: RegisterType = fn === 3 ? 'holding' : 'input';
        if (qty < 1 || qty > 125) {
            return fail(EXC_VALUE, `quantity ${qty}`);
        }
        const bytes = Buffer.alloc(qty * 2);
        for (let i = 0; i < qty; i++) {
            const r = find(type, start + i);
            if (!r) {
                return fail(EXC_ADDRESS, `${start + i}`);
            }
            bytes.writeUInt16BE(r.value & 0xffff, i * 2);
        }
        return { reply: quiet ? undefined : withCrc(Buffer.concat([Buffer.from([unit, fn, bytes.length]), bytes])), note: `${name} ${start}+${qty}` };
    }
    case 5: {
        const raw = frame.readUInt16BE(4);
        const r = find('coil', start);
        if (raw !== 0xff00 && raw !== 0) {
            return fail(EXC_VALUE, `value ${raw}`);
        }
        if (!r) {
            return fail(EXC_ADDRESS, `${start}`);
        }
        r.value = raw ? 1 : 0;
        return { reply: quiet ? undefined : Buffer.from(frame), wrote: true, note: `${name} ${start} = ${r.value}` };
    }
    case 6: {
        const r = find('holding', start);
        if (!r) {
            return fail(EXC_ADDRESS, `${start}`);
        }
        r.value = frame.readUInt16BE(4);
        return { reply: quiet ? undefined : Buffer.from(frame), wrote: true, note: `${name} ${start} = ${r.value}` };
    }
    case 15:
    case 16: {
        const qty = frame.readUInt16BE(4);
        const count = frame[6];
        const coil = fn === 15;
        const max = coil ? 1968 : 123;
        if (qty < 1 || qty > max || count !== (coil ? Math.ceil(qty / 8) : qty * 2)) {
            return fail(EXC_VALUE, `quantity ${qty}`);
        }
        const targets: Register[] = [];
        for (let i = 0; i < qty; i++) {
            const r = find(coil ? 'coil' : 'holding', start + i);
            if (!r) {
                return fail(EXC_ADDRESS, `${start + i}`);
            }
            targets.push(r);
        }
        targets.forEach((r, i) => {
            r.value = coil ? (frame[7 + (i >> 3)] >> (i & 7)) & 1 : frame.readUInt16BE(7 + i * 2);
        });
        return { reply: quiet ? undefined : withCrc(frame.subarray(0, 6)), wrote: true, note: `${name} ${start}+${qty}` };
    }
    default:
        return fail(EXC_FUNCTION, `function ${fn}`);
    }
}

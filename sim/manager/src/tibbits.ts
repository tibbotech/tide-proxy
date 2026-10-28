import SOCKETS from './data/sockets.json';
import TIBBITS from './data/tibbits.json';

import { Board } from './firmware';

// Tibbits on a TPP board. The data files come from Cody (see tools/gen-tibbit-data.js).
//
// A TPP has pairs of sockets: odd ones take a function Tibbit (RS485, Wiegand, ...) and own the four
// lines of the MCU behind them; the even one after it takes a connector Tibbit that brings those lines
// out. The terminal blocks (#21: four, #20: nine, 1-4 and 6-9 serving the sockets either side, 5 the
// common) are what a wire is attached to, so the sim only offers terminals where a block sits.

export interface McuPin {
    port: string; // 'A'..'K'
    pin: number;
}

export interface SocketInfo {
    socket: string;
    accept: string[];
    lines: Array<McuPin | null>;
    uart?: string;
}

export interface TibbitInfo {
    model: string;
    name: string;
    form: string;
    category: string;
    lines?: string[];
    sim?: boolean; // behaviour is simulated (wiring to it does something)
}

// What a wire carries. rs485: a/b are the differential pair; rs232: tx/rx(/rts/cts); w0/w1: Wiegand data
// lines (MCU inputs); io: a plain MCU pin.
export type Role = 'a' | 'b' | 'tx' | 'rx' | 'rts' | 'cts' | 'w0' | 'w1' | 'io' | 'vcc' | 'gnd';

// Which way an io terminal works, when only one way: 'out' (a relay, an open collector) is driven by its
// MCU pin and never by the net; 'in' (an isolated or dry contact input) drives its pin from the net,
// pulled up when nothing drives it.
export type Dir = 'in' | 'out';

interface SimLine {
    label: string;
    role: Role;
    dir?: Dir;
}

const L = (label: string, role: Role): SimLine => ({ label, role });
// Digital outputs and inputs: the terminal and the MCU pin behind it are at the same level.
const OUT = (label: string): SimLine => ({ label, role: 'io', dir: 'out' });
const IN = (label: string): SimLine => ({ label, role: 'io', dir: 'in' });
const ins = (n: number) => [1, 2, 3, 4].slice(0, n).map((i) => IN(`IN${i}`));

// Simulated Tibbits: what each of the four socket lines is, as it appears on a terminal block.
const SIM: Record<string, SimLine[]> = {
    '01': [L('TX', 'tx'), L('RX', 'rx'), L('RTS', 'rts'), L('CTS', 'cts')],
    '05': [L('485+', 'a'), L('485-', 'b'), L('VCC', 'vcc'), L('GND', 'gnd')],
    '08': [L('W0', 'w0'), L('W1', 'w1')],
    '00_1': [L('1', 'io'), L('2', 'io'), L('3', 'io'), L('4', 'io')],
    '00_2': [L('1', 'io'), L('2', 'io'), L('3', 'io'), L('GND', 'gnd')],
    '00_3': [L('1', 'io'), L('2', 'io'), L('5V', 'vcc'), L('GND', 'gnd')],
    // Relays, open collector outputs.
    '03_1': [OUT('RL1'), OUT('RL2')],
    '03_2': [OUT('RL1'), OUT('RL2')],
    '06': [OUT('RL1'), OUT('RL2')],
    '07': [OUT('RL1'), OUT('RL2')],
    '11': [OUT('OUT1'), OUT('OUT2'), OUT('OUT3'), OUT('OUT4')],
    '58': [OUT('OUT1'), OUT('OUT2')],
    '59': [OUT('OUT1'), OUT('OUT2')],
    // Isolated inputs (two, three with a common, four), dry contact inputs.
    '04_1': ins(2),
    '04_2': ins(3),
    '04_3': ins(3),
    '04_4': ins(4),
    '04_5': ins(2),
    '04_6': ins(3),
    '04_7': ins(3),
    '04_8': ins(4),
    '54': ins(4),
};

export const TERMINAL_BLOCKS = ['20', '21'];

const sockets = SOCKETS as Record<string, SocketInfo[]>;
const catalog: TibbitInfo[] = (TIBBITS as TibbitInfo[]).map((t) => ({ ...t, sim: t.model in SIM }));
const byModel = new Map(catalog.map((t) => [t.model, t]));

export const tibbitCatalog = (): TibbitInfo[] => catalog;
export const tibbitInfo = (model: string): TibbitInfo | undefined => byModel.get(model);
export const socketsOf = (board: Board): SocketInfo[] => sockets[board] || [];
export const allSockets = () => sockets;

const isFunctionSocket = (s: SocketInfo) => s.accept.some((f) => f.startsWith('M') || f.startsWith('H'));
// Wide Tibbits (two sockets) also take the next socket of their kind: function sockets 1 and 3, connector sockets 2 and 4.
const isWide = (form: string) => form === 'M2S' || form === 'M2T' || form === 'H2' || form === 'C2';

// Socket -> Tibbit model.
export type Placements = Record<string, string>;

// Checks the placements against the board: the socket exists, the Tibbit's form fits it, and a wide
// Tibbit leaves the socket it spans free. Returns the cleaned map; throws on the first problem.
export function checkPlacements(board: Board, map: Record<string, string | null | undefined>): Placements {
    const list = socketsOf(board);
    const out: Placements = {};
    for (const [socket, model] of Object.entries(map)) {
        if (!model) {
            continue;
        }
        const info = list.find((s) => s.socket === socket);
        if (!info) {
            throw new Error(`${board} has no socket ${socket}`);
        }
        const tibbit = byModel.get(model);
        if (!tibbit) {
            throw new Error(`unknown Tibbit ${model}`);
        }
        if (!info.accept.includes(tibbit.form)) {
            throw new Error(`Tibbit ${model} (${tibbit.form}) does not fit socket ${socket} (${info.accept.join('/')})`);
        }
        out[socket] = model;
    }
    for (const [socket, model] of Object.entries(out)) {
        if (isWide(byModel.get(model)!.form)) {
            const next = String(Number(socket) + 2);
            if (!list.some((s) => s.socket === next)) {
                throw new Error(`Tibbit ${model} needs the socket after ${next}, which ${board} lacks`);
            }
            if (out[next]) {
                throw new Error(`Tibbit ${model} in socket ${socket} covers socket ${next}`);
            }
        }
    }
    return out;
}

export interface Terminal {
    id: string; // 'T2.3': connector socket 2, terminal 3
    n: number; // position on the block, 1-based
    block: string; // connector socket
    label: string;
    role?: Role;
    socket?: string; // function socket the terminal belongs to
    line?: number; // 0-3 on that socket
    mcu?: McuPin; // the MCU pin behind it, when it is one
    uart?: string; // the UART of the socket, on a serial Tibbit
    dir?: Dir;
}

// The wire terminals a board offers: those of the terminal blocks in its connector sockets, labelled
// by the function Tibbit they serve.
export function terminalsOf(board: Board, placed: Placements): Terminal[] {
    const list = socketsOf(board);
    const out: Terminal[] = [];
    for (const [block, model] of Object.entries(placed)) {
        if (!TERMINAL_BLOCKS.includes(model)) {
            continue;
        }
        const first = String(Number(block) - 1);
        const second = String(Number(block) + 1);
        // [function socket, line at terminal 1, step]: #20 runs the second socket's lines backwards from terminal 9.
        const serves: Array<{ socket: string; at: (line: number) => number }> = [{ socket: first, at: (line) => line + 1 }];
        if (model === '20') {
            serves.push({ socket: second, at: (line) => 9 - line });
        }
        const terminals = new Map<number, Terminal>();
        for (const serve of serves) {
            const info = list.find((s) => s.socket === serve.socket);
            const sim = SIM[placed[serve.socket]];
            if (!info) {
                continue;
            }
            for (let line = 0; line < 4; line++) {
                const n = serve.at(line);
                const def = sim && sim[line];
                const t: Terminal = { id: `T${block}.${n}`, n, block, label: def ? def.label : '', role: def?.role, socket: serve.socket, line };
                if (def?.dir) {
                    t.dir = def.dir;
                }
                if (def && def.role !== 'vcc' && def.role !== 'gnd') {
                    t.mcu = info.lines[line] || undefined;
                    if (info.uart && (def.role === 'a' || def.role === 'b' || def.role === 'tx' || def.role === 'rx')) {
                        t.uart = info.uart;
                    }
                }
                terminals.set(n, t);
            }
        }
        if (model === '20') {
            terminals.set(5, { id: `T${block}.5`, n: 5, block, label: 'GND', role: 'gnd' });
        }
        const count = model === '20' ? 9 : 4;
        for (let n = 1; n <= count; n++) {
            out.push(terminals.get(n) || { id: `T${block}.${n}`, n, block, label: '' });
        }
    }
    return out;
}

export { isFunctionSocket };

// Placements from a Cody project (its features list names each Tibbit's socket). Only Tibbits the board
// takes are kept; the rest are reported.
export function placementsFromProject(board: Board, project: any): { placements: Placements; skipped: string[] } {
    const features: any[] = Array.isArray(project?.features) ? project.features : [];
    const wanted: Record<string, string> = {};
    const skipped: string[] = [];
    for (const f of features) {
        const id = String(f?.id || '');
        if (!id.startsWith('tibbit_') || !f.settings?.SOCKET) {
            continue;
        }
        const model = String(f.settings.TIBBIT || id.slice('tibbit_'.length));
        wanted[String(f.settings.SOCKET)] = model;
    }
    const placements: Placements = {};
    for (const [socket, model] of Object.entries(wanted)) {
        try {
            Object.assign(placements, checkPlacements(board, { ...placements, [socket]: model }));
        } catch (e: any) {
            skipped.push(`socket ${socket}: ${e.message}`);
        }
    }
    return { placements, skipped };
}

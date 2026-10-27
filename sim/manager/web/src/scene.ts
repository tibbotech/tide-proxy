import { artFor, artForBoard } from './art';
import { persisted } from './local';
import type { FieldDevice, Instance, Link, Role, Terminal } from './types';

// The workspace model. Devices sit on DIN rails; each has a faceplate and, below it, a strip of pin
// terminals (UARTs and GPIOs) that wires attach to. Everything is laid out in world pixels from
// here, so wires and hit-testing never measure the DOM.

export const FACE_H = 240;
export const HEAD_H = 40; // nameplate above the faceplate
export const PAD_W = 60;
export const PAD_H = 58;
export const PADS_TOP = HEAD_H + FACE_H + 10;
// Terminal blocks are plugged into the bottom edge of the case, tucked TERM_TUCK px into the faceplate.
// The wire leaves the bottom edge of a terminal.
export const TERM_TUCK = 8;
export const TERMS_TOP = HEAD_H + FACE_H - TERM_TUCK;
export const TERM_W = 26; // one terminal of a #21 (a socket is four of them wide)
export const SOCKET_W = 4 * TERM_W;
export const TERM_BLOCK_H = 50;
export const TERM_HEAD_H = 0;
export const TERM_ROW = 60;
export const BLOCK_GAP = 8;
export const TERM_MARGIN = 6;
export const FIELD_W = 250;
export const FIELD_BODY_H = 150;
export const DEVICE_GAP = 20;
export const RAIL_TOP = 60;
export const RAIL_GAP = 130;
export const RAIL_BAND = 38;
export const BOARD_MIME = 'application/x-tpp-board'; // a catalog card being dragged onto a rail
export const FIELD_MIME = 'application/x-field-device'; // a field device from the catalog
const WRAP_X = 1500; // new devices start another rail beyond this

// ---- layout (persisted per viewer) ----
export interface Layout {
    rails: string[];
    place: Record<string, { rail: string; x: number }>;
}

export const layoutStore = persisted<Layout>('sim.rails.layout', { rails: ['r1'], place: {} });
export const extraPinsStore = persisted<Record<string, string[]>>('sim.wiring.pins', {});

export const snap = (v: number) => Math.max(0, Math.round(v / 10) * 10);

// The nearest free x on a rail to `desired` for a device of width `w`.
export function freeX(others: { x: number; w: number }[], desired: number, w: number): number {
    const fits = (x: number) => others.every((o) => x + w + DEVICE_GAP <= o.x || x >= o.x + o.w + DEVICE_GAP);
    const d = snap(desired);
    if (fits(d)) return d;
    const cands = [0];
    for (const o of others) cands.push(o.x + o.w + DEVICE_GAP, Math.max(0, o.x - w - DEVICE_GAP));
    const ok = cands.filter(fits);
    if (!ok.length) return Math.max(0, ...others.map((o) => o.x + o.w + DEVICE_GAP));
    return ok.reduce((best, x) => (Math.abs(x - desired) < Math.abs(best - desired) ? x : best));
}

export type Placeable = Instance | FieldDevice;
export const isField = (p: Placeable): p is FieldDevice => !('board' in p);

export const deviceWidth = (inst: Instance) => {
    const art = artFor(inst);
    return Math.round((FACE_H * art.w) / art.h);
};

export const widthOf = (p: Placeable) => (isField(p) ? FIELD_W : deviceWidth(p));

export const deviceWidthForBoard = (board: string) => {
    const art = artForBoard(board);
    return Math.round((FACE_H * art.w) / art.h);
};

function onRail(layout: Layout, instances: Placeable[], rail: string, except?: string) {
    return instances
        .filter((i) => i.id !== except && layout.place[i.id] && layout.place[i.id].rail === rail)
        .map((i) => ({ x: layout.place[i.id].x, w: widthOf(i) }));
}

// Puts devices without a place at the end of the first rail with room, and forgets devices that are gone.
export function ensurePlacements(instances: Placeable[]) {
    const layout = layoutStore.get();
    const ids = new Set(instances.map((i) => i.id));
    let next: Layout | null = null;
    const draft = () => next || (next = { rails: [...layout.rails], place: { ...layout.place } });
    if (instances.length) {
        for (const id of Object.keys(layout.place)) if (!ids.has(id)) delete draft().place[id];
    }
    for (const inst of instances) {
        const cur = next || layout;
        if (cur.place[inst.id]) continue;
        const w = widthOf(inst);
        let target: { rail: string; x: number } | null = null;
        for (const rail of cur.rails) {
            const end = Math.max(-DEVICE_GAP, ...onRail(cur, instances, rail, inst.id).map((o) => o.x + o.w)) + DEVICE_GAP;
            if (end + w <= WRAP_X) {
                target = { rail, x: end };
                break;
            }
        }
        if (!target) {
            const rail = newRailId(cur.rails);
            draft().rails.push(rail);
            target = { rail, x: 0 };
        }
        draft().place[inst.id] = target;
    }
    if (next) layoutStore.set(next);
}

const newRailId = (rails: string[]) => {
    let n = rails.length + 1;
    while (rails.includes(`r${n}`)) n++;
    return `r${n}`;
};

export function addRail() {
    const l = layoutStore.get();
    layoutStore.set({ ...l, rails: [...l.rails, newRailId(l.rails)] });
}

export function removeRail(rail: string) {
    const l = layoutStore.get();
    if (l.rails.length < 2 || Object.values(l.place).some((p) => p.rail === rail)) return;
    layoutStore.set({ ...l, rails: l.rails.filter((r) => r !== rail) });
}

export function moveDevice(id: string, rail: string, x: number) {
    const l = layoutStore.get();
    layoutStore.set({ ...l, place: { ...l.place, [id]: { rail, x } } });
}

export const railXFor = (instances: Placeable[], rail: string, desired: number, w: number, except?: string) =>
    freeX(onRail(layoutStore.get(), instances, rail, except), desired, w);

// A device dropped at its x on a rail pushes its neighbours aside: those left of its centre keep to its
// left, the others to its right. Returns every device's x on that rail.
export function resolveRail(items: { id: string; x: number; w: number }[], fixedId: string): Map<string, number> {
    const fixed = items.find((i) => i.id === fixedId)!;
    const others = items.filter((i) => i.id !== fixedId).sort((a, b) => a.x - b.x);
    const centre = fixed.x + fixed.w / 2;
    const left = others.filter((o) => o.x + o.w / 2 < centre);
    const right = others.filter((o) => o.x + o.w / 2 >= centre);
    const out = new Map<string, number>();
    // The devices on its left need room before it, from x = 0.
    const need = left.reduce((n, o) => n + o.w + DEVICE_GAP, 0);
    const fx = Math.max(fixed.x, need);
    out.set(fixedId, fx);
    let limit = fx - DEVICE_GAP;
    for (const o of [...left].reverse()) {
        const x = Math.min(o.x, limit - o.w);
        out.set(o.id, x);
        limit = x - DEVICE_GAP;
    }
    limit = fx + fixed.w + DEVICE_GAP;
    for (const o of right) {
        const x = Math.max(o.x, limit);
        out.set(o.id, x);
        limit = x + o.w + DEVICE_GAP;
    }
    return out;
}

function railItems(layout: Layout, instances: Placeable[], rail: string, id: string, x: number) {
    const items = onRailWithIds(layout, instances, rail, id);
    const me = instances.find((i) => i.id === id);
    if (me) items.push({ id, x, w: widthOf(me) });
    return items;
}

const onRailWithIds = (layout: Layout, instances: Placeable[], rail: string, except: string) =>
    instances
        .filter((i) => i.id !== except && layout.place[i.id] && layout.place[i.id].rail === rail)
        .map((i) => ({ id: i.id, x: layout.place[i.id].x, w: widthOf(i) }));

// Drops a device on a rail, shifting the ones it overlaps.
export function commitMove(instances: Placeable[], id: string, rail: string, x: number) {
    const l = layoutStore.get();
    const pos = resolveRail(railItems(l, instances, rail, id, x), id);
    const place = { ...l.place };
    for (const [pid, px] of pos) place[pid] = { rail, x: px };
    place[id] = { rail, x: pos.get(id)! };
    layoutStore.set({ ...l, place });
}

// ---- pads ----
export interface Pad {
    key: string; // 'uart:usart3' / 'gpio:PB10'
    kind: 'uart' | 'gpio';
    port: string;
    label: string;
    extra?: boolean; // added by hand
    missing?: boolean; // a UART wired earlier that the firmware no longer enables
}

export const PIN_RE = /^P([A-I])(\d{1,2})$/;
const pinOrder = (p: string) => {
    const m = PIN_RE.exec(p);
    return m ? m[1].charCodeAt(0) * 100 + Number(m[2]) : 0;
};

// Ports a device offers: its DTS UARTs, DTS-named pins (buttons, LEDs), pins added by hand and
// anything already wired (so a wire stays visible after a firmware switch).
export function padsOf(inst: Instance, extra: string[], links: Link[]): Pad[] {
    const profile = inst.profile || { buttons: [], leds: [], uarts: [], consoleUart: undefined };
    const uarts: Pad[] = (inst.consoles || [])
        .filter((c) => c !== 'udp')
        .map((u) => ({ key: `uart:${u}`, kind: 'uart', port: u, label: u === profile.consoleUart ? 'console' : '' }));
    const pins = new Map<string, { label: string; extra?: boolean }>();
    for (const b of profile.buttons || []) pins.set(`P${b.port}${b.pin}`, { label: b.id === 'mdbutton' ? 'MD button' : b.label.replace(/ button$/i, '') });
    for (const l of profile.leds || []) pins.set(`P${l.port}${l.pin}`, { label: l.label.replace(/ led$/i, '') });
    for (const p of extra) if (!pins.has(p)) pins.set(p, { label: '', extra: true });
    for (const link of links) {
        for (const e of link.endpoints) {
            if (e.instance !== inst.id) continue;
            if (link.kind === 'gpio' && !pins.has(e.port)) pins.set(e.port, { label: '' });
            if (link.kind === 'uart' && !uarts.some((u) => u.port === e.port)) {
                uarts.push({ key: `uart:${e.port}`, kind: 'uart', port: e.port, label: 'not in DTS', missing: true });
            }
        }
    }
    const gpio: Pad[] = [...pins.entries()]
        .sort((a, b) => pinOrder(a[0]) - pinOrder(b[0]))
        .map(([port, p]) => ({ key: `gpio:${port}`, kind: 'gpio', port, label: p.label, extra: p.extra }));
    return [...uarts, ...gpio];
}

export interface PlacedPad extends Pad {
    x: number; // terminal centre, relative to the device's top-left
    y: number;
}

// A wire terminal on a terminal block. (x, y) is where its wire leaves, relative to the device's top-left.
export interface PlacedTerm {
    owner: string;
    id: string;
    n: number;
    label: string;
    role?: Role;
    x: number;
    y: number;
    wirable: boolean;
}

export interface PlacedBlock {
    id: string;
    caption: string;
    x: number; // top-left, relative to the device
    y: number;
    w: number;
    termW: number; // width of one terminal
    terms: PlacedTerm[];
}

export interface DeviceGeom {
    faceW: number;
    w: number;
    h: number;
    pads: PlacedPad[];
    blocks: PlacedBlock[];
    padsTop: number;
    add: { x: number; y: number }; // the "+ pin" cell
}

const geomCache = new Map<string, DeviceGeom>();

interface BlockInput {
    id: string;
    caption: string;
    terms: Array<{ id: string; n: number; label: string; role?: Role; wirable: boolean }>;
}

// Terminal blocks flow left to right in rows no wider than the faceplate. Returns the blocks and the rows used.
function layoutBlocks(owner: string, inputs: BlockInput[], width: number, top: number): { blocks: PlacedBlock[]; rows: number } {
    const blocks: PlacedBlock[] = [];
    let x = TERM_MARGIN;
    let row = 0;
    for (const b of inputs) {
        // A block is as wide as the sockets it spans: one for the four terminals of a #21, two (and the gap
        // between them) for the nine of a #20, whose terminals are thinner.
        const w = b.terms.length > 4 ? 2 * SOCKET_W + BLOCK_GAP : b.terms.length * TERM_W;
        const tw = w / b.terms.length;
        if (x > TERM_MARGIN && x + w > width - TERM_MARGIN) {
            x = TERM_MARGIN;
            row++;
        }
        const y = top + row * TERM_ROW;
        blocks.push({
            id: b.id,
            caption: b.caption,
            x,
            y,
            w,
            termW: tw,
            terms: b.terms.map((t, i) => ({ owner, ...t, x: x + i * tw + tw / 2, y: y + TERM_HEAD_H + TERM_BLOCK_H })),
        });
        x += w + BLOCK_GAP;
    }
    return { blocks, rows: inputs.length ? row + 1 : 0 };
}

function blockInputs(inst: Instance): BlockInput[] {
    const groups = new Map<string, Terminal[]>();
    for (const t of inst.terminals || []) {
        const list = groups.get(t.block) || [];
        list.push(t);
        groups.set(t.block, list);
    }
    return [...groups.entries()].map(([block, terms]) => {
        const served = [...new Set(terms.map((t) => t.socket).filter(Boolean))] as string[];
        const caption = served.map((s) => `S${s}${inst.tibbits[s] ? ` · #${inst.tibbits[s]}` : ''}`).join('  ') || `S${block}`;
        return { id: block, caption, terms: terms.map((t) => ({ id: t.id, n: t.n, label: t.label, role: t.role, wirable: !!t.role })) };
    });
}

// Same pads, terminals and width give the same object, so memoised devices don't re-render on a drag.
export function geometryOf(inst: Instance, pads: Pad[]): DeviceGeom {
    const faceW = deviceWidth(inst);
    const inputs = blockInputs(inst);
    const key = `${inst.id}|${faceW}|${JSON.stringify(inputs)}|${pads.map((p) => `${p.key}:${p.label}:${p.extra ? 1 : 0}${p.missing ? 'm' : ''}`).join(',')}`;
    const hit = geomCache.get(key);
    if (hit) return hit;
    const { blocks, rows: termRows } = layoutBlocks(inst.id, inputs, faceW, TERMS_TOP);
    const padsTop = termRows ? TERMS_TOP + termRows * TERM_ROW + 6 : PADS_TOP;
    const cols = Math.max(1, Math.floor(faceW / PAD_W));
    const left = (faceW - cols * PAD_W) / 2;
    const cell = (i: number) => ({ x: left + (i % cols) * PAD_W + PAD_W / 2, y: padsTop + Math.floor(i / cols) * PAD_H + 12 });
    const placed = pads.map((p, i) => ({ ...p, ...cell(i) }));
    const rows = Math.ceil((pads.length + 1) / cols);
    const geom = { faceW, w: faceW, h: padsTop + rows * PAD_H + 6, pads: placed, blocks, padsTop, add: cell(pads.length) };
    geomCache.set(key, geom);
    return geom;
}

export function fieldGeometry(dev: FieldDevice): DeviceGeom {
    const key = `field|${dev.id}|${dev.terminals.map((t) => t.id + t.label).join(',')}`;
    const hit = geomCache.get(key);
    if (hit) return hit;
    const top = HEAD_H + FIELD_BODY_H - TERM_TUCK;
    const input: BlockInput = { id: 'F', caption: dev.title, terms: dev.terminals.map((t, i) => ({ id: t.id, n: i + 1, label: t.label, role: t.role, wirable: true })) };
    const { blocks } = layoutBlocks(dev.id, [input], FIELD_W, top);
    // Centre the block.
    const shift = (FIELD_W - blocks[0].w) / 2 - blocks[0].x;
    blocks[0].x += shift;
    blocks[0].terms.forEach((t) => (t.x += shift));
    const geom = { faceW: FIELD_W, w: FIELD_W, h: top + TERM_ROW, pads: [], blocks, padsTop: top + TERM_ROW, add: { x: 0, y: 0 } };
    geomCache.set(key, geom);
    return geom;
}

// ---- scene ----
export interface PlacedDevice {
    id: string;
    inst?: Instance;
    field?: FieldDevice;
    geom: DeviceGeom;
    rail: string;
    x: number;
    y: number;
}

export interface RailInfo {
    id: string;
    index: number;
    top: number;
    h: number;
    x1: number;
    count: number;
}

export interface Scene {
    devices: PlacedDevice[];
    byId: Map<string, PlacedDevice>;
    rails: RailInfo[];
    bounds: { x: number; y: number; w: number; h: number };
}

export interface DragPreview {
    id: string;
    rail: string;
    x: number;
}

export const railBandY = (rail: RailInfo) => rail.top + HEAD_H + FACE_H / 2 - RAIL_BAND / 2;

export function buildScene(layout: Layout, instances: Placeable[], extra: Record<string, string[]>, links: Link[], drag: DragPreview | null): Scene {
    const geoms = new Map<string, DeviceGeom>();
    for (const inst of instances) geoms.set(inst.id, isField(inst) ? fieldGeometry(inst) : geometryOf(inst, padsOf(inst, extra[inst.id] || [], links)));
    // While a device is dragged, its new rail shows the neighbours pushed aside.
    const pushed = drag ? resolveRail(railItems(layout, instances, drag.rail, drag.id, drag.x), drag.id) : null;
    const where = (id: string) => (pushed && pushed.has(id) ? { rail: drag!.rail, x: pushed.get(id)! } : layout.place[id]);

    let top = RAIL_TOP;
    const rails: RailInfo[] = [];
    const devices: PlacedDevice[] = [];
    layout.rails.forEach((id, index) => {
        const here = instances.filter((i) => where(i.id) && where(i.id)!.rail === id);
        const h = Math.max(HEAD_H + FACE_H + 130, ...here.map((i) => geoms.get(i.id)!.h));
        const right = Math.max(0, ...here.map((i) => where(i.id)!.x + geoms.get(i.id)!.w));
        rails.push({ id, index, top, h, x1: Math.max(1100, right + 260), count: here.length });
        for (const inst of here) devices.push({ id: inst.id, inst: isField(inst) ? undefined : inst, field: isField(inst) ? inst : undefined, geom: geoms.get(inst.id)!, rail: id, x: where(inst.id)!.x, y: top });
        top += h + RAIL_GAP;
    });
    const maxX = Math.max(...rails.map((r) => r.x1));
    return {
        devices,
        byId: new Map(devices.map((d) => [d.id, d])),
        rails,
        bounds: { x: -80, y: 0, w: maxX + 160, h: top },
    };
}

// World position of a pad's terminal.
export function padPoint(scene: Scene, instance: string, port: string, kind: 'uart' | 'gpio'): { x: number; y: number } | null {
    const dev = scene.byId.get(instance);
    const pad = dev && dev.geom.pads.find((p) => p.kind === kind && p.port === port);
    return dev && pad ? { x: dev.x + pad.x, y: dev.y + pad.y } : null;
}

// World position where the wire of a terminal leaves.
export function termPoint(scene: Scene, owner: string, term: string): { x: number; y: number } | null {
    const dev = scene.byId.get(owner);
    if (!dev) return null;
    for (const b of dev.geom.blocks) {
        const t = b.terms.find((x) => x.id === term);
        if (t) return { x: dev.x + t.x, y: dev.y + t.y };
    }
    return null;
}

import tps2 from './assets/boards/tps2.svg?raw';
import tps2l from './assets/boards/tps2l.svg?raw';
import tps3 from './assets/boards/tps3.svg?raw';
import type { Instance } from './types';

// Faceplates (assets/boards/*.svg) with data-part hooks: lcd, key-0..3, md, link-led,
// blue-led-0..4, red-led, green-led.

export type ArtName = 'tps2' | 'tps2l' | 'tps3';

export interface Art {
    name: ArtName;
    raw: string;
    w: number;
    h: number;
    // The screen window, in art units, if the art has one.
    lcd?: { x: number; y: number; w: number; h: number };
    slots: Slots;
}

// Where the connector sockets sit on the faceplate, as numbered on the art: equal slots from x0, left to
// right, along the bottom and the top edge (null is a slot without a socket). A terminal block plugs into
// its socket's edge; the top row is mounted the other way round.
export interface Slots {
    x0: number;
    pitch: number;
    bottom: Array<string | null>;
    top: Array<string | null>;
}

const TPS2_SLOTS: Slots = { x0: 56, pitch: 74, bottom: ['2', '4', '6', '8'], top: [null, '13', '12', '10'] };
const TPS3_SLOTS: Slots = {
    x0: 56,
    pitch: 66,
    bottom: ['2', '4', '6', '8', '10', '12', '14', '16'],
    top: [null, '29', '28', '26', '24', '22', '20', '18'],
};

function parse(name: ArtName, raw: string, slots: Slots): Art {
    const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
    const [, , w, h] = (doc.documentElement.getAttribute('viewBox') || '0 0 400 400').split(/\s+/).map(Number);
    const lcd = doc.querySelector('[data-part="lcd"]');
    // The screen rect sits inside translated groups; the overlay is placed in the art's own units.
    let dx = 0;
    let dy = 0;
    for (let n = lcd && lcd.parentElement; n && n !== doc.documentElement; n = n.parentElement) {
        const m = /translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)/.exec(n.getAttribute('transform') || '');
        if (m) {
            dx += Number(m[1]);
            dy += Number(m[2]);
        }
    }
    return {
        name,
        raw,
        w,
        h,
        lcd: lcd
            ? { x: dx + Number(lcd.getAttribute('x')), y: dy + Number(lcd.getAttribute('y')), w: Number(lcd.getAttribute('width')), h: Number(lcd.getAttribute('height')) }
            : undefined,
        slots,
    };
}

const ART: Record<ArtName, Art> = {
    tps2: parse('tps2', tps2, TPS2_SLOTS),
    tps2l: parse('tps2l', tps2l, TPS2_SLOTS), // same case, the screen is in the lid
    tps3: parse('tps3', tps3, TPS3_SLOTS),
};

export function artFor(inst: Instance): Art {
    const profile = inst.profile;
    if (/^tpp3/i.test(inst.board || (profile && profile.board) || '')) return ART.tps3;
    return profile && profile.lcd ? ART.tps2l : ART.tps2;
}

export function ledColor(led: { id: string; label: string }): 'green' | 'red' | 'other' {
    const l = `${led.label} ${led.id}`.toLowerCase();
    return l.includes('green') ? 'green' : l.includes('red') ? 'red' : 'other';
}

export function artForBoard(board: string, lcd = false): Art {
    if (/^tpp3/i.test(board)) return ART.tps3;
    return lcd ? ART.tps2l : ART.tps2;
}

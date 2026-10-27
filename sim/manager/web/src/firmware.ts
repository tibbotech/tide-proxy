import { fileToBase64 } from './api';
import type { Generation, MonitorInfo } from './types';

// Files picked for an instance: .elf (the app), .dts (its devicetree), .bin (written into flash).

export const FLASH_START = 0x08000000;

// Well-known places for a .bin in each generation's flash.
export const FLASH_ADDRESSES: Record<Generation, Array<[number, string]>> = {
    g2: [[FLASH_START, 'monitor'], [0x08008000, 'app image with TiOS header'], [0x08008200, 'app']],
    g3: [[FLASH_START, 'monitor'], [0x08040000, 'app image with TiOS header'], [0x08040200, 'app']],
};

export interface Picked {
    elf?: File;
    dts?: File;
    bin?: File;
}

// Files by type; throws a readable message for an unknown extension or a duplicate.
export function pickedFiles(files: File[]): Picked {
    const out: Picked = {};
    for (const file of files) {
        const ext = (file.name.match(/\.(elf|dts|bin)$/i) || [])[1];
        if (!ext) throw new Error(`${file.name}: pick .elf, .dts or .bin files`);
        const key = ext.toLowerCase() as keyof Picked;
        if (out[key]) throw new Error(`more than one .${key} picked`);
        out[key] = file;
    }
    return out;
}

export function parseHex(v: string): number {
    const t = String(v).trim().replace(/^0x/i, '');
    return /^[0-9a-f]{1,8}$/i.test(t) ? parseInt(t, 16) : NaN;
}

export const hexAddr = (n: number) => '0x' + n.toString(16).padStart(8, '0');

// What each picked file becomes.
export function describeFiles(files: File[], binAddress: string, gen: Generation): string {
    let p: Picked;
    try {
        p = pickedFiles(files);
    } catch (e: any) {
        return e.message;
    }
    const known = FLASH_ADDRESSES[gen];
    const addr = parseHex(binAddress);
    const what = known.find(([a]) => a === addr);
    const place = Number.isNaN(addr) ? 'nowhere: the address is not hex' : `flash @ ${hexAddr(addr)}${what ? ` (${what[1]})` : ''}`;
    return [p.elf && `${p.elf.name} → app`, p.dts && `${p.dts.name} → devicetree`, p.bin && `${p.bin.name} → ${place}`].filter(Boolean).join(' · ');
}

// What a new instance boots: the picked ELF, a monitor's Loader (picked .bin or the default), or nothing yet.
export function bootHint(files: File[], binAddress: string, gen: Generation, monitors: Partial<Record<Generation, MonitorInfo>>) {
    let picked: Picked = {};
    try {
        picked = pickedFiles(files);
    } catch {
        // describeFiles reports it.
    }
    const monBin = picked.bin && parseHex(binAddress) === FLASH_START;
    const mon = monBin ? picked.bin!.name : monitors[gen] ? `the ${gen.toUpperCase()} default monitor` : null;
    if (picked.elf) return { text: mon ? `Boots through ${mon} into this app.` : 'Boots this app (no monitor: boot stub).', start: true };
    if (mon) return { text: `No app: boots into the Loader of ${mon}, ready for an upload from TIDE. You can also upload a .elf later.`, start: true };
    if (picked.bin) return { text: 'Boots what the .bin puts into flash (an app at the app base runs through the boot stub).', start: true };
    return { text: 'No app and no monitor: the instance is created stopped. Upload a .elf or a .bin to it to start it.', start: false };
}

// The request fields for the picked files: { elf, elfName, dts, bin, binName, binAddress } (absent ones left out).
export async function firmwareFields(files: File[], binAddress: string) {
    const p = pickedFiles(files);
    return {
        elf: p.elf && (await fileToBase64(p.elf)),
        elfName: p.elf && p.elf.name,
        dts: p.dts && (await p.dts.text()),
        bin: p.bin && (await fileToBase64(p.bin)),
        binName: p.bin && p.bin.name,
        binAddress: p.bin ? binAddress : undefined,
    };
}

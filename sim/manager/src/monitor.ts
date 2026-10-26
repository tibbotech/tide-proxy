import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { monitorsDir } from './config';
import { flashSegments } from './elf';
import { APP_BASE, FLASH_SIZE, FirmwareInfo, Generation } from './firmware';

// Tibbo Monitor/Loader images, one per generation. With one installed, instances boot through it
// from a persistent internal-flash image, so QF/D/N uploads over UDP replace the app as on a board.

const FLASH_START = 0x08000000;
// The monitor keeps the (decrypted) uploaded image from APP_BASE - 0x200: a 3-byte size, padding,
// the app at +0x200 and a 2-byte checksum. Layout as built by convert_to_tios.js, minus the encryption.
const HEADER_SIZE = 0x200;
const BLOCK_SIZE = 128;

export interface MonitorInfo {
    generation: Generation;
    name: string;
    size: number;
    sha256: string;
    uploadedAt: string;
}

interface FlashState {
    monitorSha: string;
    firmwareId: string;
}

function binPath(gen: Generation): string {
    return path.join(monitorsDir(), `${gen}.bin`);
}

function metaPath(gen: Generation): string {
    return path.join(monitorsDir(), `${gen}.json`);
}

function headerOffset(gen: Generation): number {
    return APP_BASE[gen] - HEADER_SIZE - FLASH_START;
}

export function getMonitor(gen: Generation): MonitorInfo | undefined {
    if (!fs.existsSync(metaPath(gen)) || !fs.existsSync(binPath(gen))) {
        return undefined;
    }
    return JSON.parse(fs.readFileSync(metaPath(gen), 'utf8')) as MonitorInfo;
}

export function listMonitors(): Record<Generation, MonitorInfo | null> {
    return { g2: getMonitor('g2') || null, g3: getMonitor('g3') || null };
}

export function setMonitor(gen: Generation, name: string, bin: Buffer): MonitorInfo {
    const limit = headerOffset(gen);
    if (bin.length < 8 || bin.length > limit) {
        throw new Error(`monitor image must be 8..${limit} bytes, got ${bin.length}`);
    }
    // A plain image starts with its vector table; encrypted update files (*_ENC.bin) don't.
    const reset = bin.readUInt32LE(4);
    if (!(reset & 1) || reset < FLASH_START || reset >= FLASH_START + bin.length) {
        throw new Error(`not a plain monitor image: reset vector 0x${reset.toString(16)} is outside it (encrypted files can't run)`);
    }
    fs.mkdirSync(monitorsDir(), { recursive: true });
    fs.writeFileSync(binPath(gen), bin);
    const info: MonitorInfo = {
        generation: gen,
        name: name || `${gen}.bin`,
        size: bin.length,
        sha256: crypto.createHash('sha256').update(bin).digest('hex'),
        uploadedAt: new Date().toISOString(),
    };
    fs.writeFileSync(metaPath(gen), JSON.stringify(info, null, 2));
    return info;
}

export function deleteMonitor(gen: Generation): boolean {
    if (!getMonitor(gen)) {
        return false;
    }
    fs.rmSync(binPath(gen), { force: true });
    fs.rmSync(metaPath(gen), { force: true });
    return true;
}

// The ELF's flash segments as one flat binary from APP_BASE (gaps zero-filled, like objcopy -O binary).
function appBinary(fw: FirmwareInfo): Buffer {
    const segs = flashSegments(fs.readFileSync(fw.elfPath));
    const base = APP_BASE[fw.generation];
    if (segs[0].paddr !== base) {
        throw new Error(`firmware is linked at 0x${segs[0].paddr.toString(16)}, the monitor starts apps at 0x${base.toString(16)}`);
    }
    const end = Math.max(...segs.map((s) => s.paddr + s.data.length));
    const app = Buffer.alloc(end - base);
    for (const s of segs) {
        s.data.copy(app, s.paddr - base);
    }
    return app;
}

function tiosImage(app: Buffer): Buffer {
    const total = Math.ceil((HEADER_SIZE + app.length + 2) / BLOCK_SIZE) * BLOCK_SIZE;
    const img = Buffer.alloc(total);
    img[0] = (total >> 16) & 0xff;
    img[1] = (total >> 8) & 0xff;
    img[2] = total & 0xff;
    app.copy(img, HEADER_SIZE);
    // Big-endian 16-bit words over the whole image sum to 0xFFFF.
    let sum = 0;
    for (let i = 0; i < total - 2; i++) {
        sum += i % 2 === 0 ? img[i] << 8 : img[i];
    }
    const need = (0xffff - sum) & 0xffff;
    img[total - 2] = need >> 8;
    img[total - 1] = need & 0xff;
    return img;
}

// Brings an instance's flash.bin up to date and returns its path. The monitor is rewritten when it
// changed, the app when the instance's firmware changed; an app uploaded over UDP is kept otherwise.
export function prepareFlash(dir: string, fw: FirmwareInfo, mon: MonitorInfo): string {
    const file = path.join(dir, 'flash.bin');
    const stateFile = path.join(dir, 'flash.json');
    const gen = fw.generation;
    const flash = Buffer.alloc(FLASH_SIZE[gen], 0xff);
    let state: Partial<FlashState> = {};
    if (fs.existsSync(file) && fs.existsSync(stateFile)) {
        fs.readFileSync(file).copy(flash, 0, 0, flash.length);
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
    const hdr = headerOffset(gen);
    if (state.monitorSha !== mon.sha256) {
        flash.fill(0xff, 0, hdr);
        fs.readFileSync(binPath(gen)).copy(flash, 0);
    }
    if (state.firmwareId !== fw.id) {
        const img = tiosImage(appBinary(fw));
        if (hdr + img.length > flash.length) {
            throw new Error('firmware does not fit in flash');
        }
        flash.fill(0xff, hdr);
        img.copy(flash, hdr);
    }
    if (state.monitorSha !== mon.sha256 || state.firmwareId !== fw.id || !fs.existsSync(file)) {
        fs.writeFileSync(file, flash);
        fs.writeFileSync(stateFile, JSON.stringify({ monitorSha: mon.sha256, firmwareId: fw.id }, null, 2));
    }
    return file;
}

// Makes the next prepareFlash() reinstall the app from the firmware ELF.
export function forgetFlashApp(dir: string): void {
    const stateFile = path.join(dir, 'flash.json');
    if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        fs.writeFileSync(stateFile, JSON.stringify({ ...state, firmwareId: '' }, null, 2));
    }
}

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { monitorsDir } from './config';
import { flashSegments } from './elf';
import { APP_BASE, FLASH_SIZE, FirmwareInfo, Generation } from './firmware';

// Each instance has a persistent internal-flash image, flash.bin. It holds the default Tibbo
// Monitor/Loader of the generation (if one is set), the app from the instance's ELF in the layout the
// monitor installs, and whatever .bin uploads wrote at their address. With a monitor at 0x08000000 the
// instance boots through it, so QF/D/N uploads over UDP replace the app as on a board.

export const FLASH_START = 0x08000000;
// The monitor keeps the (decrypted) uploaded image from APP_BASE - 0x200: a 3-byte size, padding,
// the app at +0x200 and a 2-byte checksum. Layout as built by convert_to_tios.js, minus the encryption.
const HEADER_SIZE = 0x200;
const BLOCK_SIZE = 128;
// flash.json firmwareId of an instance without firmware (app area left erased).
const NO_FIRMWARE = 'none';
// flash.json monitorSha once a .bin upload wrote into the monitor area: the default stays out.
const OWN_MONITOR = 'own';
// flash.json monitorSha that makes the next start rewrite the monitor area from the default.
const RESET_MONITOR = 'reset';

// Boot signature an app leaves in SRAM before rebooting into the monitor for a UDP upload (QF):
// 'U', 0xAA, 0x1E, '-' at the end of SRAM. The monitor checks it before the app, and starts its
// network Loader. Without it and without a valid app the monitor only blinks an error pattern
// ("Update system"). Read from the TPP2W(G2) Monitor/Loader 3.00B and TPP2WG3_RELEASE_MON.bin: both
// check it 0x18 below the end of SRAM (128 KB on G2, 192 KB on G3).
export const LOADER_SIGNATURE = 0x2d1eaa55;
export const LOADER_SIGNATURE_ADDRESS: Partial<Record<Generation, number>> = { g2: 0x2001ffe8, g3: 0x2002ffe8 };

export interface MonitorInfo {
    generation: Generation;
    name: string;
    size: number;
    sha256: string;
    uploadedAt: string;
    binPath: string;
}

// A .bin upload written into an instance's flash. Its data is kept (in flash-writes/<file>) so it can
// be written back after the app or monitor area around it is rewritten.
export interface FlashWrite {
    name: string;
    address: number;
    size: number;
    writtenAt: string;
    file: string;
}

interface FlashState {
    // sha256 of the default monitor in the monitor area, OWN_MONITOR, or '' (erased).
    monitorSha: string;
    // ELF whose app is in the app area (NO_FIRMWARE: erased); '' makes the next start reinstall it.
    firmwareId: string;
    writes: FlashWrite[];
}

export type FlashBoot = 'monitor' | 'app' | null;

function binPath(gen: Generation): string {
    return path.join(monitorsDir(), `${gen}.bin`);
}

function metaPath(gen: Generation): string {
    return path.join(monitorsDir(), `${gen}.json`);
}

function headerOffset(gen: Generation): number {
    return APP_BASE[gen] - HEADER_SIZE - FLASH_START;
}

function hex(n: number): string {
    return '0x' + n.toString(16).padStart(8, '0');
}

// A Cortex-M vector table: initial SP in SRAM or CCM, reset handler (Thumb) in flash.
function hasVectors(buf: Buffer, offset: number, flashSize: number): boolean {
    if (offset + 8 > buf.length) {
        return false;
    }
    const sp = buf.readUInt32LE(offset);
    const reset = buf.readUInt32LE(offset + 4);
    return (sp >>> 24 === 0x20 || sp >>> 24 === 0x10) && (reset & 1) === 1 && reset >= FLASH_START && reset < FLASH_START + flashSize;
}

// The default monitor of a generation.
export function getMonitor(gen: Generation): MonitorInfo | undefined {
    if (!fs.existsSync(metaPath(gen)) || !fs.existsSync(binPath(gen))) {
        return undefined;
    }
    return { ...JSON.parse(fs.readFileSync(metaPath(gen), 'utf8')), binPath: binPath(gen) };
}

// API view: no server paths.
export function monitorJSON(m: MonitorInfo | undefined) {
    if (!m) {
        return null;
    }
    const { binPath, ...rest } = m;
    return rest;
}

export function listMonitors() {
    return { g2: monitorJSON(getMonitor('g2')), g3: monitorJSON(getMonitor('g3')) };
}

export function setMonitor(gen: Generation, name: string, bin: Buffer): MonitorInfo {
    const limit = headerOffset(gen);
    if (bin.length < 8 || bin.length > limit) {
        throw new Error(`monitor image must be 8..${limit} bytes, got ${bin.length}`);
    }
    // A plain image starts with its vector table; encrypted update files (*_ENC.bin) don't.
    if (!hasVectors(bin, 0, bin.length)) {
        throw new Error(`not a plain monitor image: no vector table at its start (encrypted files can't run)`);
    }
    fs.mkdirSync(monitorsDir(), { recursive: true });
    fs.writeFileSync(binPath(gen), bin);
    const info: MonitorInfo = {
        generation: gen,
        name: name || `${gen}.bin`,
        size: bin.length,
        sha256: crypto.createHash('sha256').update(bin).digest('hex'),
        uploadedAt: new Date().toISOString(),
        binPath: binPath(gen),
    };
    const { binPath: _, ...meta } = info;
    fs.writeFileSync(metaPath(gen), JSON.stringify(meta, null, 2));
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

// The monitor's check of the installed app: a size header in range and the image's big-endian
// 16-bit words summing to 0xFFFF (see tiosImage). The monitor doesn't check where the app is linked,
// so an app built for the other generation (a G2 app uploaded to a G3) passes and crashes into the
// monitor; such an app, with its reset handler below the app base, counts as no app here.
function hasValidApp(flash: Buffer, gen: Generation): boolean {
    const hdr = headerOffset(gen);
    const total = (flash[hdr] << 16) | (flash[hdr + 1] << 8) | flash[hdr + 2];
    if (total < 5 || hdr + total > flash.length) {
        return false;
    }
    const appOffset = APP_BASE[gen] - FLASH_START;
    if (!hasVectors(flash, appOffset, flash.length) || flash.readUInt32LE(appOffset + 4) < APP_BASE[gen]) {
        return false;
    }
    let sum = 0;
    for (let i = 0; i < total; i++) {
        sum += i % 2 === 0 ? flash[hdr + i] << 8 : flash[hdr + i];
    }
    return (sum & 0xffff) === 0xffff;
}

function flashFile(dir: string): string {
    return path.join(dir, 'flash.bin');
}

function stateFile(dir: string): string {
    return path.join(dir, 'flash.json');
}

function readState(dir: string): FlashState | undefined {
    if (!fs.existsSync(flashFile(dir)) || !fs.existsSync(stateFile(dir))) {
        return undefined;
    }
    const s = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
    return { monitorSha: s.monitorSha || '', firmwareId: s.firmwareId || '', writes: s.writes || [] };
}

function writeState(dir: string, state: FlashState): void {
    fs.writeFileSync(stateFile(dir), JSON.stringify(state, null, 2));
}

function overlaps(w: FlashWrite, start: number, end: number): boolean {
    return w.address < end && w.address + w.size > start;
}

function writesDir(dir: string): string {
    return path.join(dir, 'flash-writes');
}

// After [eraseStart, eraseEnd) of flash was erased and [takenStart, takenEnd) refilled: .bin writes in
// the refilled part are gone, the other ones in the erased part are written again (oldest first).
function rewriteWrites(dir: string, writes: FlashWrite[], flash: Buffer,
    eraseStart: number, eraseEnd: number, takenStart: number, takenEnd: number): FlashWrite[] {
    const kept: FlashWrite[] = [];
    for (const w of [...writes].sort((a, b) => a.writtenAt.localeCompare(b.writtenAt))) {
        const data = path.join(writesDir(dir), w.file || '');
        if (!overlaps(w, eraseStart, eraseEnd)) {
            kept.push(w);
        } else if (!overlaps(w, takenStart, takenEnd) && w.file && fs.existsSync(data)) {
            fs.readFileSync(data).copy(flash, w.address - FLASH_START);
            kept.push(w);
        } else if (w.file) {
            fs.rmSync(data, { force: true });
        }
    }
    return kept;
}

// Loads flash.bin and brings it up to date: the default monitor when it changed (unless a .bin took
// the monitor area), the app when the instance's ELF changed. Anything else in flash, such as an app
// uploaded over UDP or a .bin written there, is kept. Writes the files back if anything changed.
function syncFlash(dir: string, gen: Generation, mon: MonitorInfo | undefined, fw: FirmwareInfo | undefined) {
    const size = FLASH_SIZE[gen];
    const flash = Buffer.alloc(size, 0xff);
    const prev = readState(dir);
    if (prev) {
        fs.readFileSync(flashFile(dir)).copy(flash, 0, 0, size);
    }
    const state: FlashState = prev || { monitorSha: '', firmwareId: '', writes: [] };
    const hdr = headerOffset(gen);
    let changed = !prev;

    const monitorSha = mon ? mon.sha256 : '';
    if (state.monitorSha !== OWN_MONITOR && state.monitorSha !== monitorSha) {
        flash.fill(0xff, 0, hdr);
        if (mon) {
            fs.readFileSync(mon.binPath).copy(flash, 0);
        }
        state.monitorSha = monitorSha;
        // The monitor area is the default's again: .bin writes there are dropped.
        state.writes = rewriteWrites(dir, state.writes, flash, FLASH_START, FLASH_START + hdr, FLASH_START, FLASH_START + hdr);
        changed = true;
    }

    // An ELF linked elsewhere than APP_BASE only runs through the boot stub; its area stays erased.
    const firmwareId = fw ? fw.id : NO_FIRMWARE;
    if (state.firmwareId !== firmwareId) {
        flash.fill(0xff, hdr);
        let appEnd = hdr;
        if (fw && fw.flashBase === APP_BASE[gen]) {
            const img = tiosImage(appBinary(fw));
            if (hdr + img.length > size) {
                throw new Error('firmware does not fit in flash');
            }
            img.copy(flash, hdr);
            appEnd = hdr + img.length;
        }
        state.firmwareId = firmwareId;
        // .bin writes the new app doesn't cover (data further up, say) survive.
        state.writes = rewriteWrites(dir, state.writes, flash, FLASH_START + hdr, FLASH_START + size, FLASH_START + hdr, FLASH_START + appEnd);
        changed = true;
    }
    return { flash, state, changed };
}

// Brings flash.bin up to date for a start and says what it can boot: 'monitor' with a vector table at
// 0x08000000, else 'app' with one at APP_BASE (an app written without a monitor), else null.
// appValid: the monitor would start the app (else it needs the Loader signature to do anything).
export function prepareFlash(dir: string, gen: Generation, mon: MonitorInfo | undefined, fw: FirmwareInfo | undefined) {
    const { flash, state, changed } = syncFlash(dir, gen, mon, fw);
    if (changed) {
        fs.writeFileSync(flashFile(dir), flash);
        writeState(dir, state);
    }
    const appOffset = APP_BASE[gen] - FLASH_START;
    const boot: FlashBoot = hasVectors(flash, 0, flash.length) ? 'monitor' : hasVectors(flash, appOffset, flash.length) ? 'app' : null;
    return {
        file: flashFile(dir),
        boot,
        appValid: hasValidApp(flash, gen),
        appSp: flash.readUInt32LE(appOffset),
        appReset: flash.readUInt32LE(appOffset + 4),
    };
}

// Checks a .bin upload before anything is written: it must lie inside the generation's flash, and
// one written at 0x08000000 (a monitor) must start with a vector table.
export function checkFlashWrite(gen: Generation, address: number, data: Buffer): void {
    const size = FLASH_SIZE[gen];
    if (!Number.isInteger(address) || address < FLASH_START || address + data.length > FLASH_START + size || !data.length) {
        throw new Error(`a .bin of ${data.length} bytes at ${hex(address)} does not fit in ${gen.toUpperCase()} flash `
            + `(${hex(FLASH_START)}..${hex(FLASH_START + size)})`);
    }
    if (address === FLASH_START && !hasVectors(data, 0, size)) {
        throw new Error(`a .bin at ${hex(FLASH_START)} must start with a vector table (a plain monitor image); `
            + `encrypted *_ENC.bin files can't run, and TiOS app .bin files are uploaded from TIDE`);
    }
}

// Writes a .bin into the instance's flash at `address`, after bringing the rest up to date. A write
// into the monitor area replaces the default monitor for this instance; one into the app area stays
// until a new ELF is uploaded or the app is reflashed.
export function writeFlash(dir: string, gen: Generation, mon: MonitorInfo | undefined, fw: FirmwareInfo | undefined,
    address: number, data: Buffer, name: string): FlashWrite {
    checkFlashWrite(gen, address, data);
    const { flash, state } = syncFlash(dir, gen, mon, fw);
    data.copy(flash, address - FLASH_START);
    if (address < FLASH_START + headerOffset(gen)) {
        state.monitorSha = OWN_MONITOR;
    }
    const write: FlashWrite = {
        name: name || 'image.bin',
        address,
        size: data.length,
        writtenAt: new Date().toISOString(),
        file: `${hex(address)}-${crypto.randomBytes(3).toString('hex')}.bin`,
    };
    fs.mkdirSync(writesDir(dir), { recursive: true });
    fs.writeFileSync(path.join(writesDir(dir), write.file), data);
    // Writes this one fully covers are gone.
    const covered = (w: FlashWrite) => w.address >= address && w.address + w.size <= address + data.length;
    state.writes.filter(covered).forEach((w) => w.file && fs.rmSync(path.join(writesDir(dir), w.file), { force: true }));
    state.writes = [...state.writes.filter((w) => !covered(w)), write];
    fs.writeFileSync(flashFile(dir), flash);
    writeState(dir, state);
    return write;
}

// What .bin uploads put into the instance's flash (from flash.json; flash.bin itself isn't read):
// the name of the monitor one wrote, if any, and the writes by address.
export function flashWrites(dir: string): { ownMonitor?: string; writes: FlashWrite[] } {
    const state = readState(dir);
    if (!state) {
        return { writes: [] };
    }
    const own = state.monitorSha === OWN_MONITOR
        ? (state.writes.find((w) => w.address === FLASH_START)?.name || 'written by a .bin upload')
        : undefined;
    return { ownMonitor: own, writes: [...state.writes].sort((a, b) => a.address - b.address) };
}

// Drops what .bin uploads wrote into the monitor area: the next start installs the default monitor
// (or leaves the area erased).
export function useDefaultMonitor(dir: string, gen: Generation): boolean {
    const state = readState(dir);
    if (!state || state.monitorSha !== OWN_MONITOR) {
        return false;
    }
    // The next start rewrites the area; the writes there are forgotten now.
    const inArea = (w: FlashWrite) => overlaps(w, FLASH_START, FLASH_START + headerOffset(gen));
    state.writes.filter(inArea).forEach((w) => w.file && fs.rmSync(path.join(writesDir(dir), w.file), { force: true }));
    writeState(dir, { ...state, monitorSha: RESET_MONITOR, writes: state.writes.filter((w) => !inArea(w)) });
    return true;
}

// Makes the next prepareFlash() reinstall the app from the firmware ELF.
export function forgetFlashApp(dir: string): void {
    const state = readState(dir);
    if (state) {
        writeState(dir, { ...state, firmwareId: '' });
    }
}

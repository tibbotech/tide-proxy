import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { firmwareDir } from './config';
import { readElf } from './elf';
import { boardProfile, BoardProfile } from './dts';

export type Generation = 'g2' | 'g3';

export interface FirmwareInfo {
    id: string;
    name: string;
    uploadedAt: string;
    generation: Generation;
    flashBase: number;
    initialSp: number;
    resetVector: number;
    hasDts: boolean;
    profile: BoardProfile;
    elfPath: string;
}

export const APP_BASE: Record<Generation, number> = { g2: 0x08008200, g3: 0x08040200 };
export const FLASH_SIZE: Record<Generation, number> = { g2: 0x100000, g3: 0x200000 };

// Used when no zephyr.dts is uploaded: the TPP board defaults from tpp_g2/g3.dtsi.
function defaultProfile(generation: Generation): BoardProfile {
    return {
        board: generation === 'g3' ? 'tpp2g3' : 'tpp2g2',
        model: '',
        uarts: ['usart1', 'usart2', 'usart3', 'uart5', 'usart6'],
        buttons: [{ id: 'mdbutton', label: 'MD', port: 'B', pin: 10, activeLow: true }],
        leds: [
            { id: 'green_led_gpio', label: 'green', port: 'B', pin: 14, activeLow: false },
            { id: 'red_led_gpio', label: 'red', port: 'B', pin: 15, activeLow: false },
        ],
        lcd: { width: 320, height: 240 },
    };
}

export function generationOf(flashBase: number, board: string): Generation {
    if (flashBase === APP_BASE.g3) {
        return 'g3';
    }
    if (flashBase === APP_BASE.g2) {
        return 'g2';
    }
    return /g3$/.test(board) ? 'g3' : 'g2';
}

function dir(id: string): string {
    return path.join(firmwareDir(), id);
}

export function listFirmware(): FirmwareInfo[] {
    if (!fs.existsSync(firmwareDir())) {
        return [];
    }
    return fs
        .readdirSync(firmwareDir())
        .map((id) => getFirmware(id))
        .filter((f): f is FirmwareInfo => !!f)
        .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export function getFirmware(id: string): FirmwareInfo | undefined {
    const meta = path.join(dir(id), 'meta.json');
    if (!/^[\w-]+$/.test(id) || !fs.existsSync(meta)) {
        return undefined;
    }
    const info = JSON.parse(fs.readFileSync(meta, 'utf8')) as FirmwareInfo;
    info.elfPath = path.join(dir(id), 'zephyr.elf');
    return info;
}

export function addFirmware(name: string, elf: Buffer, dts?: Buffer): FirmwareInfo {
    const elfInfo = readElf(elf);
    let profile: BoardProfile | undefined;
    if (dts && dts.length > 0) {
        profile = boardProfile(dts.toString('utf8'));
    }
    const generation = generationOf(elfInfo.flashBase, profile?.board || '');
    if (!profile) {
        profile = defaultProfile(generation);
    }

    const safeName = (name || 'firmware').replace(/[^\w.-]+/g, '_').slice(0, 60);
    const id = `${safeName.replace(/\./g, '_')}-${crypto.randomBytes(3).toString('hex')}`;
    fs.mkdirSync(dir(id), { recursive: true });
    fs.writeFileSync(path.join(dir(id), 'zephyr.elf'), elf);
    if (dts) {
        fs.writeFileSync(path.join(dir(id), 'zephyr.dts'), dts);
    }
    const info: FirmwareInfo = {
        id,
        name: name || id,
        uploadedAt: new Date().toISOString(),
        generation,
        flashBase: elfInfo.flashBase,
        initialSp: elfInfo.initialSp,
        resetVector: elfInfo.resetVector,
        hasDts: !!dts,
        profile,
        elfPath: path.join(dir(id), 'zephyr.elf'),
    };
    const { elfPath, ...meta } = info;
    fs.writeFileSync(path.join(dir(id), 'meta.json'), JSON.stringify(meta, null, 2));
    return info;
}

export function deleteFirmware(id: string): boolean {
    if (!getFirmware(id)) {
        return false;
    }
    fs.rmSync(dir(id), { recursive: true, force: true });
    return true;
}

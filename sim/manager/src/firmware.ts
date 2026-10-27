import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { readElf } from './elf';
import { boardProfile, BoardProfile } from './dts';

export type Generation = 'g2' | 'g3';
// Device types an instance can be. g2 = STM32F207, g3 = STM32F439; TPP2 and TPP3 share the MCU
// and the board defaults (tpp_g2/g3.dtsi) and differ in the faceplate.
export type Board = 'tpp2g2' | 'tpp3g2' | 'tpp2g3' | 'tpp3g3';

// An instance's app: zephyr.elf (+ zephyr.dts) uploaded into <instance>/firmware.
export interface FirmwareInfo {
    // Changes on every upload; the monitor flash image tracks it (flash.json).
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

export const BOARDS: Board[] = ['tpp2g2', 'tpp3g2', 'tpp2g3', 'tpp3g3'];
export const APP_BASE: Record<Generation, number> = { g2: 0x08008200, g3: 0x08040200 };
export const FLASH_SIZE: Record<Generation, number> = { g2: 0x100000, g3: 0x200000 };

export function isBoard(v: any): v is Board {
    return BOARDS.includes(v);
}

export function boardGeneration(board: Board): Generation {
    return board.endsWith('g3') ? 'g3' : 'g2';
}

// Used without a zephyr.dts (or without firmware): the TPP board defaults from tpp_g2/g3.dtsi.
// The LCD is assumed on TPP2 only; a TPP3 has no display.
export function defaultProfile(board: Board): BoardProfile {
    return {
        board,
        model: '',
        uarts: ['usart1', 'usart2', 'usart3', 'uart5', 'usart6'],
        buttons: [{ id: 'mdbutton', label: 'MD', port: 'B', pin: 10, activeLow: true }],
        leds: [
            { id: 'green_led_gpio', label: 'green', port: 'B', pin: 14, activeLow: true },
            { id: 'red_led_gpio', label: 'red', port: 'B', pin: 15, activeLow: true },
        ],
        lcd: board.startsWith('tpp2') ? { width: 320, height: 240 } : undefined,
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

export function loadFirmware(dir: string): FirmwareInfo | undefined {
    const meta = path.join(dir, 'meta.json');
    if (!fs.existsSync(meta)) {
        return undefined;
    }
    const info = JSON.parse(fs.readFileSync(meta, 'utf8')) as FirmwareInfo;
    info.elfPath = path.join(dir, 'zephyr.elf');
    // Re-read the DTS rather than trust the saved profile, so parser fixes reach existing instances.
    const dtsPath = path.join(dir, 'zephyr.dts');
    if (info.hasDts && fs.existsSync(dtsPath)) {
        info.profile = boardProfile(fs.readFileSync(dtsPath, 'utf8'));
    } else if (!info.hasDts && isBoard(info.profile.board)) {
        info.profile = defaultProfile(info.profile.board);
    }
    return info;
}

// Replaces the firmware in `dir`. Without a new DTS the one already there is kept, so a rebuilt
// ELF can be uploaded on its own. The ELF must be linked for the board's generation, and a DTS that
// names one of the TPP boards must name this one.
export function saveFirmware(dir: string, board: Board, name: string, elf: Buffer, dts?: Buffer): FirmwareInfo {
    const generation = boardGeneration(board);
    const elfInfo = readElf(elf);
    const dtsPath = path.join(dir, 'zephyr.dts');
    if (!dts || dts.length === 0) {
        dts = fs.existsSync(dtsPath) ? fs.readFileSync(dtsPath) : undefined;
    }
    const profile = dts ? boardProfile(dts.toString('utf8')) : undefined;
    const elfGen = generationOf(elfInfo.flashBase, profile?.board || '');
    if (elfGen !== generation) {
        throw new Error(`firmware is a ${elfGen.toUpperCase()} build (app at 0x${elfInfo.flashBase.toString(16)}), the instance is ${board} (${generation.toUpperCase()})`);
    }
    if (profile && isBoard(profile.board) && profile.board !== board) {
        throw new Error(`zephyr.dts is for ${profile.board}, the instance is ${board}`);
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'zephyr.elf'), elf);
    if (dts) {
        fs.writeFileSync(dtsPath, dts);
    }
    const info: FirmwareInfo = {
        id: crypto.randomBytes(6).toString('hex'),
        name: name || 'zephyr.elf',
        uploadedAt: new Date().toISOString(),
        generation,
        flashBase: elfInfo.flashBase,
        initialSp: elfInfo.initialSp,
        resetVector: elfInfo.resetVector,
        hasDts: !!dts,
        profile: profile || defaultProfile(board),
        elfPath: path.join(dir, 'zephyr.elf'),
    };
    const { elfPath, ...meta } = info;
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return info;
}

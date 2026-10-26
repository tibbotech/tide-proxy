// Minimal ELF32 little-endian reader: enough to find the app's flash image and vector table.

export interface ElfInfo {
    entry: number;
    // Lowest load address inside the STM32 flash window (start of the app vector table).
    flashBase: number;
    initialSp: number;
    resetVector: number;
}

const PT_LOAD = 1;
const FLASH_START = 0x08000000;
const FLASH_END = 0x08200000;

export interface FlashSegment {
    paddr: number;
    data: Buffer;
}

export function readElf(buf: Buffer): ElfInfo {
    const flashSegs = flashSegments(buf);
    const first = flashSegs[0];
    if (first.data.length < 8) {
        throw new Error('first flash segment too small for a vector table');
    }
    return {
        entry: buf.readUInt32LE(24),
        flashBase: first.paddr,
        initialSp: first.data.readUInt32LE(0),
        resetVector: first.data.readUInt32LE(4),
    };
}

// Loadable segments inside the STM32 flash window, lowest address first.
export function flashSegments(buf: Buffer): FlashSegment[] {
    if (buf.length < 52 || buf.readUInt32BE(0) !== 0x7f454c46) {
        throw new Error('not an ELF file');
    }
    if (buf[4] !== 1 || buf[5] !== 1) {
        throw new Error('only 32-bit little-endian ELF is supported');
    }
    const phoff = buf.readUInt32LE(28);
    const phentsize = buf.readUInt16LE(42);
    const phnum = buf.readUInt16LE(44);

    const segments: { paddr: number; offset: number; filesz: number }[] = [];
    for (let i = 0; i < phnum; i++) {
        const o = phoff + i * phentsize;
        if (buf.readUInt32LE(o) !== PT_LOAD) {
            continue;
        }
        const offset = buf.readUInt32LE(o + 4);
        const paddr = buf.readUInt32LE(o + 12);
        const filesz = buf.readUInt32LE(o + 16);
        if (filesz > 0) {
            segments.push({ paddr, offset, filesz });
        }
    }
    const flashSegs = segments
        .filter((s) => s.paddr >= FLASH_START && s.paddr < FLASH_END)
        .sort((a, b) => a.paddr - b.paddr);
    if (flashSegs.length === 0) {
        throw new Error('ELF has no segment in STM32 flash (0x08000000)');
    }
    return flashSegs.map((s) => ({ paddr: s.paddr, data: buf.subarray(s.offset, s.offset + s.filesz) }));
}

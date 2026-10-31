import * as fs from 'fs';
import * as crypto from 'crypto';

// SD card images for #49 slots: an MBR with one FAT32 partition, as cards come formatted. FatFs (Zephyr's
// FAT driver) mounts it as it is, and 7-Zip, mtools or a loop mount can open the file.

export const SD_DEFAULT_MB = 64;
export const SD_MIN_MB = 64; // FAT32 needs 65525 clusters; 512-byte clusters get there from ~33 MB
export const SD_MAX_MB = 4096;
// The card's capacity is the image size in whole 512 KiB units (SDHC CSD).
export const SD_UNIT = 512 * 1024;

const SECTOR = 512;
const PART_START = 2048; // 1 MiB alignment
const RESERVED = 32;
const FATS = 2;

// Cluster size for a FAT32 volume of `sectors`, as Windows formats them.
function sectorsPerCluster(sectors: number): number {
    if (sectors <= 532480) return 1; // up to 260 MB: 512 bytes
    if (sectors <= 16777216) return 8; // up to 8 GB: 4 KB
    return 16;
}

// Writes a blank card image of `mb` MiB to `file` (replacing it): sparse where the file system allows.
export function formatSdImage(file: string, mb: number): void {
    if (!Number.isInteger(mb) || mb < SD_MIN_MB || mb > SD_MAX_MB) {
        throw new Error(`card size must be ${SD_MIN_MB}-${SD_MAX_MB} MB`);
    }
    const total = (mb * 1024 * 1024) / SECTOR;
    const sectors = total - PART_START;
    const spc = sectorsPerCluster(sectors);
    // FAT size per the FAT32 spec (fatgen103): over-allocates by at most a sector or two.
    const fatSize = Math.ceil((sectors - RESERVED) / ((256 * spc + FATS) / 2));
    const clusters = Math.floor((sectors - RESERVED - FATS * fatSize) / spc);
    const volumeId = crypto.randomBytes(4).readUInt32LE(0);

    const mbr = Buffer.alloc(SECTOR);
    crypto.randomBytes(4).copy(mbr, 440); // disk signature
    const entry = 446;
    mbr[entry] = 0x00;
    mbr.set([0xfe, 0xff, 0xff], entry + 1); // CHS: use the LBA fields
    mbr[entry + 4] = 0x0c; // FAT32 (LBA)
    mbr.set([0xfe, 0xff, 0xff], entry + 5);
    mbr.writeUInt32LE(PART_START, entry + 8);
    mbr.writeUInt32LE(sectors, entry + 12);
    mbr.writeUInt16LE(0xaa55, 510);

    const boot = Buffer.alloc(SECTOR);
    boot.set([0xeb, 0x58, 0x90], 0);
    boot.write('MSWIN4.1', 3, 'ascii');
    boot.writeUInt16LE(SECTOR, 11);
    boot[13] = spc;
    boot.writeUInt16LE(RESERVED, 14);
    boot[16] = FATS;
    boot[21] = 0xf8; // fixed disk
    boot.writeUInt16LE(63, 24); // sectors per track
    boot.writeUInt16LE(255, 26); // heads
    boot.writeUInt32LE(PART_START, 28); // hidden sectors
    boot.writeUInt32LE(sectors, 32);
    boot.writeUInt32LE(fatSize, 36);
    boot.writeUInt32LE(2, 44); // root directory cluster
    boot.writeUInt16LE(1, 48); // FSInfo sector
    boot.writeUInt16LE(6, 50); // backup boot sector
    boot[64] = 0x80; // drive number
    boot[66] = 0x29; // extended boot signature
    boot.writeUInt32LE(volumeId, 67);
    boot.write('NO NAME    ', 71, 'ascii');
    boot.write('FAT32   ', 82, 'ascii');
    boot.writeUInt16LE(0xaa55, 510);

    const fsInfo = Buffer.alloc(SECTOR);
    fsInfo.writeUInt32LE(0x41615252, 0);
    fsInfo.writeUInt32LE(0x61417272, 484);
    fsInfo.writeUInt32LE(clusters - 1, 488); // free: all but the root directory's
    fsInfo.writeUInt32LE(3, 492); // next free cluster
    fsInfo.writeUInt32LE(0xaa550000, 508);

    // FAT entries 0 and 1 are reserved; 2 is the root directory, one cluster long.
    const fat = Buffer.alloc(SECTOR);
    fat.writeUInt32LE(0x0ffffff8, 0);
    fat.writeUInt32LE(0x0fffffff, 4);
    fat.writeUInt32LE(0x0fffffff, 8);

    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.ftruncateSync(fd, mb * 1024 * 1024);
        const put = (buf: Buffer, sector: number) => fs.writeSync(fd, buf, 0, buf.length, sector * SECTOR);
        put(mbr, 0);
        const part = PART_START;
        put(boot, part);
        put(fsInfo, part + 1);
        put(boot, part + 6);
        put(fsInfo, part + 7);
        for (let i = 0; i < FATS; i++) {
            put(fat, part + RESERVED + i * fatSize);
        }
        // The root directory cluster is already zero (empty).
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}

// Checks an uploaded image: at least one 512 KiB unit; what lies past the last whole unit is not seen.
export function checkSdImage(size: number): void {
    if (size < SD_UNIT) {
        throw new Error('a card image must be at least 512 KiB');
    }
    if (size > SD_MAX_MB * 1024 * 1024) {
        throw new Error(`a card image can be at most ${SD_MAX_MB} MB`);
    }
}

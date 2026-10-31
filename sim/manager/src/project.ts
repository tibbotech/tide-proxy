import { Board } from './firmware';
import { Placements, SD_SLOT, featureSettings, isFunctionSocket, placementsFromProject, socketsOf, tibbitInfo } from './tibbits';

// Cody device ids of the TPPs the simulator runs (PlatformUtils.BOARD_FILES).
const CODY_DEVICES: Record<string, Board> = {
    'TPP2W(G2)': 'tpp2g2',
    'TPP3W(G2)': 'tpp3g2',
    'TPP2W(G3)': 'tpp2g3',
    'TPP3W(G3)': 'tpp3g3',
};

// What a Cody project says about the hardware: the device, whether a TPP2 is in the TPB2L case (LCD
// and keypad), and the Tibbits in its sockets.
export interface ProjectSetup {
    board: Board;
    name?: string;
    device: string; // the project's device id
    lcd?: boolean; // TPP2 only
    tibbits: Placements;
    skipped: string[]; // Tibbits the board can't take
    notes: string[]; // what was added or assumed
}

export function projectDevice(project: any): string {
    const d = project?.device;
    return String((d && typeof d === 'object' ? d.id : d) || '');
}

function feature(project: any, id: string): Record<string, any> | undefined {
    const f = (Array.isArray(project?.features) ? project.features : []).find((x: any) => x?.id === id);
    return f ? featureSettings(f) : undefined;
}

// The LCD comes with the TPB2L case (Board settings > TPB). An enabled LCD feature implies it too, as the
// firmware will drive the panel.
function projectLcd(project: any): boolean {
    if (feature(project, 'boardsetting')?.TPB === 'tpb2lg2') {
        return true;
    }
    const lcd = feature(project, 'lcd');
    return !!lcd && lcd.ENABLED !== '0';
}

// A simulated function Tibbit with a free connector socket beside it gets a #21 terminal block there, as
// when it is placed by hand, so that it can be wired.
function addTerminalBlocks(board: Board, placed: Placements, notes: string[]): Placements {
    const out = { ...placed };
    const list = socketsOf(board);
    const covered = new Set(Object.entries(out).filter(([, m]) => ['C2', 'M2S', 'M2T', 'H2'].includes(tibbitInfo(m)?.form || '')).map(([s]) => String(Number(s) + 2)));
    for (const s of list) {
        const model = out[s.socket];
        const pair = String(Number(s.socket) + 1);
        const pairInfo = list.find((x) => x.socket === pair);
        if (!model || !isFunctionSocket(s) || !tibbitInfo(model)?.sim || !pairInfo || out[pair] || covered.has(pair) || !pairInfo.accept.includes('C1')) {
            continue;
        }
        out[pair] = '21';
        notes.push(`added a #21 terminal block in socket ${pair} for #${model} in socket ${s.socket}`);
    }
    return out;
}

export function projectSetup(project: any): ProjectSetup {
    if (!project || typeof project !== 'object' || !Array.isArray(project.features)) {
        throw new Error('not a Cody project (no features list)');
    }
    const device = projectDevice(project);
    const board = CODY_DEVICES[device];
    if (!board) {
        throw new Error(`the project is for ${device || 'an unknown device'}; the simulator runs ${Object.keys(CODY_DEVICES).join(', ')}`);
    }
    return { ...setupFor(board, project), board };
}

// The setup for a given board, which may not be the project's: Tibbits it can't take are skipped.
export function setupFor(board: Board, project: any): ProjectSetup {
    const notes: string[] = [];
    const device = projectDevice(project);
    if (CODY_DEVICES[device] && CODY_DEVICES[device] !== board) {
        notes.push(`the project is for ${device}, this is ${board.toUpperCase()}`);
    }
    const { placements, skipped } = placementsFromProject(board, project);
    const tibbits = addTerminalBlocks(board, placements, notes);
    const lcd = board.startsWith('tpp2') ? projectLcd(project) : undefined;
    if (Object.values(tibbits).includes(SD_SLOT)) {
        notes.push('#49: a blank FAT32 card is created at the first start');
    }
    const name = typeof project?.name === 'string' && project.name.trim() ? project.name.trim().slice(0, 60) : undefined;
    return { board, name, device, lcd, tibbits, skipped, notes };
}

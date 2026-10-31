// Shapes the manager (src/server.ts, instances.ts, links.ts, dts.ts) sends.

export type Status = 'stopped' | 'starting' | 'running' | 'exited';
export type Generation = 'g2' | 'g3';
export type Board = 'tpp2g2' | 'tpp3g2' | 'tpp2g3' | 'tpp3g3';

export interface GpioRef {
    port: string; // 'A'..'K'
    pin: number;
    activeLow: boolean;
}

export interface BoardButton extends GpioRef {
    id: string;
    label: string;
}

export interface BoardLed extends GpioRef {
    id: string;
    label: string;
}

export interface BoardProfile {
    board: string;
    model: string;
    consoleUart?: string;
    uarts: string[];
    buttons: BoardButton[];
    leds: BoardLed[];
    lcd?: { width: number; height: number };
}

export interface LcdState {
    width: number;
    height: number;
    on: boolean;
    backlight: boolean;
}

// Streamed every 40 ms: pin levels and output masks per port ('A'..'I'), as bit masks.
export interface InstState {
    pins: Record<string, number>;
    out: Record<string, number>;
    blueBar: number;
    lcd?: LcdState;
    vtime: number;
}

// Per port: [moder, otyper, pupdr, afrl, afrh, extDriven, extLevel].
export type PinConfig = Record<string, number[]>;

export interface FlashWrite {
    name: string;
    address: number;
    size: number;
}

export interface Instance {
    id: string;
    name: string;
    index: number;
    board: Board;
    autoStart: boolean;
    generation: Generation;
    status: Status;
    exitCode?: number | null;
    mac: string;
    tibboMac: string;
    ip: string;
    httpPort: number;
    monitorPort: number;
    profile: BoardProfile;
    tibbits: Record<string, string>; // socket -> Tibbit model
    terminals: Terminal[]; // wire terminals of the terminal blocks among them
    sdCards: SdCard[]; // #49 slots
    lcd?: boolean; // TPP2 set up as a TPB2L or not; unset: as the DTS says
    firmware?: { name: string; uploadedAt: string; hasDts: boolean };
    monitor?: unknown;
    bootMonitor?: { name: string; own: boolean } | null;
    flashWrites: FlashWrite[];
    canStart: boolean;
    consoles: string[];
    debugPrintAttached: boolean;
}

export type LinkKind = 'uart' | 'gpio';

export interface Endpoint {
    instance: string;
    port: string;
}

export interface Link {
    id: string;
    kind: LinkKind;
    name: string;
    endpoints: Endpoint[];
}

export interface LinkStats {
    bytes: number;
    level: boolean | null;
}

export interface MonitorInfo {
    generation: Generation;
    name: string;
    size: number;
    sha256: string;
    uploadedAt: string;
}

export interface SimInfo {
    relayPort: number;
    subnet: string;
    relay: { clients: unknown[] };
}

// ---- Tibbits and field wiring ----
export type Role = 'a' | 'b' | 'tx' | 'rx' | 'rts' | 'cts' | 'w0' | 'w1' | 'io' | 'vcc' | 'gnd';

export interface Terminal {
    id: string; // 'T2.3'
    n: number;
    block: string;
    label: string;
    role?: Role;
    socket?: string;
    line?: number;
    mcu?: { port: string; pin: number };
    uart?: string;
    dir?: 'in' | 'out'; // an output Tibbit (relay, ...) or an input Tibbit
}

export interface TibbitInfo {
    model: string;
    name: string;
    form: string;
    category: string;
    lines?: string[];
    sim?: boolean;
}

export interface SocketInfo {
    socket: string;
    accept: string[];
    lines: Array<{ port: string; pin: number } | null>;
    uart?: string;
}

export interface Catalog {
    tibbits: TibbitInfo[];
    sockets: Record<string, SocketInfo[]>;
}

type McuPin = { port: string; pin: number };

// A #49 slot: its bit-banged SPI pins and the card image (size 0 until the first start makes one).
export interface SdCard {
    socket: string;
    clk: McuPin;
    mosi: McuPin;
    miso: McuPin;
    cs: McuPin;
    size: number;
    inserted: boolean;
}

// What a Cody project sets up (POST /api/projects/preview).
export interface ProjectSetup {
    board: Board;
    name?: string;
    device: string;
    lcd?: boolean;
    tibbits: Record<string, string>;
    skipped: string[];
    notes: string[];
}

export type FieldKind = 'wiegand-reader' | 'modbus-slave' | 'io-panel';

export interface FieldTerminal {
    id: string;
    label: string;
    role: Role;
}

export interface Register {
    type: 'holding' | 'input' | 'coil' | 'discrete';
    address: number;
    name: string;
    value: number;
}

export interface FieldDevice {
    id: string;
    kind: FieldKind;
    name: string;
    title: string;
    props: Record<string, any>;
    terminals: FieldTerminal[];
    activity: string[];
}

export interface TermRef {
    owner: string;
    term: string;
}

export interface Wire {
    id: string;
    a: TermRef;
    b: TermRef;
}

export interface WiringWarning {
    text: string;
    wires: string[];
}

export interface Wiring {
    wires: Wire[];
    warnings: WiringWarning[];
    pins: Record<string, Array<{ instance: string; port: string }>>;
}

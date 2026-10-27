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

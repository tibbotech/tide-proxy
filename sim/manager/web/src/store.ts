import { useSyncExternalStore } from 'react';
import { api } from './api';
import { handleLcd } from './lcd';
import type { Generation, Instance, InstState, Link, LinkStats, MonitorInfo, PinConfig, SimInfo } from './types';

// Live data from the manager: REST for the slow things, one websocket for everything else.
// The 40 ms 'state' stream is keyed per instance, so only the device showing that state re-renders.

class Signal {
    private ls = new Set<() => void>();
    subscribe = (l: () => void) => {
        this.ls.add(l);
        return () => {
            this.ls.delete(l);
        };
    };
    emit() {
        this.ls.forEach((l) => l());
    }
}

const signals = new Map<string, Signal>();
const sig = (key: string) => {
    let s = signals.get(key);
    if (!s) signals.set(key, (s = new Signal()));
    return s;
};

let instances: Instance[] = [];
const instCache = new Map<string, { json: string; inst: Instance }>();
const states = new Map<string, InstState>();
const pinConfigs = new Map<string, PinConfig | null>();
let links: Link[] = [];
let linkStats: Record<string, LinkStats> = {};
let monitors: Partial<Record<Generation, MonitorInfo>> = {};
let info: SimInfo | null = null;
let connected = false;
let detail: string | null = null;
let logLines: string[] = [];
let notice: { id: number; text: string; kind: 'error' | 'info' } | null = null;

// ---- hooks ----
export const useInstances = () => useSyncExternalStore(sig('instances').subscribe, () => instances);
export const useInstanceState = (id: string) => useSyncExternalStore(sig(`state:${id}`).subscribe, () => states.get(id));
export const usePinConfig = (id: string) => useSyncExternalStore(sig(`pins:${id}`).subscribe, () => pinConfigs.get(id) || undefined);
export const useLinks = () => useSyncExternalStore(sig('links').subscribe, () => links);
export const useLinkStats = () => useSyncExternalStore(sig('linkStats').subscribe, () => linkStats);
export const useMonitors = () => useSyncExternalStore(sig('monitors').subscribe, () => monitors);
export const useInfo = () => useSyncExternalStore(sig('info').subscribe, () => info);
export const useConnected = () => useSyncExternalStore(sig('conn').subscribe, () => connected);
export const useLog = () => useSyncExternalStore(sig('log').subscribe, () => logLines);
export const useNotice = () => useSyncExternalStore(sig('notice').subscribe, () => notice);

export const getInstances = () => instances;
export const getLinks = () => links;
export const getMonitors = () => monitors;

let noticeSeq = 0;
export function notify(text: string, kind: 'error' | 'info' = 'error') {
    const id = ++noticeSeq;
    notice = { id, text, kind };
    sig('notice').emit();
    setTimeout(() => {
        if (notice && notice.id === id) {
            notice = null;
            sig('notice').emit();
        }
    }, 6000);
}

// ---- console streams (only for the selected instance) ----
export interface ConsoleEvent {
    kind: 'reset' | 'data';
    id: string;
    uart: string;
    data?: Uint8Array;
}
const consoleBuf = new Map<string, Uint8Array[]>();
const consoleListeners = new Set<(e: ConsoleEvent) => void>();
const CONSOLE_KEEP = 64 * 1024;

export const getConsole = (id: string, uart: string) => consoleBuf.get(`${id}\0${uart}`) || [];
export function onConsole(l: (e: ConsoleEvent) => void) {
    consoleListeners.add(l);
    return () => {
        consoleListeners.delete(l);
    };
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function pushConsole(id: string, uart: string, data: Uint8Array) {
    const key = `${id}\0${uart}`;
    const hist = consoleBuf.get(key) || [];
    hist.push(data);
    let total = hist.reduce((n, b) => n + b.length, 0);
    while (total > CONSOLE_KEEP && hist.length > 1) total -= hist.shift()!.length;
    consoleBuf.set(key, hist);
    consoleListeners.forEach((l) => l({ kind: 'data', id, uart, data }));
}

// ---- websocket ----
let ws: WebSocket | null = null;

function sendRaw(msg: unknown) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function subscribe() {
    // Every faceplate on the rail shows its LCD, so all frames are wanted.
    sendRaw({ t: 'sub', lcd: '*', detail });
}

export function setDetail(id: string | null) {
    if (detail === id) return;
    detail = id;
    consoleBuf.clear();
    logLines = [];
    sig('log').emit();
    subscribe();
}

function onMessage(ev: MessageEvent) {
    if (typeof ev.data !== 'string') {
        handleLcd(ev.data, (id) => states.get(id)?.lcd);
        return;
    }
    const msg = JSON.parse(ev.data);
    switch (msg.t) {
    case 'instances': {
        const next: Instance[] = [];
        const seen = new Set<string>();
        for (const item of msg.list) {
            const { state, ...rest } = item;
            seen.add(rest.id);
            if (state) states.set(rest.id, state);
            else states.delete(rest.id);
            sig(`state:${rest.id}`).emit();
            const json = JSON.stringify(rest);
            const cached = instCache.get(rest.id);
            if (cached && cached.json === json) {
                next.push(cached.inst);
            } else {
                instCache.set(rest.id, { json, inst: rest });
                next.push(rest);
            }
        }
        for (const id of [...instCache.keys()]) {
            if (seen.has(id)) continue;
            instCache.delete(id);
            states.delete(id);
            pinConfigs.delete(id);
        }
        instances = next;
        sig('instances').emit();
        break;
    }
    case 'state':
        states.set(msg.id, msg.state);
        sig(`state:${msg.id}`).emit();
        break;
    case 'pinConfig':
        pinConfigs.set(msg.id, msg.pinConfig);
        sig(`pins:${msg.id}`).emit();
        break;
    case 'links':
        links = msg.links;
        linkStats = msg.stats;
        sig('links').emit();
        sig('linkStats').emit();
        break;
    case 'linkStats':
        linkStats = msg.stats;
        sig('linkStats').emit();
        break;
    case 'uart':
        if (msg.id === detail) pushConsole(msg.id, msg.uart, b64(msg.data));
        break;
    case 'backlog':
        if (msg.id === detail) {
            const key = `${msg.id}\0${msg.uart}`;
            const data = b64(msg.data);
            consoleBuf.set(key, data.length ? [data] : []);
            consoleListeners.forEach((l) => l({ kind: 'reset', id: msg.id, uart: msg.uart }));
            if (data.length) consoleListeners.forEach((l) => l({ kind: 'data', id: msg.id, uart: msg.uart, data }));
        }
        break;
    case 'log':
        if (msg.id === detail) {
            logLines = [...logLines, msg.line].slice(-2000);
            sig('log').emit();
        }
        break;
    case 'logBacklog':
        if (msg.id === detail) {
            logLines = msg.lines.slice(-2000);
            sig('log').emit();
        }
        break;
    case 'error':
        notify(msg.message);
        break;
    }
}

function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
        connected = true;
        sig('conn').emit();
        subscribe();
    };
    ws.onclose = () => {
        connected = false;
        sig('conn').emit();
        setTimeout(connect, 1500);
    };
    ws.onmessage = onMessage;
}

// ---- messages to the manager ----
export const sendButton = (id: string, button: string, pressed: boolean) => sendRaw({ t: 'input', id, button, pressed });
// level: 1 / 0 drives the line, null releases it.
export const sendPin = (id: string, port: string, pin: number, level: 0 | 1 | null) => sendRaw({ t: 'input', id, port, pin, level });
export const sendConsole = (id: string, uart: string, data: string) => sendRaw({ t: 'console', id, uart, data });

// ---- REST ----
export async function loadMonitors() {
    monitors = await api('GET', '/api/monitors').catch(() => ({}));
    sig('monitors').emit();
}

export async function loadInfo() {
    info = await api<SimInfo>('GET', '/api/info').catch(() => null);
    sig('info').emit();
}

let started = false;
export function startStore() {
    if (started) return;
    started = true;
    connect();
    loadMonitors();
    loadInfo();
    setInterval(loadInfo, 5000);
}

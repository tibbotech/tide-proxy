import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

import { config } from './config';
import { Instance, InstanceManager } from './instances';

// Wiring between instances, kept in <data>/links.json and re-applied as instances come and go.
//  - uart: a bus. Bytes one endpoint transmits go to every other endpoint's RX, so two endpoints
//    are a crossed serial cable and more are an RS485-style multi-drop line. No baud/flow control.
//  - gpio: endpoints[0] drives the others. While its pin is an output they are driven to its level,
//    otherwise released. Pin changes arrive with the bridge's state stream (every 40 ms at most),
//    so this carries slow signals only.
// An (instance, port) pair belongs to at most one link.

export type LinkKind = 'uart' | 'gpio';

export interface Endpoint {
    instance: string;
    // 'usart3' for uart links, 'PA0' for gpio links.
    port: string;
}

export interface Link {
    id: string;
    kind: LinkKind;
    name: string;
    endpoints: Endpoint[];
}

export interface LinkInput {
    kind?: LinkKind;
    name?: string;
    endpoints?: Endpoint[];
}

// Runtime view per link: bytes carried (uart) and the level driven onto the targets (gpio, null = released).
export interface LinkStats {
    bytes: number;
    level: boolean | null;
}

const UART_RE = /^(usart[1-6]|uart[45])$/;
const PIN_RE = /^P([A-I])(\d{1,2})$/;
const STATS_INTERVAL_MS = 500;

function parsePin(port: string): { port: string; pin: number } {
    const m = PIN_RE.exec(port);
    return { port: m![1], pin: Number(m![2]) };
}

function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
    return a.instance === b.instance && a.port === b.port;
}

export class LinkManager extends EventEmitter {
    private links: Link[] = [];
    private stats = new Map<string, LinkStats>();
    private statsDirty = false;

    constructor(private instances: InstanceManager) {
        super();
    }

    private get file(): string {
        return path.join(config.dataDir, 'links.json');
    }

    load(): void {
        if (fs.existsSync(this.file)) {
            this.links = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        }
        setInterval(() => {
            if (this.statsDirty) {
                this.statsDirty = false;
                this.emit('stats', this.statsJSON());
            }
        }, STATS_INTERVAL_MS);
    }

    list(): Link[] {
        return this.links;
    }

    statsJSON(): Record<string, LinkStats> {
        const out: Record<string, LinkStats> = {};
        for (const l of this.links) {
            out[l.id] = this.statsOf(l.id);
        }
        return out;
    }

    create(input: LinkInput): Link {
        const link: Link = {
            id: `link-${crypto.randomBytes(3).toString('hex')}`,
            kind: input.kind as LinkKind,
            name: (input.name || '').slice(0, 60),
            endpoints: [],
        };
        link.endpoints = this.validate(link, input.endpoints);
        this.links.push(link);
        this.commit(link, []);
        return link;
    }

    update(id: string, input: LinkInput): Link {
        const link = this.mustGet(id);
        const before = link.endpoints;
        if (input.name !== undefined) {
            link.name = String(input.name).slice(0, 60);
        }
        if (input.endpoints !== undefined) {
            link.endpoints = this.validate(link, input.endpoints);
        }
        this.commit(link, before);
        return link;
    }

    remove(id: string): void {
        const link = this.mustGet(id);
        this.links = this.links.filter((l) => l !== link);
        if (link.kind === 'gpio') {
            this.releaseTargets(link.endpoints.slice(1));
        }
        this.stats.delete(id);
        this.save();
        this.emit('changed');
    }

    // Drops an instance's endpoints; links left with fewer than two (or a gpio link without its driver) go.
    removeInstance(instanceId: string): void {
        let changed = false;
        for (const link of [...this.links]) {
            const kept = link.endpoints.filter((e) => e.instance !== instanceId);
            if (kept.length === link.endpoints.length) {
                continue;
            }
            changed = true;
            const lostDriver = link.kind === 'gpio' && link.endpoints[0].instance === instanceId;
            if (kept.length < 2 || lostDriver) {
                this.links = this.links.filter((l) => l !== link);
                this.stats.delete(link.id);
                if (link.kind === 'gpio') {
                    this.releaseTargets(kept.slice(lostDriver ? 0 : 1));
                }
            } else {
                link.endpoints = kept;
            }
        }
        if (changed) {
            this.save();
            this.emit('changed');
        }
    }

    attach(inst: Instance): void {
        inst.on('uart', (uart: string, data: Buffer) => this.onUart(inst, uart, data));
        inst.on('state', () => this.driveFrom(inst.id));
        inst.on('status', (status: string) => {
            if (status === 'running') {
                this.reapplyTo(inst.id);
            }
            this.driveFrom(inst.id);
        });
    }

    private validate(link: Link, endpoints: Endpoint[] | undefined): Endpoint[] {
        if (link.kind !== 'uart' && link.kind !== 'gpio') {
            throw new Error("kind must be 'uart' or 'gpio'");
        }
        if (!Array.isArray(endpoints) || endpoints.length < 2) {
            throw new Error('a link needs at least two endpoints');
        }
        const out: Endpoint[] = [];
        for (const e of endpoints) {
            const instance = String(e?.instance || '');
            if (!this.instances.get(instance)) {
                throw new Error(`unknown instance ${instance}`);
            }
            let port = String(e?.port || '').trim();
            if (link.kind === 'uart') {
                port = port.toLowerCase();
                if (!UART_RE.test(port)) {
                    throw new Error(`${port} is not a UART (usart1-6, uart4-5)`);
                }
            } else {
                port = port.toUpperCase();
                const m = PIN_RE.exec(port);
                if (!m || Number(m[2]) > 15) {
                    throw new Error(`${port} is not a pin (PA0..PI15)`);
                }
                port = `P${m[1]}${Number(m[2])}`;
            }
            const ep = { instance, port };
            if (out.some((o) => sameEndpoint(o, ep))) {
                throw new Error(`${instance} ${port} is listed twice`);
            }
            const other = this.links.find((l) => l !== link && l.endpoints.some((o) => sameEndpoint(o, ep)));
            if (other) {
                throw new Error(`${instance} ${port} is already in ${other.name || other.id}`);
            }
            out.push(ep);
        }
        return out;
    }

    private commit(link: Link, before: Endpoint[]): void {
        if (link.kind === 'gpio') {
            const targets = link.endpoints.slice(1);
            // Pins that left the link stop being driven; the current targets get the driver's level.
            this.releaseTargets(before.filter((b) => !targets.some((e) => sameEndpoint(e, b))));
            const level = this.driverLevel(link);
            this.stats.set(link.id, { ...this.statsOf(link.id), level });
            this.statsDirty = true;
            targets.forEach((e) => this.setPin(e, level));
        }
        this.save();
        this.emit('changed');
    }

    private statsOf(id: string): LinkStats {
        return this.stats.get(id) || { bytes: 0, level: null };
    }

    private onUart(from: Instance, uart: string, data: Buffer): void {
        const link = this.links.find((l) => l.kind === 'uart' && l.endpoints.some((e) => e.instance === from.id && e.port === uart));
        if (!link) {
            return;
        }
        for (const e of link.endpoints) {
            if (e.instance !== from.id || e.port !== uart) {
                this.instances.get(e.instance)?.sendConsole(e.port, data);
            }
        }
        const s = this.statsOf(link.id);
        this.stats.set(link.id, { ...s, bytes: s.bytes + data.length });
        this.statsDirty = true;
    }

    // Level the driver puts on the wire: its pin level while the pin is an output, else released.
    private driverLevel(link: Link): boolean | null {
        const src = this.instances.get(link.endpoints[0].instance);
        if (!src || src.status !== 'running' || !src.state?.pins) {
            return null;
        }
        const { port, pin } = parsePin(link.endpoints[0].port);
        const isOut = ((src.state.out?.[port] ?? 0) >> pin) & 1;
        return isOut ? (((src.state.pins[port] ?? 0) >> pin) & 1) === 1 : null;
    }

    private driveFrom(instanceId: string): void {
        for (const link of this.links) {
            if (link.kind !== 'gpio' || link.endpoints[0].instance !== instanceId) {
                continue;
            }
            const level = this.driverLevel(link);
            const s = this.statsOf(link.id);
            if (s.level === level) {
                continue;
            }
            this.stats.set(link.id, { ...s, level });
            this.statsDirty = true;
            for (const e of link.endpoints.slice(1)) {
                this.setPin(e, level);
            }
        }
    }

    // An instance (re)started: put back what the links drive into it.
    private reapplyTo(instanceId: string): void {
        for (const link of this.links) {
            if (link.kind !== 'gpio') {
                continue;
            }
            const level = this.statsOf(link.id).level;
            for (const e of link.endpoints.slice(1)) {
                if (e.instance === instanceId) {
                    this.setPin(e, level ?? null);
                }
            }
        }
    }

    private releaseTargets(endpoints: Endpoint[]): void {
        for (const e of endpoints) {
            if (PIN_RE.test(e.port)) {
                this.setPin(e, null);
            }
        }
    }

    private setPin(e: Endpoint, level: boolean | null): void {
        const inst = this.instances.get(e.instance);
        if (inst && inst.status === 'running') {
            const { port, pin } = parsePin(e.port);
            inst.setPin(port, pin, level);
        }
    }

    private mustGet(id: string): Link {
        const link = this.links.find((l) => l.id === id);
        if (!link) {
            throw Object.assign(new Error('link not found'), { status: 404 });
        }
        return link;
    }

    private save(): void {
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.links, null, 2));
    }
}

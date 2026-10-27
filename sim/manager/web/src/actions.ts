import { api } from './api';
import { DEVICE_GAP, deviceWidth, moveDevice } from './scene';
import { loadMonitors, notify } from './store';
import type { FieldDevice, FieldKind, Generation, Instance, Link, LinkKind, TermRef } from './types';

// Calls whose failure is shown as a notice rather than handled by the caller.
const guard = async <T>(p: Promise<T>): Promise<T | undefined> => {
    try {
        return await p;
    } catch (e: any) {
        notify(e.message);
        return undefined;
    }
};

export type InstanceAction = 'start' | 'stop' | 'restart' | 'reflash' | 'reset';

export const act = (id: string, action: InstanceAction) => guard(api('POST', `/api/instances/${id}/${action}`));

export const removeInstance = (inst: Instance) => guard(api('DELETE', `/api/instances/${inst.id}`));

export const resetMonitor = (id: string) => guard(api('DELETE', `/api/instances/${id}/monitor`));

export const setDebugPrint = (id: string, attached: boolean) => guard(api('PUT', `/api/instances/${id}/debug-print`, { attached }));

export const renameInstance = (id: string, name: string) => guard(api('PATCH', `/api/instances/${id}`, { name }));

export async function removeMonitor(gen: Generation) {
    await guard(api('DELETE', `/api/monitors/${gen}`));
    loadMonitors();
}

export async function setMonitor(gen: Generation, name: string, bin: string) {
    await guard(api('PUT', `/api/monitors/${gen}`, { name, bin }));
    loadMonitors();
}

// ---- links ----
const PIN_RE = /^P([A-I])(\d{1,2})$/;

export function normPort(kind: LinkKind, port: string) {
    port = String(port || '').trim();
    if (kind === 'uart') return port.toLowerCase();
    const m = PIN_RE.exec(port.toUpperCase());
    return m ? `P${m[1]}${Number(m[2])}` : port.toUpperCase();
}

export const isPin = (port: string) => {
    const m = PIN_RE.exec(port);
    return !!m && Number(m[2]) <= 15;
};

export interface PortRef {
    instance: string;
    port: string;
    kind: LinkKind;
}

const sameEp = (a: { instance: string; port: string }, b: { instance: string; port: string }) => a.instance === b.instance && a.port === b.port;

// Joins two ports. UART: both end up on one bus (buses merge). GPIO: the first port drives the
// second; a pin already driven, or a target used as a source, is refused. Throws a readable error.
export async function connectPorts(links: Link[], nameOf: (id: string) => string, a: PortRef, b: PortRef) {
    if (a.kind !== b.kind) throw new Error('Connect a UART to a UART, and a pin to a pin.');
    const ea = { instance: a.instance, port: normPort(a.kind, a.port) };
    const eb = { instance: b.instance, port: normPort(b.kind, b.port) };
    if (sameEp(ea, eb)) return;
    const linkOf = (ep: typeof ea) => links.find((l) => l.endpoints.some((e) => sameEp(e, ep)));
    const la = linkOf(ea);
    const lb = linkOf(eb);
    if (a.kind === 'uart') {
        if (la && la === lb) return;
        if (la && lb) {
            await api('DELETE', `/api/links/${lb.id}`);
            await api('PATCH', `/api/links/${la.id}`, { endpoints: [...la.endpoints, ...lb.endpoints] });
        } else if (la) {
            await api('PATCH', `/api/links/${la.id}`, { endpoints: [...la.endpoints, eb] });
        } else if (lb) {
            await api('PATCH', `/api/links/${lb.id}`, { endpoints: [...lb.endpoints, ea] });
        } else {
            await api('POST', '/api/links', { kind: 'uart', endpoints: [ea, eb] });
        }
        return;
    }
    if (lb) throw new Error(`${nameOf(eb.instance)} ${eb.port} is already wired. Drag from the driving pin to a free pin.`);
    if (la && !sameEp(la.endpoints[0], ea)) throw new Error(`${nameOf(ea.instance)} ${ea.port} is driven by another pin. Drag from the driver instead.`);
    if (la) await api('PATCH', `/api/links/${la.id}`, { endpoints: [...la.endpoints, eb] });
    else await api('POST', '/api/links', { kind: 'gpio', endpoints: [ea, eb] });
}

// Drops one endpoint; a link left with one end, or a GPIO wire losing its driver, is deleted.
export async function removeWire(link: Link, ep: number) {
    const rest = link.endpoints.filter((_, i) => i !== ep);
    try {
        if (rest.length < 2 || (link.kind === 'gpio' && ep === 0)) await api('DELETE', `/api/links/${link.id}`);
        else await api('PATCH', `/api/links/${link.id}`, { endpoints: rest });
    } catch (e: any) {
        notify(e.message);
    }
}

export const deleteLink = (id: string) => guard(api('DELETE', `/api/links/${id}`));
export const renameLink = (id: string, name: string) => guard(api('PATCH', `/api/links/${id}`, { name }));

// ---- Tibbits, field devices, terminal wires ----
export const setTibbits = (id: string, tibbits: Record<string, string | null>) => guard(api('PUT', `/api/instances/${id}/tibbits`, { tibbits }));

export async function importTibbits(id: string, project: unknown) {
    const res = await guard(api<{ skipped: string[]; projectDevice?: string }>('POST', `/api/instances/${id}/tibbits/import`, { project }));
    if (res && res.skipped.length) notify(`Imported, but skipped: ${res.skipped.join('; ')}`, 'info');
    return res;
}

export const addFieldDevice = (kind: FieldKind, place?: { rail: string; x: number }) =>
    guard(
        api<FieldDevice>('POST', '/api/devices', { kind }).then((d) => {
            if (place) moveDevice(d.id, place.rail, place.x);
            return d;
        }),
    );
export const patchFieldDevice = (id: string, body: { name?: string; props?: Record<string, unknown> }) => guard(api('PATCH', `/api/devices/${id}`, body));
export const removeFieldDevice = (id: string) => guard(api('DELETE', `/api/devices/${id}`));
export const swipeCard = (id: string, body: Record<string, unknown> = {}) => guard(api('POST', `/api/devices/${id}/swipe`, body));

export const wireTerminals = (a: TermRef, b: TermRef) => guard(api('POST', '/api/wires', { a, b }));
export const removeTerminalWire = (id: string) => guard(api('DELETE', `/api/wires/${id}`));

// ---- creating ----
// Creates instances; each lands where `place` says (a rail and x), or at the end of the first
// rail with room.
export async function createInstances(body: Record<string, unknown>, place?: { rail: string; x: number }): Promise<Instance[]> {
    const created = await api<Instance[]>('POST', '/api/instances', body);
    if (place) {
        let x = place.x;
        for (const inst of created) {
            moveDevice(inst.id, place.rail, x);
            x += deviceWidth(inst) + DEVICE_GAP;
        }
    }
    return created;
}

import { useEffect, useRef, useState } from 'react';
import { padPoint, type Scene } from '../scene';
import type { Instance, Link, LinkKind, LinkStats } from '../types';

interface Pt {
    x: number;
    y: number;
}

export interface WireSel {
    link: string;
    ep: number;
}

// A wire's colour comes from its id, so it keeps it as others come and go.
const PALETTE = ['#e5484d', '#f5a524', '#3dd68c', '#3b9eff', '#a78bfa', '#ec6cb9', '#2dd4bf', '#c4b454'];
export const colorOf = (id: string) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
};

// Both ends leave their terminal downwards, so a wire hangs below the rail like a patch cable.
export function hang(a: Pt, b: Pt, lane: number) {
    const drop = 70 + Math.min(Math.abs(b.x - a.x) * 0.22, 150) + lane * 10;
    const d = `M${a.x},${a.y} C${a.x},${a.y + drop} ${b.x},${b.y + drop} ${b.x},${b.y}`;
    // The cubic at t = 0.5.
    const mid = { x: (a.x + b.x) / 2, y: (a.y + 3 * (a.y + drop) + 3 * (b.y + drop) + b.y) / 8 };
    return { d, mid };
}

// A bus member runs down from its terminal and into the junction sideways.
function toJunction(a: Pt, j: Pt) {
    const d = `M${a.x},${a.y} C${a.x},${j.y} ${a.x + (j.x - a.x) * 0.5},${j.y} ${j.x},${j.y}`;
    return { d, mid: { x: (a.x + 3 * a.x + 3 * (a.x + (j.x - a.x) * 0.5) + j.x) / 8, y: (a.y + 3 * j.y + 3 * j.y + j.y) / 8 } };
}

interface Seg {
    d: string;
    mid: Pt;
    ep: number;
    end?: Pt; // where a GPIO arrow points
}

function segmentsOf(link: Link, scene: Scene, lane: number): { segs: Seg[]; junction?: Pt } {
    const pts = link.endpoints.map((e) => padPoint(scene, e.instance, e.port, link.kind));
    const segs: Seg[] = [];
    if (link.kind === 'gpio' || link.endpoints.length === 2) {
        const src = pts[0];
        if (!src) return { segs };
        for (let i = 1; i < pts.length; i++) {
            const t = pts[i];
            if (!t) continue;
            segs.push({ ...hang(src, t, lane), ep: i, end: link.kind === 'gpio' ? t : undefined });
        }
        return { segs };
    }
    const placed = pts.filter(Boolean) as Pt[];
    if (placed.length < 2) return { segs };
    const j = { x: placed.reduce((s, p) => s + p.x, 0) / placed.length, y: Math.max(...placed.map((p) => p.y)) + 95 + lane * 10 };
    pts.forEach((p, i) => {
        if (p) segs.push({ ...toJunction(p, j), ep: i });
    });
    return { segs, junction: j };
}

const linkTitle = (link: Link, nameOf: (id: string) => string) => {
    const eps = link.endpoints.map((e) => `${nameOf(e.instance)} ${e.port}`);
    const what = link.kind === 'gpio' ? `${eps[0]} drives ${eps.slice(1).join(', ')}` : eps.join(' ↔ ');
    return `${link.name ? link.name + ': ' : ''}${what}`;
};

interface Props {
    scene: Scene;
    links: Link[];
    stats: Record<string, LinkStats>;
    instances: Instance[];
    selected: WireSel | null;
    temp: { from: Pt; to: Pt; kind: LinkKind } | null;
    onSelect: (sel: WireSel) => void;
    onDelete: (sel: WireSel) => void;
}

export function Wires({ scene, links, stats, instances, selected, temp, onSelect, onDelete }: Props) {
    const nameOf = (id: string) => {
        const i = instances.find((x) => x.id === id);
        return i ? i.name || i.id : id;
    };
    const status = (id: string) => (instances.find((x) => x.id === id) || ({} as Instance)).status;

    // UART wires glow for a second after traffic.
    const prev = useRef<Record<string, number>>({});
    const until = useRef<Record<string, number>>({});
    const [, bump] = useState(0);
    useEffect(() => {
        const now = Date.now();
        let any = false;
        for (const link of links) {
            const st = stats[link.id];
            if (link.kind !== 'uart' || !st) continue;
            if (prev.current[link.id] !== undefined && prev.current[link.id] !== st.bytes) {
                until.current[link.id] = now + 1000;
                any = true;
            }
            prev.current[link.id] = st.bytes;
        }
        if (!any) return;
        bump((n) => n + 1);
        const t = setTimeout(() => bump((n) => n + 1), 1050);
        return () => clearTimeout(t);
    }, [stats, links]);

    const now = Date.now();
    let delAt: Pt | null = null;
    const items = links.map((link, i) => {
        const { segs, junction } = segmentsOf(link, scene, i % 6);
        const st = stats[link.id] || { bytes: 0, level: null };
        const running = link.endpoints.every((e) => status(e.instance) === 'running');
        const color = colorOf(link.id);
        const cls = [
            'wire',
            link.kind,
            !running && 'off',
            link.kind === 'uart' && (until.current[link.id] || 0) > now && 'active',
            link.kind === 'gpio' && st.level === true && 'hi',
            link.kind === 'gpio' && st.level === null && 'z',
        ]
            .filter(Boolean)
            .join(' ');
        const title = linkTitle(link, nameOf);
        return (
            <g key={link.id} className={cls} style={{ ['--wc' as string]: color }}>
                {segs.map((s) => {
                    const sel = !!selected && selected.link === link.id && selected.ep === s.ep;
                    if (sel) delAt = s.mid;
                    return (
                        <g key={s.ep} className={sel ? 'sel' : undefined}>
                            <path className="wire-line" d={s.d} />
                            {s.end && <path className="wire-arrow" d={`M${s.end.x},${s.end.y + 6} l-5,10 h10 z`} />}
                            <path className="wire-hit" d={s.d} data-nopan onPointerDown={(e) => { e.stopPropagation(); onSelect({ link: link.id, ep: s.ep }); }}>
                                <title>{title}</title>
                            </path>
                        </g>
                    );
                })}
                {link.endpoints.map((e, k) => {
                    const p = padPoint(scene, e.instance, e.port, link.kind);
                    return p ? <circle key={k} className="wire-end" cx={p.x} cy={p.y} r={5} /> : null;
                })}
                {junction && <circle className="wire-junction" cx={junction.x} cy={junction.y} r={6} data-link={link.id} />}
            </g>
        );
    });

    const hangTemp = temp ? hang(temp.from, temp.to, 0).d : null;
    const del = delAt as Pt | null;
    return (
        <svg className="wires" width={1} height={1} style={{ overflow: 'visible' }}>
            {items}
            {temp && hangTemp && <path className={`wire-line temp ${temp.kind}`} d={hangTemp} />}
            {selected && del && (
                <g className="wire-del" transform={`translate(${del.x},${del.y})`} data-nopan onPointerDown={(e) => { e.stopPropagation(); onDelete(selected); }}>
                    <title>Remove this wire (Delete)</title>
                    <circle r={11} />
                    <path d="M-4,-4 L4,4 M4,-4 L-4,4" />
                </g>
            )}
        </svg>
    );
}

import { termPoint, type Scene } from '../scene';
import type { FieldDevice, Instance, Wire, WiringWarning } from '../types';
import { colorOf, hang } from './Wires';

interface Pt {
    x: number;
    y: number;
    dir?: 1 | -1;
    span?: { l: number; r: number };
}

interface Props {
    scene: Scene;
    wires: Wire[];
    warnings: WiringWarning[];
    items: Array<Instance | FieldDevice>;
    selected: string | null;
    temp: { from: Pt; to: Pt } | null;
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
}

// Wires between terminals. Like the pin wires they leave their terminal downwards and hang below the rail
// (upwards from a top-edge terminal).
export function TermWires({ scene, wires, warnings, items, selected, temp, onSelect, onDelete }: Props) {
    const warned = new Set(warnings.flatMap((w) => w.wires));
    const name = (owner: string) => {
        const o = items.find((i) => i.id === owner);
        return o ? o.name || o.id : owner;
    };
    let delAt: Pt | null = null;
    const label = (w: Wire, side: 'a' | 'b') => {
        const dev = scene.byId.get(w[side].owner);
        const term = dev && dev.geom.blocks.flatMap((b) => b.terms).find((t) => t.id === w[side].term);
        return `${name(w[side].owner)} ${term ? term.label || term.n : w[side].term}`;
    };
    const items2 = wires.map((w, i) => {
        const a = termPoint(scene, w.a.owner, w.a.term);
        const b = termPoint(scene, w.b.owner, w.b.term);
        if (!a || !b) return null;
        const { d, mid } = hang(a, b, i % 6, a.dir, b.dir, a.dir === -1 ? a.span : b.span);
        const sel = selected === w.id;
        if (sel) delAt = mid;
        return (
            <g key={w.id} className={`twire${warned.has(w.id) ? ' warn' : ''}${sel ? ' sel' : ''}`} style={{ ['--wc' as string]: colorOf(w.id) }}>
                <path className="wire-line" d={d} />
                <circle className="wire-end" cx={a.x} cy={a.y} r={4.5} />
                <circle className="wire-end" cx={b.x} cy={b.y} r={4.5} />
                <path className="wire-hit" d={d} data-nopan onPointerDown={(e) => { e.stopPropagation(); onSelect(w.id); }}>
                    <title>{`${label(w, 'a')} ↔ ${label(w, 'b')}${warned.has(w.id) ? '\n⚠ see the wiring warnings' : ''}`}</title>
                </path>
            </g>
        );
    });
    const del = delAt as Pt | null;
    return (
        <svg className="wires" width={1} height={1} style={{ overflow: 'visible' }}>
            {items2}
            {temp && <path className="wire-line temp" d={hang(temp.from, temp.to, 0, temp.from.dir, 1, temp.from.span).d} />}
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

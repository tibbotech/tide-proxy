import { memo, useMemo } from 'react';
import { patchFieldDevice, removeFieldDevice, swipeCard } from '../actions';
import { FIELD_BODY_H, HEAD_H, type DeviceGeom, type PlacedTerm } from '../scene';
import { useInstanceState, useWiring } from '../store';
import type { FieldDevice, TermRef, Wire } from '../types';
import { wiredKeys } from './Device';
import { Icon } from './icons';
import { TerminalBlock } from './Terminals';

interface Props {
    field: FieldDevice;
    geom: DeviceGeom;
    x: number;
    y: number;
    selected: boolean;
    dragging: boolean;
    termWires: Wire[];
    termDrag: TermRef | null;
    onTermDown: (e: React.PointerEvent, t: PlacedTerm) => void;
    onSelect: (id: string) => void;
    onMoveStart: (e: React.PointerEvent, id: string) => void;
}

export const formatLine = (p: Record<string, any>) => (p.format === 'raw' ? `raw ${String(p.bits || '').length} bits` : `${p.format}-bit · facility ${p.facility} · card ${p.card}`);

function Reader({ field }: { field: FieldDevice }) {
    return (
        <div className="fd-body reader">
            <svg viewBox="0 0 120 70" width="120" height="70" aria-hidden="true">
                <rect x="10" y="4" width="100" height="62" rx="8" className="fd-shell" />
                <rect x="24" y="30" width="72" height="8" rx="3" className="fd-slot" />
                <circle cx="95" cy="16" r="4" className="fd-led" />
                <rect x="24" y="12" width="40" height="8" rx="2" className="fd-slot" opacity="0.5" />
            </svg>
            <span className="muted small-print">{formatLine(field.props)}</span>
            <button className="btn small primary" onPointerDown={(e) => e.stopPropagation()} onClick={() => swipeCard(field.id)}>
                Swipe card
            </button>
        </div>
    );
}

function Slave({ field }: { field: FieldDevice }) {
    const regs: any[] = field.props.registers || [];
    const last = field.activity.slice(-2);
    return (
        <div className="fd-body slave">
            <div className="fd-line">
                <strong>Unit {field.props.unit}</strong>
                <span className="muted">{regs.length} registers</span>
            </div>
            <div className="fd-activity">
                {last.length ? last.map((l, i) => <div key={i}>{l}</div>) : <span className="muted">no requests yet</span>}
            </div>
        </div>
    );
}

function Lamp({ id, term, own }: { id: string; term: string; own: number | null }) {
    const wiring = useWiring();
    const peers = wiring.pins[`${id}/${term}`] || [];
    const first = peers[0];
    const state = useInstanceState(first ? first.instance : '');
    let level: boolean | null = own === null ? null : own === 1;
    const m = first && /^P([A-I])(\d+)$/.exec(first.port);
    if (m && state && state.pins) {
        const bit = 1 << Number(m[2]);
        const out = (((state.out || {})[m[1]] || 0) & bit) !== 0;
        if (out || own === null) level = ((state.pins[m[1]] || 0) & bit) !== 0;
    }
    return <span className={`lamp${level ? ' on' : ''}`} title={level === null ? 'floating' : level ? 'high' : 'low'} />;
}

function Panel({ field }: { field: FieldDevice }) {
    const channels: Array<number | null> = field.props.channels || [null, null, null, null];
    const set = (i: number) => {
        const next = [...channels];
        // released -> low -> high -> released
        next[i] = channels[i] === null ? 0 : channels[i] === 0 ? 1 : null;
        patchFieldDevice(field.id, { props: { channels: next } });
    };
    return (
        <div className="fd-body panel">
            {channels.map((c, i) => (
                <div className="chan" key={i}>
                    <Lamp id={field.id} term={`C${i + 1}`} own={c} />
                    <button className={`switch${c === null ? ' z' : c ? ' hi' : ' lo'}`} title="Click: released, low, high" onPointerDown={(e) => e.stopPropagation()} onClick={() => set(i)}>
                        {c === null ? 'Z' : c}
                    </button>
                    <span className="muted small-print">{i + 1}</span>
                </div>
            ))}
        </div>
    );
}

export const FieldDeviceView = memo(function FieldDeviceView({ field, geom, x, y, selected, dragging, termWires, termDrag, onTermDown, onSelect, onMoveStart }: Props) {
    const wired = useMemo(() => wiredKeys(termWires), [termWires]);
    return (
        <div
            className={`device field ${field.kind}${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
            style={{ left: x, top: y, width: geom.w, height: geom.h }}
            data-nopan
            onPointerDown={() => onSelect(field.id)}
        >
            <div className="nameplate" style={{ height: HEAD_H }} onPointerDown={(e) => onMoveStart(e, field.id)} title="Drag to move along the rail">
                <strong className="np-name">{field.name}</strong>
                <span className="spacer" />
                <button className="icon-btn danger" title="Remove this device" onPointerDown={(e) => e.stopPropagation()} onClick={() => confirm(`Remove ${field.name}?`) && removeFieldDevice(field.id)}>
                    <Icon name="trash" />
                </button>
            </div>
            <div className="fd-face" style={{ height: FIELD_BODY_H }}>
                {field.kind === 'wiegand-reader' ? <Reader field={field} /> : field.kind === 'modbus-slave' ? <Slave field={field} /> : <Panel field={field} />}
            </div>
            {geom.blocks.map((b) => (
                <TerminalBlock key={b.id} block={b} wired={wired} dragging={termDrag} onDown={onTermDown} />
            ))}
        </div>
    );
});

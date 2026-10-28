import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { addFieldDevice, createInstances, removeTerminalWire, removeWire, wireTerminals } from '../actions';
import { loadLocal, saveLocal } from '../local';
import {
    ensurePlacements, addRail, BOARD_MIME, buildScene, commitMove, deviceWidthForBoard, FACE_H, FIELD_MIME, FIELD_W, HEAD_H, layoutStore, railBandY, railXFor, RAIL_BAND, RAIL_TOP, removeRail, snap, termPoint,
    type DragPreview, type PlacedTerm,
} from '../scene';
import { getLinks, getPlaceables, notify, useConnected, useInstances, useLinks, useLinkStats, usePlaceables, useWiring } from '../store';
import type { FieldKind, TermRef } from '../types';
import { Device } from './Device';
import { FieldDeviceView } from './FieldDeviceView';
import { Icon } from './icons';
import { TermWires } from './TermWires';
import { LinkWires, type WireSel } from './Wires';

interface View {
    x: number;
    y: number;
    k: number;
}

interface Pt {
    x: number;
    y: number;
}

export interface WorkspaceHandle {
    fit(): void;
    focus(id: string): void;
}

interface Props {
    selected: string | null;
    onSelect: (id: string | null) => void;
    onAddDevice: () => void;
}

const MIN_K = 0.15;
const MAX_K = 2.5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const Workspace = forwardRef<WorkspaceHandle, Props>(function Workspace({ selected, onSelect, onAddDevice }, ref) {
    const instances = useInstances();
    const items = usePlaceables();
    const wiring = useWiring();
    const links = useLinks();
    const stats = useLinkStats();
    const layout = layoutStore.use();
    const connected = useConnected();

    const vp = useRef<HTMLDivElement>(null);
    const saved = useRef(loadLocal<View | null>('sim.view', null));
    const [view, setView] = useState<View>(saved.current || { x: 100, y: 20, k: 0.8 });
    const [drag, setDrag] = useState<DragPreview | null>(null);
    const [selTWire, setSelTWire] = useState<string | null>(null);
    const [selLink, setSelLink] = useState<WireSel | null>(null);
    const [termWire, setTermWire] = useState<{ from: TermRef; start: Pt; cursor: Pt } | null>(null);
    const [panning, setPanning] = useState(false);

    useEffect(() => ensurePlacements(items), [items, layout.rails.length]);

    const scene = useMemo(() => buildScene(layout, items, links, drag), [layout, items, links, drag]);

    // Handlers below are stable (they are props of memoised devices) and read the latest through refs.
    const viewRef = useRef(view);
    viewRef.current = view;
    const sceneRef = useRef(scene);
    sceneRef.current = scene;
    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;

    const toWorld = useCallback((cx: number, cy: number): Pt => {
        const r = vp.current!.getBoundingClientRect();
        const v = viewRef.current;
        return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k };
    }, []);

    // The rail a device whose top edge is at `top` would sit on.
    const railForTop = useCallback((top: number) => {
        const rails = sceneRef.current.rails;
        return rails.reduce((best, r) => (Math.abs(r.top - top) < Math.abs(best.top - top) ? r : best), rails[0]);
    }, []);

    // ---- view ----
    const fit = useCallback(() => {
        const el = vp.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const devs = sceneRef.current.devices;
        const box = devs.length
            ? {
                x0: Math.min(...devs.map((d) => d.x)) - 60,
                y0: Math.min(...devs.map((d) => d.y)) - 40,
                x1: Math.max(...devs.map((d) => d.x + d.geom.w)) + 60,
                y1: Math.max(...devs.map((d) => d.y + d.geom.h)) + 150,
            }
            : { x0: -40, y0: RAIL_TOP - 20, x1: 960, y1: RAIL_TOP + 500 };
        const k = clamp(Math.min(r.width / (box.x1 - box.x0), r.height / (box.y1 - box.y0)), MIN_K, 1);
        setView({ k, x: (r.width - (box.x1 - box.x0) * k) / 2 - box.x0 * k, y: (r.height - (box.y1 - box.y0) * k) / 2 - box.y0 * k });
    }, []);

    useImperativeHandle(
        ref,
        () => ({
            fit,
            focus(id) {
                const dev = sceneRef.current.byId.get(id);
                const el = vp.current;
                if (!dev || !el) return;
                const r = el.getBoundingClientRect();
                const v = viewRef.current;
                // Already in view: leave the canvas where it is.
                const left = v.x + dev.x * v.k;
                const top = v.y + dev.y * v.k;
                if (left >= 16 && left + dev.geom.w * v.k <= r.width - 16 && top >= 16 && top + dev.geom.h * v.k <= r.height - 16) return;
                const k = Math.max(v.k, 0.6);
                setView({ k, x: r.width / 2 - (dev.x + dev.geom.w / 2) * k, y: r.height / 2 - (dev.y + dev.geom.h / 2) * k });
            },
        }),
        [fit],
    );

    const didFit = useRef(false);
    useEffect(() => {
        if (didFit.current || !scene.devices.length) return;
        didFit.current = true;
        if (!saved.current) fit();
    }, [scene.devices.length, fit]);

    useEffect(() => {
        const t = setTimeout(() => saveLocal('sim.view', view), 300);
        return () => clearTimeout(t);
    }, [view]);

    const zoomAt = useCallback((px: number, py: number, factor: number) => {
        const v = viewRef.current;
        const k = clamp(v.k * factor, MIN_K, MAX_K);
        setView({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k });
    }, []);

    useEffect(() => {
        const el = vp.current!;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const r = el.getBoundingClientRect();
            zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [zoomAt]);

    const zoomButton = (factor: number) => {
        const r = vp.current!.getBoundingClientRect();
        zoomAt(r.width / 2, r.height / 2, factor);
    };

    // ---- panning ----
    const onViewportDown = (e: React.PointerEvent) => {
        if ((e.target as Element).closest('[data-nopan]') || (e.button !== 0 && e.button !== 1)) return;
        e.preventDefault();
        const sx = e.clientX;
        const sy = e.clientY;
        const v0 = viewRef.current;
        let moved = false;
        const move = (ev: PointerEvent) => {
            if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
            if (!moved) setPanning(true);
            moved = true;
            setView({ ...v0, x: v0.x + ev.clientX - sx, y: v0.y + ev.clientY - sy });
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            setPanning(false);
            if (!moved) {
                onSelectRef.current(null);
                setSelTWire(null);
                setSelLink(null);
            }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    // ---- moving a device along the rails ----
    const onSelectDevice = useCallback((id: string) => {
        setSelTWire(null);
        setSelLink(null);
        onSelectRef.current(id);
    }, []);

    const onMoveStart = useCallback(
        (e: React.PointerEvent, id: string) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const dev = sceneRef.current.byId.get(id);
            if (!dev) return;
            const sx = e.clientX;
            const sy = e.clientY;
            const p0 = toWorld(sx, sy);
            const x0 = dev.x;
            const w = dev.geom.w;
            let last: DragPreview | null = null;
            const move = (ev: PointerEvent) => {
                if (!last && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
                const p = toWorld(ev.clientX, ev.clientY);
                const rail = railForTop(dev.y + dev.geom.faceY - HEAD_H + p.y - p0.y);
                const x = snap(x0 + p.x - p0.x);
                last = { id, rail: rail.id, x };
                setDrag(last);
            };
            const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                if (last) commitMove(getPlaceables(), id, last.rail, last.x);
                setDrag(null);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        },
        [toWorld, railForTop],
    );

    // ---- drawing a wire from a terminal block ----
    const onTermDown = useCallback(
        (e: React.PointerEvent, t: PlacedTerm) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            const start = termPoint(sceneRef.current, t.owner, t.id);
            if (!start) return;
            const from: TermRef = { owner: t.owner, term: t.id };
            setSelTWire(null);
            setSelLink(null);
            setTermWire({ from, start, cursor: start });
            const move = (ev: PointerEvent) => setTermWire((w) => (w ? { ...w, cursor: toWorld(ev.clientX, ev.clientY) } : w));
            const up = (ev: PointerEvent) => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                setTermWire(null);
                const target = (document.elementFromPoint(ev.clientX, ev.clientY) as Element | null)?.closest<HTMLElement>('[data-term]');
                if (!target || !target.dataset.owner || !target.dataset.term) return;
                if (target.dataset.owner === from.owner && target.dataset.term === from.term) return;
                wireTerminals(from, { owner: target.dataset.owner, term: target.dataset.term });
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        },
        [toWorld],
    );

    const deleteTWire = useCallback((id: string) => {
        setSelTWire(null);
        removeTerminalWire(id);
    }, []);

    const deleteLink = useCallback((sel: WireSel) => {
        const link = getLinks().find((l) => l.id === sel.link);
        setSelLink(null);
        if (link) removeWire(link, sel.ep);
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((!selTWire && !selLink) || (e.target as Element).closest('input, select, textarea')) return;
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                if (selTWire) deleteTWire(selTWire);
                else if (selLink) deleteLink(selLink);
            } else if (e.key === 'Escape') {
                setSelTWire(null);
                setSelLink(null);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [selTWire, selLink, deleteTWire, deleteLink]);

    // ---- dropping a board from the catalog ----
    const onDragOver = (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(BOARD_MIME) && !e.dataTransfer.types.includes(FIELD_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e: React.DragEvent) => {
        const kind = e.dataTransfer.getData(FIELD_MIME);
        if (kind) {
            e.preventDefault();
            const p = toWorld(e.clientX, e.clientY);
            const rail = railForTop(p.y - HEAD_H - FACE_H / 2);
            addFieldDevice(kind as FieldKind, { rail: rail.id, x: railXFor(getPlaceables(), rail.id, p.x - FIELD_W / 2, FIELD_W) });
            return;
        }
        const board = e.dataTransfer.getData(BOARD_MIME);
        if (!board) return;
        e.preventDefault();
        const p = toWorld(e.clientX, e.clientY);
        const rail = railForTop(p.y - HEAD_H - FACE_H / 2);
        const w = deviceWidthForBoard(board);
        createInstances({ board }, { rail: rail.id, x: railXFor(getPlaceables(), rail.id, p.x - w / 2, w) }).catch((err) => notify(err.message));
    };

    const tempTermWire = termWire ? { from: termWire.start, to: termWire.cursor } : null;
    const termDrag = useMemo(() => (termWire ? termWire.from : null), [termWire && termWire.from]);
    const gridSize = 24 * view.k;

    return (
        <div
            ref={vp}
            className={`workspace${panning ? ' panning' : ''}${termWire ? ' wiring-term' : ''}`}
            style={{ backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
            onPointerDown={onViewportDown}
            onDragOver={onDragOver}
            onDrop={onDrop}
        >
            <div className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
                <svg className="rails" width={1} height={1} style={{ overflow: 'visible' }}>
                    {scene.rails.map((r) => {
                        const y = railBandY(r);
                        return (
                            <g key={r.id}>
                                <defs>
                                    <linearGradient id={`metal-${r.id}`} x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0" stopColor="var(--rail-hi)" />
                                        <stop offset="0.5" stopColor="var(--rail-mid)" />
                                        <stop offset="1" stopColor="var(--rail-lo)" />
                                    </linearGradient>
                                    <pattern id={`slots-${r.id}`} x={-60} y={y} width={30} height={RAIL_BAND} patternUnits="userSpaceOnUse">
                                        <rect x={6} y={RAIL_BAND / 2 - 5} width={18} height={10} rx={5} fill="var(--rail-slot)" />
                                    </pattern>
                                </defs>
                                <rect x={-60} y={y} width={r.x1 + 60} height={RAIL_BAND} rx={3} fill={`url(#metal-${r.id})`} stroke="var(--rail-edge)" />
                                <rect x={-60} y={y} width={r.x1 + 60} height={RAIL_BAND} rx={3} fill={`url(#slots-${r.id})`} />
                                <text className="rail-label" x={-52} y={y - 10}>
                                    DIN rail {r.index + 1} · TH35
                                </text>
                                {r.count === 0 && scene.rails.length > 1 && (
                                    <g className="rail-remove" transform={`translate(${r.x1 - 14},${y - 18})`} data-nopan onPointerDown={(e) => { e.stopPropagation(); removeRail(r.id); }}>
                                        <title>Remove this empty rail</title>
                                        <circle r={9} />
                                        <path d="M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5" />
                                    </g>
                                )}
                            </g>
                        );
                    })}
                </svg>

                {scene.devices.map((d) =>
                    d.field ? (
                        <FieldDeviceView
                            key={d.id}
                            field={d.field}
                            geom={d.geom}
                            x={d.x}
                            y={d.y}
                            selected={selected === d.id}
                            dragging={!!drag && drag.id === d.id}
                            termWires={wiring.wires}
                            termDrag={termDrag}
                            onTermDown={onTermDown}
                            onSelect={onSelectDevice}
                            onMoveStart={onMoveStart}
                        />
                    ) : (
                        <Device
                            key={d.id}
                            inst={d.inst!}
                            geom={d.geom}
                            x={d.x}
                            y={d.y}
                            selected={selected === d.id}
                            dragging={!!drag && drag.id === d.id}
                            termWires={wiring.wires}
                            termDrag={termDrag}
                            onTermDown={onTermDown}
                            onSelect={onSelectDevice}
                            onMoveStart={onMoveStart}
                        />
                    ),
                )}

                <LinkWires scene={scene} links={links} stats={stats} instances={instances} selected={selLink} onSelect={(sel) => { setSelTWire(null); setSelLink(sel); }} onDelete={deleteLink} />
                <TermWires scene={scene} wires={wiring.wires} warnings={wiring.warnings} items={items} selected={selTWire} temp={tempTermWire} onSelect={(id) => { setSelLink(null); setSelTWire(id); }} onDelete={deleteTWire} />
            </div>

            {wiring.warnings.length > 0 && (
                <div className="wiring-warnings" data-nopan>
                    <strong>
                        <Icon name="gear" /> Wiring warnings
                    </strong>
                    <ul>
                        {wiring.warnings.slice(0, 5).map((w, i) => (
                            <li key={i}>{w.text}</li>
                        ))}
                    </ul>
                    {wiring.warnings.length > 5 && <span className="muted">and {wiring.warnings.length - 5} more</span>}
                </div>
            )}

            {connected && instances.length === 0 && items.length === 0 && (
                <div className="empty-state" data-nopan>
                    <Icon name="chip" size={28} />
                    <h2>No devices yet</h2>
                    <p>Drag a board from the catalog onto a DIN rail, or add one here. Then upload a <code>zephyr.elf</code> (and its <code>.dts</code>) to it, or upload from TIDE through the monitor.</p>
                    <button className="btn primary" onClick={onAddDevice}>
                        Add a device
                    </button>
                </div>
            )}

            <div className="canvas-tools tl" data-nopan>
                <button className="btn small" onClick={addRail} title="Add another DIN rail">
                    <Icon name="rail" /> Add rail
                </button>
            </div>
            <div className="canvas-tools br" data-nopan>
                <button className="icon-btn" onClick={() => zoomButton(1 / 1.25)} title="Zoom out">
                    <Icon name="minus" />
                </button>
                <span className="zoom-level">{Math.round(view.k * 100)}%</span>
                <button className="icon-btn" onClick={() => zoomButton(1.25)} title="Zoom in">
                    <Icon name="plus" />
                </button>
                <button className="icon-btn" onClick={fit} title="Fit all devices">
                    <Icon name="fit" />
                </button>
            </div>
            <div className="canvas-hint" data-nopan>
                Drag a terminal to another to wire it · click a wire, then Delete · scroll to zoom
            </div>
        </div>
    );
});

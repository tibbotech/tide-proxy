import { memo, useMemo, useState } from 'react';
import { act, isPin, normPort } from '../actions';
import { extraPinsStore, HEAD_H, PAD_W, type DeviceGeom, type PlacedPad, type PlacedTerm } from '../scene';
import { notify, useInstanceState, useLinks } from '../store';
import type { Instance, InstState, LinkKind, TermRef, Wire } from '../types';
import { Faceplate } from './Faceplate';
import { Icon } from './icons';
import { TerminalBlock } from './Terminals';

export interface WireDrag {
    instance: string;
    port: string;
    kind: LinkKind;
}

interface Props {
    inst: Instance;
    geom: DeviceGeom;
    x: number;
    y: number;
    selected: boolean;
    dragging: boolean;
    wiring: WireDrag | null;
    termWires: Wire[];
    termDrag: TermRef | null;
    onTermDown: (e: React.PointerEvent, t: PlacedTerm) => void;
    onSelect: (id: string) => void;
    onMoveStart: (e: React.PointerEvent, id: string) => void;
    onPadDown: (e: React.PointerEvent, inst: Instance, pad: PlacedPad) => void;
}

export const wiredKeys = (wires: Wire[]) => {
    const keys = new Set<string>();
    for (const w of wires) {
        keys.add(`${w.a.owner}/${w.a.term}`);
        keys.add(`${w.b.owner}/${w.b.term}`);
    }
    return keys;
};

const pinState = (state: InstState | undefined, port: string) => {
    const m = /^P([A-I])(\d+)$/.exec(port);
    if (!m || !state || !state.pins) return null;
    const bit = 1 << Number(m[2]);
    return { high: ((state.pins[m[1]] || 0) & bit) !== 0, out: (((state.out || {})[m[1]] || 0) & bit) !== 0 };
};

export const Device = memo(function Device({ inst, geom, x, y, selected, dragging, wiring, termWires, termDrag, onTermDown, onSelect, onMoveStart, onPadDown }: Props) {
    const state = useInstanceState(inst.id);
    const links = useLinks();
    const running = inst.status === 'running' || inst.status === 'starting';
    const [adding, setAdding] = useState(false);
    const live = inst.status === 'running';

    const wired = useMemo(() => wiredKeys(termWires), [termWires]);
    const linked = (pad: PlacedPad) => links.some((l) => l.endpoints.some((e) => e.instance === inst.id && e.port === pad.port));

    const addPin = (value: string) => {
        const port = normPort('gpio', value);
        if (!isPin(port)) {
            notify(`${value} is not a pin (PA0..PI15)`);
            return;
        }
        const cur = extraPinsStore.get();
        const pins = cur[inst.id] || [];
        if (!pins.includes(port)) extraPinsStore.set({ ...cur, [inst.id]: [...pins, port] });
        setAdding(false);
    };
    const removePin = (port: string) => {
        const cur = extraPinsStore.get();
        extraPinsStore.set({ ...cur, [inst.id]: (cur[inst.id] || []).filter((p) => p !== port) });
    };

    return (
        <div
            className={`device ${inst.status}${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
            style={{ left: x, top: y, width: geom.w, height: geom.h }}
            data-nopan
            onPointerDown={() => onSelect(inst.id)}
        >
            <div className="nameplate" style={{ height: HEAD_H }} onPointerDown={(e) => onMoveStart(e, inst.id)} title="Drag to move along the rail">
                <span className={`status-dot ${inst.status}`} title={inst.status} />
                <strong className="np-name">{inst.name || inst.id}</strong>
                <span className="np-board">{(inst.board || '').toUpperCase()}</span>
                <span className="spacer" />
                {running || inst.canStart ? (
                    <>
                        {inst.status === 'running' && (
                            <button className="icon-btn" title="Reset" onPointerDown={(e) => e.stopPropagation()} onClick={() => act(inst.id, 'reset')}>
                                <Icon name="reset" />
                            </button>
                        )}
                        <button
                            className={`icon-btn ${running ? 'stop' : 'play'}`}
                            title={running ? 'Stop' : 'Start'}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => act(inst.id, running ? 'stop' : 'start')}
                        >
                            <Icon name={running ? 'stop' : 'play'} />
                        </button>
                    </>
                ) : (
                    <span className="np-note" title="Upload a .elf (or a monitor .bin) in Properties">no firmware</span>
                )}
            </div>

            <Faceplate inst={inst} state={state} />

            {geom.blocks.map((b) => (
                <TerminalBlock key={b.id} block={b} wired={wired} dragging={termDrag} onDown={onTermDown} />
            ))}

            {geom.pads.map((pad) => {
                const ps = pad.kind === 'gpio' && live ? pinState(state, pad.port) : null;
                const isLinked = linked(pad);
                const compatible = !!wiring && wiring.kind === pad.kind && !(wiring.instance === inst.id && wiring.port === pad.port);
                const cls = [
                    'pad',
                    pad.kind,
                    isLinked && 'linked',
                    pad.missing && 'missing',
                    ps && ps.high && 'hi',
                    ps && ps.out && 'out',
                    wiring && (compatible ? 'target' : 'dim'),
                ]
                    .filter(Boolean)
                    .join(' ');
                const title = `${pad.kind === 'uart' ? 'UART' : 'GPIO'} ${pad.port}${pad.label ? ` · ${pad.label}` : ''}${ps ? `\n${ps.out ? 'output' : 'input'} · ${ps.high ? 'high' : 'low'}` : ''}\nDrag to another ${pad.kind === 'uart' ? 'UART' : 'pin'} to connect`;
                return (
                    <div
                        key={pad.key}
                        className={cls}
                        style={{ left: pad.x - PAD_W / 2 + 2, top: pad.y - 12, width: PAD_W - 4 }}
                        data-pad
                        data-inst={inst.id}
                        data-port={pad.port}
                        data-kind={pad.kind}
                        title={title}
                        onPointerDown={(e) => onPadDown(e, inst, pad)}
                    >
                        <span className="pad-dot" />
                        <span className="pad-name">{pad.port}</span>
                        <span className="pad-label">{pad.label || ' '}</span>
                        {pad.extra && !isLinked && (
                            <button className="pad-x" title="Remove pin" onPointerDown={(e) => e.stopPropagation()} onClick={() => removePin(pad.port)}>
                                ×
                            </button>
                        )}
                    </div>
                );
            })}

            <div className="pad add" style={{ left: geom.add.x - PAD_W / 2 + 2, top: geom.add.y - 12, width: PAD_W - 4 }} data-nopan onPointerDown={(e) => e.stopPropagation()}>
                {adding ? (
                    <input
                        autoFocus
                        className="pin-input"
                        placeholder="PA0"
                        spellCheck={false}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') addPin(e.currentTarget.value);
                            else if (e.key === 'Escape') setAdding(false);
                        }}
                        onBlur={() => setAdding(false)}
                    />
                ) : (
                    <button className="pad-add" title="Add a GPIO pin (PA0..PI15) to wire" onClick={() => setAdding(true)}>
                        <Icon name="plus" size={12} />
                        <span>pin</span>
                    </button>
                )}
            </div>
        </div>
    );
});

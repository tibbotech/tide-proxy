import { memo, useMemo } from 'react';
import { act } from '../actions';
import { HEAD_H, PORT_H, PORT_W, type DeviceGeom, type PlacedTerm } from '../scene';
import { useInstanceState } from '../store';
import type { Instance, InstState, TermRef, Wire } from '../types';
import { Faceplate } from './Faceplate';
import { Icon } from './icons';
import { TerminalBlock } from './Terminals';

interface Props {
    inst: Instance;
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

export const wiredKeys = (wires: Wire[]) => {
    const keys = new Set<string>();
    for (const w of wires) {
        keys.add(`${w.a.owner}/${w.a.term}`);
        keys.add(`${w.b.owner}/${w.b.term}`);
    }
    return keys;
};

const pinHigh = (state: InstState | undefined, port: string) => {
    const m = /^P([A-I])(\d+)$/.exec(port);
    return !!m && !!state && !!state.pins && ((state.pins[m[1]] || 0) & (1 << Number(m[2]))) !== 0;
};

export const Device = memo(function Device({ inst, geom, x, y, selected, dragging, termWires, termDrag, onTermDown, onSelect, onMoveStart }: Props) {
    const state = useInstanceState(inst.id);
    const running = inst.status === 'running' || inst.status === 'starting';
    const wired = useMemo(() => wiredKeys(termWires), [termWires]);

    return (
        <div
            className={`device ${inst.status}${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
            style={{ left: x, top: y, width: geom.w, height: geom.h, ['--face-top' as string]: `${geom.faceY}px` }}
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

            {/* Ports with a link (Links tab): a direct UART or pin connection, not a terminal. */}
            {geom.ports.map((p) => (
                <div
                    key={p.key}
                    className={`lport ${p.kind}${p.missing ? ' missing' : ''}${p.kind === 'gpio' && inst.status === 'running' && pinHigh(state, p.port) ? ' hi' : ''}`}
                    style={{ left: p.left, top: p.top, width: PORT_W, height: PORT_H }}
                    title={`Linked ${p.kind === 'uart' ? 'UART' : 'pin'} ${p.port}${p.label ? ` · ${p.label}` : ''}\nManage links in the Links tab`}
                >
                    <span className="lport-name">{p.port}</span>
                    <span className="lport-label">{p.label || (p.kind === 'uart' ? 'UART' : 'pin')}</span>
                </div>
            ))}
        </div>
    );
});

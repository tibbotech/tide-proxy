import { useRef, useState } from 'react';
import { act, addFieldDevice, createInstances, removeMonitor, setMonitor } from '../actions';
import { fileToBase64 } from '../api';
import { artForBoard } from '../art';
import { BOARD_MIME, FIELD_MIME } from '../scene';
import { notify, useFields, useInstances, useMonitors } from '../store';
import type { Board, FieldKind, Generation } from '../types';
import { Icon } from './icons';

const CATALOG: Array<{ board: Board; name: string; mcu: string }> = [
    { board: 'tpp2g2', name: 'TPP2 G2', mcu: 'STM32F207 · LCD build' },
    { board: 'tpp3g2', name: 'TPP3 G2', mcu: 'STM32F207' },
    { board: 'tpp2g3', name: 'TPP2 G3', mcu: 'STM32F439 · LCD build' },
    { board: 'tpp3g3', name: 'TPP3 G3', mcu: 'STM32F439' },
];

const FIELD_CATALOG: Array<{ kind: FieldKind; name: string; note: string }> = [
    { kind: 'wiegand-reader', name: 'Wiegand reader', note: 'D0 / D1 · swipe a card' },
    { kind: 'modbus-slave', name: 'Modbus RTU slave', note: 'RS485 A / B · register table' },
    { kind: 'io-panel', name: 'I/O panel', note: '4 switches and lamps' },
];

const thumb = (board: string) => `data:image/svg+xml;utf8,${encodeURIComponent(artForBoard(board).raw)}`;

interface Props {
    selected: string | null;
    onSelect: (id: string) => void;
    onAddAdvanced: (board: Board) => void;
}

export function Sidebar({ selected, onSelect, onAddAdvanced }: Props) {
    const instances = useInstances();
    const fields = useFields();
    const monitors = useMonitors();
    const fileRef = useRef<HTMLInputElement>(null);
    const [monitorGen, setMonitorGen] = useState<Generation | null>(null);
    const running = instances.filter((i) => i.status === 'running').length;

    const quickAdd = (board: Board) => createInstances({ board }).catch((e) => notify(e.message));

    const pickMonitor = (gen: Generation) => {
        setMonitorGen(gen);
        if (fileRef.current) {
            fileRef.current.value = '';
            fileRef.current.click();
        }
    };

    return (
        <aside className="sidebar">
            <section>
                <header className="side-head">
                    <h2>Devices</h2>
                    <span className="muted">{instances.length ? `${instances.length} · ${running} running` : ''}</span>
                </header>
                <ul className="tree">
                    {instances.map((inst) => {
                        const live = inst.status === 'running' || inst.status === 'starting';
                        return (
                            <li key={inst.id} className={inst.id === selected ? 'selected' : ''} onClick={() => onSelect(inst.id)}>
                                <span className={`status-dot ${inst.status}`} title={inst.status} />
                                <span className="tree-main">
                                    <strong>{inst.name || inst.id}</strong>
                                    <span className="muted">
                                        {(inst.board || '').toUpperCase()} · {inst.ip}
                                    </span>
                                </span>
                                {(live || inst.canStart) && (
                                    <button
                                        className="icon-btn"
                                        title={live ? 'Stop' : 'Start'}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            act(inst.id, live ? 'stop' : 'start');
                                        }}
                                    >
                                        <Icon name={live ? 'stop' : 'play'} />
                                    </button>
                                )}
                            </li>
                        );
                    })}
                    {fields.map((f) => (
                        <li key={f.id} className={f.id === selected ? 'selected' : ''} onClick={() => onSelect(f.id)}>
                            <span className="status-dot field" />
                            <span className="tree-main">
                                <strong>{f.name}</strong>
                                <span className="muted">{f.title}</span>
                            </span>
                        </li>
                    ))}
                    {!instances.length && !fields.length && <li className="tree-empty muted">Nothing on the rails yet.</li>}
                </ul>
            </section>

            <section>
                <header className="side-head">
                    <h2>Catalog</h2>
                    <span className="muted">drag onto a rail</span>
                </header>
                <div className="catalog">
                    {CATALOG.map((c) => (
                        <div
                            key={c.board}
                            className="cat-card"
                            draggable
                            onDragStart={(e) => {
                                e.dataTransfer.setData(BOARD_MIME, c.board);
                                e.dataTransfer.effectAllowed = 'copy';
                            }}
                        >
                            <img src={thumb(c.board)} alt="" draggable={false} />
                            <div className="cat-main">
                                <strong>{c.name}</strong>
                                <span className="muted">{c.mcu}</span>
                            </div>
                            <button className="icon-btn" title="Add to the first rail with room" onClick={() => quickAdd(c.board)}>
                                <Icon name="plus" />
                            </button>
                            <button className="icon-btn" title="Add with firmware files…" onClick={() => onAddAdvanced(c.board)}>
                                <Icon name="upload" />
                            </button>
                        </div>
                    ))}
                </div>
            </section>

            <section>
                <header className="side-head">
                    <h2>Field devices</h2>
                    <span className="muted">wire to terminals</span>
                </header>
                <div className="catalog">
                    {FIELD_CATALOG.map((c) => (
                        <div
                            key={c.kind}
                            className="cat-card"
                            draggable
                            onDragStart={(e) => {
                                e.dataTransfer.setData(FIELD_MIME, c.kind);
                                e.dataTransfer.effectAllowed = 'copy';
                            }}
                        >
                            <span className="cat-icon" />
                            <div className="cat-main">
                                <strong>{c.name}</strong>
                                <span className="muted">{c.note}</span>
                            </div>
                            <button className="icon-btn" title="Add to the first rail with room" onClick={() => addFieldDevice(c.kind)}>
                                <Icon name="plus" />
                            </button>
                        </div>
                    ))}
                </div>
            </section>

            <section>
                <header className="side-head">
                    <h2>Default monitor</h2>
                </header>
                <p className="muted small-print">Used by instances without their own .bin. With a monitor, an instance boots through it and accepts uploads from TIDE.</p>
                <div className="monitors">
                    {(['g2', 'g3'] as Generation[]).map((gen) => {
                        const m = monitors[gen];
                        return (
                            <div className="monitor-row" key={gen}>
                                <div className="monitor-main">
                                    <strong>
                                        {gen.toUpperCase()}: {m ? m.name : 'boot stub'}
                                    </strong>
                                    <span className="muted">{m ? `${m.size} bytes · ${new Date(m.uploadedAt).toLocaleString()}` : 'no UDP firmware upload'}</span>
                                </div>
                                <button className="btn small" onClick={() => pickMonitor(gen)}>
                                    {m ? 'Replace' : 'Upload'}
                                </button>
                                {m && (
                                    <button
                                        className="icon-btn danger"
                                        title="Remove"
                                        onClick={() => confirm(`Remove the ${gen.toUpperCase()} monitor? Instances started afterwards use the boot stub.`) && removeMonitor(gen)}
                                    >
                                        <Icon name="trash" />
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
                <input
                    ref={fileRef}
                    type="file"
                    accept=".bin"
                    hidden
                    onChange={async (e) => {
                        const file = e.target.files && e.target.files[0];
                        if (file && monitorGen) await setMonitor(monitorGen, file.name, await fileToBase64(file));
                    }}
                />
            </section>
        </aside>
    );
}

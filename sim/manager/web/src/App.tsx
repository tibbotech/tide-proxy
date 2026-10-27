import { useEffect, useRef, useState } from 'react';
import { act } from './actions';
import { Dialogs } from './components/Dialogs';
import { Icon } from './components/icons';
import { Inspector } from './components/Inspector';
import { Sidebar } from './components/Sidebar';
import { Workspace, type WorkspaceHandle } from './components/Workspace';
import { setDetail, startStore, useConnected, useInfo, useInstances, useNotice } from './store';
import type { Board, Instance } from './types';

type Dialog = { kind: 'new'; board: Board } | { kind: 'upload'; inst: Instance } | null;

export function App() {
    const instances = useInstances();
    const connected = useConnected();
    const info = useInfo();
    const notice = useNotice();
    const [selected, setSelected] = useState<string | null>(() => location.hash.slice(1) || null);
    const [dialog, setDialog] = useState<Dialog>(null);
    const workspace = useRef<WorkspaceHandle>(null);

    useEffect(() => startStore(), []);

    const inst = instances.find((i) => i.id === selected) || null;
    const instId = inst ? inst.id : null;

    // The manager sends console and log streams for the selected device only.
    useEffect(() => setDetail(instId), [instId]);

    // A deleted device leaves the selection (not before the first list arrives).
    useEffect(() => {
        if (selected && instances.length && !inst) setSelected(null);
    }, [selected, instances, inst]);

    useEffect(() => {
        history.replaceState(null, '', selected ? `#${selected}` : location.pathname);
    }, [selected]);

    useEffect(() => {
        const onHash = () => setSelected(location.hash.slice(1) || null);
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);

    const select = (id: string) => {
        setSelected(id);
        workspace.current?.focus(id);
    };

    const startable = instances.filter((i) => i.canStart && i.status !== 'running' && i.status !== 'starting');
    const live = instances.filter((i) => i.status === 'running' || i.status === 'starting');

    return (
        <div className="app">
            <header className="topbar">
                <div className="brand">
                    <span className="logo">TPP</span>
                    <div>
                        <h1>TPP Simulator</h1>
                        <p className="sub">
                            <span className={`conn-dot${connected ? ' on' : ''}`} title={connected ? 'Connected' : 'Reconnecting…'} />
                            {info
                                ? `Renode · sim LAN ${info.subnet} · tide-proxy relay udp/${info.relayPort} · ${info.relay.clients.length} client${info.relay.clients.length === 1 ? '' : 's'}`
                                : connected
                                    ? 'Renode · manager unreachable'
                                    : 'Renode · connecting…'}
                        </p>
                    </div>
                </div>
                <span className="spacer" />
                <button className="btn" disabled={!startable.length} onClick={() => startable.forEach((i) => act(i.id, 'start'))} title="Start every stopped device that has firmware">
                    <Icon name="play" /> Start all
                </button>
                <button className="btn" disabled={!live.length} onClick={() => live.forEach((i) => act(i.id, 'stop'))} title="Stop every running device">
                    <Icon name="stop" /> Stop all
                </button>
                <button className="btn primary" onClick={() => setDialog({ kind: 'new', board: 'tpp2g2' })}>
                    <Icon name="plus" /> New device
                </button>
            </header>

            <Sidebar selected={selected} onSelect={select} onAddAdvanced={(board) => setDialog({ kind: 'new', board })} />

            <main className="center">
                <Workspace ref={workspace} selected={selected} onSelect={setSelected} onAddDevice={() => setDialog({ kind: 'new', board: 'tpp2g2' })} />
                <Inspector inst={inst} onUpload={(i) => setDialog({ kind: 'upload', inst: i })} />
            </main>

            <Dialogs dialog={dialog} onClose={() => setDialog(null)} />
            {notice && (
                <div className={`toast ${notice.kind}`} role="status">
                    {notice.text}
                </div>
            )}
        </div>
    );
}

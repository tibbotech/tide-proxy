import { useMemo, useState, type FormEvent } from 'react';
import { connectPorts, deleteLink, removeWire, renameLink } from '../../actions';
import { extraPinsStore, padsOf } from '../../scene';
import { useInstances, useLinks, useLinkStats } from '../../store';
import type { Link, LinkKind } from '../../types';

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`);

// Every connection, with its traffic or level; and a form to add one by name.
export function WiresTab() {
    const instances = useInstances();
    const links = useLinks();
    const stats = useLinkStats();
    const extra = extraPinsStore.use();
    const [kind, setKind] = useState<LinkKind>('uart');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [fromPort, setFromPort] = useState('');
    const [toPort, setToPort] = useState('');
    const [error, setError] = useState('');

    const nameOf = (id: string) => {
        const i = instances.find((x) => x.id === id);
        return i ? i.name || i.id : id;
    };
    const fromId = instances.some((i) => i.id === from) ? from : instances[0]?.id || '';
    const toId = instances.some((i) => i.id === to) ? to : instances[1]?.id || instances[0]?.id || '';
    const portsFor = (id: string) => {
        const inst = instances.find((i) => i.id === id);
        return inst ? padsOf(inst, extra[id] || [], links).filter((p) => p.kind === kind) : [];
    };
    const fromPorts = useMemo(() => portsFor(fromId), [fromId, kind, instances, links, extra]);
    const toPorts = useMemo(() => portsFor(toId), [toId, kind, instances, links, extra]);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setError('');
        try {
            await connectPorts(links, nameOf, { instance: fromId, port: fromPort, kind }, { instance: toId, port: toPort, kind });
        } catch (err: any) {
            setError(err.message);
        }
    };

    const chip = (link: Link, i: number) => {
        const e = link.endpoints[i];
        return (
            <span className="chip" key={i}>
                {nameOf(e.instance)} · {e.port}
                <button className="chip-x" title="Remove this end" onClick={() => removeWire(link, i)}>
                    ×
                </button>
            </span>
        );
    };

    return (
        <div className="wires-tab">
            <div className="link-list">
                {!links.length && <p className="muted">No connections yet. Drag from a terminal under one device to a terminal under another, or add one below.</p>}
                {links.map((link) => {
                    const st = stats[link.id] || { bytes: 0, level: null };
                    return (
                        <div className="lrow" key={link.id}>
                            <span className={`kind ${link.kind}`}>{link.kind.toUpperCase()}</span>
                            <input
                                className="lname"
                                defaultValue={link.name}
                                placeholder={link.kind === 'uart' ? 'UART link' : 'GPIO wire'}
                                onBlur={(e) => e.target.value !== link.name && renameLink(link.id, e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                            />
                            <span className="chips">
                                {link.kind === 'gpio' ? (
                                    <>
                                        {chip(link, 0)}
                                        <span className="muted">drives</span>
                                        {link.endpoints.slice(1).map((_, i) => chip(link, i + 1))}
                                    </>
                                ) : (
                                    link.endpoints.map((_, i) => chip(link, i))
                                )}
                            </span>
                            <span className="lstat">{link.kind === 'uart' ? formatBytes(st.bytes) : st.level === null ? 'released' : st.level ? 'high' : 'low'}</span>
                            <button className="btn small danger" onClick={() => deleteLink(link.id)}>
                                Delete
                            </button>
                        </div>
                    );
                })}
            </div>

            <form className="link-add" onSubmit={submit}>
                <select value={kind} onChange={(e) => setKind(e.target.value as LinkKind)} title="Kind">
                    <option value="uart">UART</option>
                    <option value="gpio">GPIO</option>
                </select>
                <select value={fromId} onChange={(e) => setFrom(e.target.value)} title="From device">
                    {instances.map((i) => <option key={i.id} value={i.id}>{i.name || i.id}</option>)}
                </select>
                <input value={fromPort} onChange={(e) => setFromPort(e.target.value)} list="ports-from" placeholder="usart3 / PA0" required spellCheck={false} />
                <span className="muted">→</span>
                <select value={toId} onChange={(e) => setTo(e.target.value)} title="To device">
                    {instances.map((i) => <option key={i.id} value={i.id}>{i.name || i.id}</option>)}
                </select>
                <input value={toPort} onChange={(e) => setToPort(e.target.value)} list="ports-to" placeholder="usart3 / PB1" required spellCheck={false} />
                <button className="btn primary" disabled={!instances.length}>Connect</button>
                <datalist id="ports-from">{fromPorts.map((p) => <option key={p.key} value={p.port}>{p.label}</option>)}</datalist>
                <datalist id="ports-to">{toPorts.map((p) => <option key={p.key} value={p.port}>{p.label}</option>)}</datalist>
            </form>
            <p className="error">{error}</p>
            <p className="muted small-print">
                UART: bytes one end transmits reach every other end (two ends = crossed cable, more = RS485-style bus). No baud rate or flow control. GPIO: the first pin drives the others while it is an output, released otherwise; changes take
                40–80 ms, so slow signals only.
            </p>
        </div>
    );
}

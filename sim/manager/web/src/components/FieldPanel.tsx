import { useState } from 'react';
import { patchFieldDevice, removeFieldDevice, swipeCard } from '../actions';
import type { FieldDevice, Register } from '../types';
import { formatLine } from './FieldDeviceView';
import { Icon } from './icons';

// The inspector for a field device: name, its settings, and what it is doing.

const REGISTER_TYPES: Register['type'][] = ['holding', 'input', 'coil', 'discrete'];

function ReaderPanel({ field }: { field: FieldDevice }) {
    const p = field.props;
    const raw = p.format === 'raw';
    const set = (props: Record<string, unknown>) => patchFieldDevice(field.id, { props });
    const num = (key: string, label: string, hint?: string) => (
        <label className="field-row">
            <span>{label}</span>
            <input key={String(p[key])} type="number" defaultValue={p[key]} onBlur={(e) => e.target.value !== String(p[key]) && set({ [key]: Number(e.target.value) })} />
            {hint && <span className="muted small-print">{hint}</span>}
        </label>
    );
    return (
        <div className="field-form">
            <div className="field-grid">
                <label className="field-row">
                    <span>Format</span>
                    <select value={String(p.format)} onChange={(e) => set({ format: e.target.value === 'raw' ? 'raw' : Number(e.target.value) })}>
                        <option value="26">26-bit (8 + 16)</option>
                        <option value="34">34-bit (16 + 16)</option>
                        <option value="37">37-bit (16 + 19)</option>
                        <option value="raw">raw bits</option>
                    </select>
                </label>
                {raw ? (
                    <label className="field-row wide">
                        <span>Bits</span>
                        <input key={p.bits} defaultValue={p.bits} placeholder="0110…" spellCheck={false} onBlur={(e) => e.target.value !== p.bits && set({ bits: e.target.value })} />
                    </label>
                ) : (
                    <>
                        {num('facility', 'Facility')}
                        {num('card', 'Card')}
                    </>
                )}
                {num('pulseUs', 'Pulse (µs)', 'low time of each bit')}
                {num('gapUs', 'Gap (µs)', 'between bits')}
            </div>
            <div className="field-actions">
                <button className="btn primary" onClick={() => swipeCard(field.id)}>
                    Swipe card
                </button>
                <span className="muted small-print">
                    {formatLine(p)}. D0 pulses for a 0, D1 for a 1; both idle high. Pulses are timed in Renode's virtual time.
                </span>
            </div>
        </div>
    );
}

function RegisterRow({ field, index, reg }: { field: FieldDevice; index: number; reg: Register }) {
    const regs: Register[] = field.props.registers;
    const update = (patch: Partial<Register>) => patchFieldDevice(field.id, { props: { registers: regs.map((r, i) => (i === index ? { ...r, ...patch } : r)) } });
    const bit = reg.type === 'coil' || reg.type === 'discrete';
    return (
        <tr>
            <td>
                <select value={reg.type} onChange={(e) => update({ type: e.target.value as Register['type'] })}>
                    {REGISTER_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                    ))}
                </select>
            </td>
            <td>
                <input key={reg.address} type="number" className="num" defaultValue={reg.address} onBlur={(e) => e.target.value !== String(reg.address) && update({ address: Number(e.target.value) })} />
            </td>
            <td>
                <input key={reg.name} defaultValue={reg.name} onBlur={(e) => e.target.value !== reg.name && update({ name: e.target.value })} />
            </td>
            <td>
                {bit ? (
                    <select value={reg.value} onChange={(e) => update({ value: Number(e.target.value) })}>
                        <option value={0}>0</option>
                        <option value={1}>1</option>
                    </select>
                ) : (
                    <input key={reg.value} type="number" className="num" defaultValue={reg.value} onBlur={(e) => e.target.value !== String(reg.value) && update({ value: Number(e.target.value) })} />
                )}
            </td>
            <td>
                <button className="icon-btn danger" title="Remove this register" onClick={() => patchFieldDevice(field.id, { props: { registers: regs.filter((_, i) => i !== index) } })}>
                    <Icon name="close" />
                </button>
            </td>
        </tr>
    );
}

function SlavePanel({ field }: { field: FieldDevice }) {
    const regs: Register[] = field.props.registers;
    const [type, setType] = useState<Register['type']>('holding');
    const add = () => {
        const used = new Set(regs.filter((r) => r.type === type).map((r) => r.address));
        let address = 0;
        while (used.has(address)) address++;
        patchFieldDevice(field.id, { props: { registers: [...regs, { type, address, name: '', value: 0 }] } });
    };
    return (
        <div className="slave-panel">
            <div className="slave-regs">
                <label className="field-row inline">
                    <span>Unit address</span>
                    <input key={field.props.unit} type="number" className="num" min={1} max={247} defaultValue={field.props.unit} onBlur={(e) => e.target.value !== String(field.props.unit) && patchFieldDevice(field.id, { props: { unit: Number(e.target.value) } })} />
                </label>
                <table className="reg-table">
                    <thead>
                        <tr>
                            <th>Type</th>
                            <th>Address</th>
                            <th>Name</th>
                            <th>Value</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {regs.map((r, i) => (
                            <RegisterRow key={`${r.type}:${r.address}:${i}`} field={field} index={i} reg={r} />
                        ))}
                    </tbody>
                </table>
                <div className="reg-add">
                    <select value={type} onChange={(e) => setType(e.target.value as Register['type'])}>
                        {REGISTER_TYPES.map((t) => (
                            <option key={t}>{t}</option>
                        ))}
                    </select>
                    <button className="btn small" onClick={add}>
                        <Icon name="plus" /> Add register
                    </button>
                    <span className="muted small-print">Reads of an address not listed get exception 2. Function codes 1-6, 15 and 16.</span>
                </div>
            </div>
            <div className="slave-log">
                <h4>Requests</h4>
                <pre>{field.activity.length ? field.activity.join('\n') : 'Nothing yet. Wire A and B to a TPP with an RS485 Tibbit and send a request.'}</pre>
            </div>
        </div>
    );
}

function PanelPanel() {
    return <p className="muted">Click a channel's switch on the device to cycle it: released (Z), low (0), high (1). The lamp shows the level on the wire, so it also follows a TPP output wired to the same terminal.</p>;
}

export function FieldPanel({ field }: { field: FieldDevice }) {
    return (
        <section className="inspector field-inspector">
            <header className="insp-head">
                <strong className="insp-name">{field.title}</strong>
                <input key={field.name} className="name-input" defaultValue={field.name} onBlur={(e) => e.target.value && e.target.value !== field.name && patchFieldDevice(field.id, { name: e.target.value })} />
                <span className="spacer" />
                <button className="icon-btn danger" title="Remove this device" onClick={() => confirm(`Remove ${field.name}?`) && removeFieldDevice(field.id)}>
                    <Icon name="trash" />
                </button>
            </header>
            <div className="insp-body">{field.kind === 'wiegand-reader' ? <ReaderPanel field={field} /> : field.kind === 'modbus-slave' ? <SlavePanel field={field} /> : <PanelPanel />}</div>
        </section>
    );
}

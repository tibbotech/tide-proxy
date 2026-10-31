import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createInstances } from '../actions';
import { api } from '../api';
import { bootHint, describeFiles, firmwareFields, FLASH_ADDRESSES, hexAddr, pickedFiles } from '../firmware';
import { useMonitors } from '../store';
import type { Board, Generation, Instance, ProjectSetup } from '../types';

// What the picked Cody project puts on the device.
function ProjectSummary({ setup }: { setup: ProjectSetup }) {
    const tibbits = Object.entries(setup.tibbits).sort(([a], [b]) => Number(a) - Number(b));
    const lcd = setup.lcd === undefined ? '' : setup.lcd ? ' · TPB2L (LCD and keypad)' : ' · TPB2 (no LCD)';
    return (
        <div className="project-summary">
            <strong>{setup.board.toUpperCase()}</strong>
            {lcd} · {tibbits.length ? tibbits.map(([s, m]) => `#${m} in ${s}`).join(', ') : 'no Tibbits'}
            {setup.notes.length || setup.skipped.length ? (
                <ul className="muted">
                    {setup.notes.map((n) => (
                        <li key={n}>{n}</li>
                    ))}
                    {setup.skipped.map((n) => (
                        <li key={n}>skipped {n}</li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

// Native <dialog>, opened as a modal on mount.
function Modal({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: ReactNode }) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const d = ref.current!;
        if (!d.open) d.showModal();
        return () => d.close();
    }, []);
    return (
        <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
            <div className="dialog-body">
                <h3>
                    {title} {sub && <span className="muted">{sub}</span>}
                </h3>
                {children}
            </div>
        </dialog>
    );
}

// Files input with the .bin address that appears once a .bin is picked.
function FirmwareFields({ gen, files, setFiles, binAddress, setBinAddress, label }: {
    gen: Generation;
    files: File[];
    setFiles: (f: File[]) => void;
    binAddress: string;
    setBinAddress: (a: string) => void;
    label: string;
}) {
    const listId = useRef(`addr-${Math.random().toString(36).slice(2)}`).current;
    const hasBin = useMemo(() => {
        try {
            return !!pickedFiles(files).bin;
        } catch {
            return false;
        }
    }, [files]);
    return (
        <>
            <label>
                {label}
                <input type="file" accept=".elf,.dts,.bin" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} />
            </label>
            {hasBin && (
                <label>
                    .bin address (hex)
                    <input value={binAddress} list={listId} spellCheck={false} autoComplete="off" onChange={(e) => setBinAddress(e.target.value)} />
                    <datalist id={listId}>
                        {FLASH_ADDRESSES[gen].map(([addr, what]) => (
                            <option key={addr} value={hexAddr(addr)}>
                                {what}
                            </option>
                        ))}
                    </datalist>
                </label>
            )}
            <p className="muted">{describeFiles(files, binAddress, gen)}</p>
        </>
    );
}

export function NewDeviceDialog({ board: initial, onClose }: { board: Board; onClose: () => void }) {
    const [board, setBoard] = useState<Board>(initial);
    const [name, setName] = useState('');
    const [count, setCount] = useState('1');
    const [files, setFiles] = useState<File[]>([]);
    const [binAddress, setBinAddress] = useState('0x08000000');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [project, setProject] = useState<{ json: unknown; setup: ProjectSetup } | null>(null);
    const monitors = useMonitors();
    const gen = board.slice(-2) as Generation;
    const hint = bootHint(files, binAddress, gen, monitors);

    // A Cody project decides the board and the hardware; the name defaults to the project's.
    const pickProject = async (f: File | undefined) => {
        setError('');
        setProject(null);
        if (!f) return;
        try {
            const json = JSON.parse(await f.text());
            const setup = await api<ProjectSetup>('POST', '/api/projects/preview', { project: json });
            setProject({ json, setup });
            setBoard(setup.board);
        } catch (err: any) {
            setError(`${f.name}: ${err.message}`);
        }
    };

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
            await createInstances({ board, name: name || undefined, count, project: project?.json, ...(await firmwareFields(files, binAddress)) });
            onClose();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title="New device" onClose={onClose}>
            <form onSubmit={submit}>
                <label>
                    Cody project (optional: sets the device, case and Tibbits)
                    <input type="file" accept=".json,application/json" onChange={(e) => pickProject(e.target.files?.[0])} />
                </label>
                {project && <ProjectSummary setup={project.setup} />}
                <label>
                    Device
                    <select value={board} disabled={!!project} onChange={(e) => setBoard(e.target.value as Board)}>
                        <optgroup label="G2 · STM32F207">
                            <option value="tpp2g2">TPP2G2</option>
                            <option value="tpp3g2">TPP3G2</option>
                        </optgroup>
                        <optgroup label="G3 · STM32F439">
                            <option value="tpp2g3">TPP2G3</option>
                            <option value="tpp3g3">TPP3G3</option>
                        </optgroup>
                    </select>
                </label>
                <label>
                    Name
                    <input value={name} placeholder={project?.setup.name || 'TPP sim'} onChange={(e) => setName(e.target.value)} />
                </label>
                <label>
                    Count
                    <input type="number" min={1} max={16} value={count} onChange={(e) => setCount(e.target.value)} />
                </label>
                <FirmwareFields gen={gen} files={files} setFiles={setFiles} binAddress={binAddress} setBinAddress={setBinAddress} label="Files (optional: .elf app, its .dts, .bin written into flash)" />
                <p className="muted">{hint.text}</p>
                <p className="error">{error}</p>
                <menu>
                    <button type="button" className="btn" onClick={onClose}>
                        Cancel
                    </button>
                    <button className="btn primary" disabled={busy}>
                        {hint.start ? 'Create & start' : 'Create'}
                    </button>
                </menu>
            </form>
        </Modal>
    );
}

export function UploadDialog({ inst, onClose }: { inst: Instance; onClose: () => void }) {
    const [files, setFiles] = useState<File[]>([]);
    const [binAddress, setBinAddress] = useState('0x08000000');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api('PUT', `/api/instances/${inst.id}/firmware`, await firmwareFields(files, binAddress));
            onClose();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title="Upload firmware" sub={`· ${inst.name} (${inst.board.toUpperCase()})`} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="muted">
                    Pick any of: <code>.elf</code> (the app, e.g. <code>build/zephyr/zephyr.elf</code>), its <code>.dts</code> (buttons, LEDs and console; without one the instance keeps its current DTS), and a <code>.bin</code> written
                    into flash at the address you give (0x08000000 is the Tibbo monitor/bootloader). A running instance restarts.
                </p>
                <FirmwareFields gen={inst.generation} files={files} setFiles={setFiles} binAddress={binAddress} setBinAddress={setBinAddress} label="Files" />
                <p className="error">{error}</p>
                <menu>
                    <button type="button" className="btn" onClick={onClose}>
                        Cancel
                    </button>
                    <button className="btn primary" disabled={busy || !files.length}>
                        Upload
                    </button>
                </menu>
            </form>
        </Modal>
    );
}

export function Dialogs({ dialog, onClose }: { dialog: { kind: 'new'; board: Board } | { kind: 'upload'; inst: Instance } | null; onClose: () => void }) {
    if (!dialog) return null;
    return dialog.kind === 'new' ? <NewDeviceDialog board={dialog.board} onClose={onClose} /> : <UploadDialog inst={dialog.inst} onClose={onClose} />;
}

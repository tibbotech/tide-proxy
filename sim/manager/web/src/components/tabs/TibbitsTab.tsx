import { useRef } from 'react';
import { formatSdCard, importTibbits, sdImageUrl, setLcd, setSdInserted, setTibbits, uploadSdImage } from '../../actions';
import { notify, useCatalog } from '../../store';
import type { Instance, SdCard, SocketInfo, TibbitInfo } from '../../types';

// Terminal-block Tibbits that bring a function Tibbit's lines out to wire terminals.
const TERMINAL_BLOCKS = ['20', '21'];

const isFunction = (s: SocketInfo) => s.accept.some((f) => f.startsWith('M') || f.startsWith('H'));
const pinName = (p: { port: string; pin: number } | null) => (p ? `P${p.port}${p.pin}` : '–');

// A TPP2's case: TPB2, or TPB2L with the LCD and keypad. Unset follows the firmware's DTS.
function CaseSelect({ inst }: { inst: Instance }) {
    const value = inst.lcd === undefined ? '' : inst.lcd ? 'tpb2l' : 'tpb2';
    return (
        <label className="case-select">
            Case
            <select value={value} onChange={(e) => setLcd(inst.id, e.target.value === '' ? null : e.target.value === 'tpb2l')}>
                <option value="">As the firmware's DTS says</option>
                <option value="tpb2">TPB2 (no LCD)</option>
                <option value="tpb2l">TPB2L (LCD and keypad)</option>
            </select>
        </label>
    );
}

// The cards in the #49 slots: pins, image, and taking the card out.
function SdCards({ inst, cards }: { inst: Instance; cards: SdCard[] }) {
    const file = useRef<HTMLInputElement>(null);
    const target = useRef('');
    const running = inst.status === 'running' || inst.status === 'starting';

    const format = (socket: string) => {
        const mb = prompt(`Format the card in socket ${socket} as a blank FAT32 card? Everything on it is erased.${running ? ' The device restarts.' : ''}\n\nSize in MB (64-4096):`, '64');
        if (mb !== null) formatSdCard(inst.id, socket, Number(mb));
    };

    return (
        <div className="sd-cards">
            <h4>SD cards</h4>
            {cards.map((c) => (
                <div key={c.socket} className="sd-card">
                    <div>
                        <strong>Socket {c.socket}</strong>{' '}
                        <span className="muted">
                            {c.size ? `${Math.round(c.size / 1048576)} MB card · sd${c.socket}.img` : 'blank 64 MB FAT32 card made at the first start'}
                            {c.inserted ? '' : ' · taken out'}
                        </span>
                        <div className="muted lines">
                            CLK {pinName(c.clk)} · MOSI {pinName(c.mosi)} · MISO {pinName(c.miso)} · CS {pinName(c.cs)}
                        </div>
                    </div>
                    <div className="sd-actions">
                        <button className="btn small" onClick={() => setSdInserted(inst.id, c.socket, !c.inserted)} title={c.inserted ? 'The card stops answering, as if pulled out' : 'Put the card back; the firmware has to initialise it again'}>
                            {c.inserted ? 'Take out' : 'Put back'}
                        </button>
                        {c.size ? (
                            <a className="btn small" href={sdImageUrl(inst.id, c.socket)} download title={running ? 'The device is writing to it: stop it first for a consistent copy' : 'The raw image (MBR + FAT32): open it with 7-Zip or mtools'}>
                                Download image
                            </a>
                        ) : null}
                        <button className="btn small" onClick={() => { target.current = c.socket; file.current?.click(); }} title={`Replace the card with a raw image file${running ? '; the device restarts' : ''}`}>
                            Upload image…
                        </button>
                        <button className="btn small" onClick={() => format(c.socket)}>
                            Format…
                        </button>
                    </div>
                </div>
            ))}
            <input ref={file} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadSdImage(inst.id, target.current, f); e.target.value = ''; }} />
        </div>
    );
}

// The Tibbits in the TPP's sockets: function Tibbits in the odd sockets, connector Tibbits (terminal
// blocks) in the even ones. A function Tibbit gets wire terminals once a terminal block sits beside it.
export function TibbitsTab({ inst }: { inst: Instance }) {
    const catalog = useCatalog();
    const file = useRef<HTMLInputElement>(null);
    const sockets = catalog?.sockets[inst.board] || [];
    const byModel = new Map((catalog?.tibbits || []).map((t) => [t.model, t]));
    const placed = inst.tibbits || {};

    if (!catalog) return <p className="empty-note">Loading the Tibbit catalog…</p>;

    const fits = (s: SocketInfo): TibbitInfo[] => catalog.tibbits.filter((t) => s.accept.includes(t.form));

    const change = (s: SocketInfo, model: string) => {
        const next: Record<string, string | null> = { ...placed, [s.socket]: model || null };
        // A simulated function Tibbit gets a terminal block in the socket beside it, if that is free.
        const pair = String(Number(s.socket) + 1);
        if (isFunction(s) && model && byModel.get(model)?.sim && !placed[pair] && sockets.some((x) => x.socket === pair)) next[pair] = '21';
        setTibbits(inst.id, next);
    };

    const onFile = async (f: File | undefined) => {
        if (!f) return;
        try {
            await importTibbits(inst.id, JSON.parse(await f.text()));
        } catch (e: any) {
            notify(`Not a Cody project: ${e.message}`);
        }
    };

    return (
        <div className="tibbits-tab">
            <div className="tibbits-head">
                <p className="muted small-print">
                    Function Tibbits go in the odd sockets; a terminal block (#21 four terminals, #20 nine) in the next socket brings their lines out to terminals you can wire. Simulated Tibbits are marked ●. Adding or removing a #49 SD slot restarts a running device.
                </p>
                {inst.board.startsWith('tpp2') && <CaseSelect inst={inst} />}
                <button className="btn small" onClick={() => file.current?.click()} title="Take the Tibbits (and on a TPP2 the case: LCD or not) from a Cody project .json">
                    Import from Cody project…
                </button>
                <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
            <table className="tibbit-table">
                <thead>
                    <tr>
                        <th>Socket</th>
                        <th>Tibbit</th>
                        <th>Lines</th>
                    </tr>
                </thead>
                <tbody>
                    {sockets.map((s) => {
                        const fn = isFunction(s);
                        const model = placed[s.socket] || '';
                        const covered = !model && Object.entries(placed).some(([sock, m]) => {
                            const f = byModel.get(m)?.form;
                            return (f === 'M2S' || f === 'M2T' || f === 'H2' || f === 'C2') && Number(sock) + 2 === Number(s.socket);
                        });
                        return (
                            <tr key={s.socket} className={fn ? 'fn' : 'conn'}>
                                <td>
                                    {s.socket}
                                    <span className="muted"> {fn ? 'function' : 'connector'}</span>
                                </td>
                                <td>
                                    {covered ? (
                                        <span className="muted">covered by the wide Tibbit before it</span>
                                    ) : (
                                        <select value={model} onChange={(e) => change(s, e.target.value)}>
                                            <option value="">(empty)</option>
                                            {fits(s).map((t) => (
                                                <option key={t.model} value={t.model}>
                                                    {t.sim ? '● ' : ''}#{t.model} {t.name}
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                    {TERMINAL_BLOCKS.includes(model) && <span className="muted"> → terminals on the wire view</span>}
                                </td>
                                <td className="muted lines">{fn ? `${s.uart ? s.uart + ' · ' : ''}${s.lines.map(pinName).join(' ')}` : ''}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            {inst.sdCards?.length ? <SdCards inst={inst} cards={inst.sdCards} /> : null}
        </div>
    );
}

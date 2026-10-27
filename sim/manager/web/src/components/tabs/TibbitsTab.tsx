import { useRef } from 'react';
import { importTibbits, setTibbits } from '../../actions';
import { notify, useCatalog } from '../../store';
import type { Instance, SocketInfo, TibbitInfo } from '../../types';

// Terminal-block Tibbits that bring a function Tibbit's lines out to wire terminals.
const TERMINAL_BLOCKS = ['20', '21'];

const isFunction = (s: SocketInfo) => s.accept.some((f) => f.startsWith('M') || f.startsWith('H'));
const pinName = (p: { port: string; pin: number } | null) => (p ? `P${p.port}${p.pin}` : '–');

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
                    Function Tibbits go in the odd sockets; a terminal block (#21 four terminals, #20 nine) in the next socket brings their lines out to terminals you can wire. Simulated Tibbits are marked ●.
                </p>
                <button className="btn small" onClick={() => file.current?.click()} title="Take the Tibbits and sockets from a Cody project .json">
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
        </div>
    );
}

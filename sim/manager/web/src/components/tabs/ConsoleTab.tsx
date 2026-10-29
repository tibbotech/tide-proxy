import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { setDebugPrint } from '../../actions';
import { clearConsole, getConsole, onConsole, sendConsole } from '../../store';
import type { Instance } from '../../types';

function Terminal({ id, uart }: { id: string; uart: string }) {
    const host = useRef<HTMLDivElement>(null);
    const term = useRef<XTerm>();
    const latest = useRef({ id, uart });
    latest.current = { id, uart };

    useEffect(() => {
        const t = new XTerm({ convertEol: false, fontSize: 12, scrollback: 5000, theme: { background: '#0b0d12' } });
        const fit = new FitAddon();
        t.loadAddon(fit);
        t.open(host.current!);
        term.current = t;
        // Keyboard input goes to UART consoles only; debug print is output-only.
        t.onData((d) => {
            const cur = latest.current;
            if (cur.uart !== 'udp') sendConsole(cur.id, cur.uart, d);
        });
        const ro = new ResizeObserver(() => {
            try {
                fit.fit();
            } catch {
                // Not laid out yet.
            }
        });
        ro.observe(host.current!);
        const off = onConsole((e) => {
            if (e.id !== latest.current.id || e.uart !== latest.current.uart) return;
            if (e.kind === 'reset') t.reset();
            else if (e.data) t.write(e.data);
        });
        return () => {
            off();
            ro.disconnect();
            t.dispose();
            term.current = undefined;
        };
    }, []);

    // A new console (or instance): replay what the store kept.
    useEffect(() => {
        const t = term.current;
        if (!t) return;
        t.reset();
        for (const chunk of getConsole(id, uart)) t.write(chunk);
    }, [id, uart]);

    return <div className="term" ref={host} />;
}

export function ConsoleTab({ inst }: { inst: Instance }) {
    const consoles = inst.consoles && inst.consoles.length ? inst.consoles : ['udp'];
    const [pick, setPick] = useState(consoles[0]);
    const uart = consoles.includes(pick) ? pick : consoles[0];
    const profile = inst.profile;

    return (
        <div className="console-tab">
            <div className="console-tools">
                {consoles.length > 1 && (
                    <select value={uart} onChange={(e) => setPick(e.target.value)} title="Console">
                        {consoles.map((u) => (
                            <option key={u} value={u}>
                                {u === 'udp' ? 'udp (debug print)' : u + (profile && u === profile.consoleUart ? ' (zephyr console)' : '')}
                            </option>
                        ))}
                    </select>
                )}
                {uart === 'udp' && (
                    // The debug-print reader dequeues entries, so it only runs when attached.
                    <button
                        className="btn small"
                        title={inst.debugPrintAttached ? 'Stop reading debug print (leaves it for a tide-proxy client)' : 'Read debug print here (takes it away from a tide-proxy client)'}
                        onClick={() => setDebugPrint(inst.id, !inst.debugPrintAttached)}
                    >
                        {inst.debugPrintAttached ? 'Detach' : 'Attach'}
                    </button>
                )}
                <button className="btn small" title="Clear this console's output, for every viewer" onClick={() => clearConsole(inst.id, uart)}>
                    Clear
                </button>
                <span className="muted small-print">{uart === 'udp' ? 'Output only.' : 'Type here to send to the UART.'}</span>
            </div>
            <Terminal id={inst.id} uart={uart} />
        </div>
    );
}

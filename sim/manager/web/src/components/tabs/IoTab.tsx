import { useEffect, useMemo, useRef, useState } from 'react';
import { persisted } from '../../local';
import { sendPin, useInstanceState, usePinConfig } from '../../store';
import type { Instance, InstState, PinConfig } from '../../types';

// Live GPIO state of the open instance. Levels and output masks come with every 'state' message
// (40 ms stream); the pin configuration (mode, pulls, alternate function, external drivers) comes
// as 'pinConfig' when it changes. Watched pins are per-viewer.

const IO_PORTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const IO_TRACE_MS = 10000;
const IO_ACTIVE_MS = 400;
// STM32F2/F4 alternate functions (the same on both).
const AF_NAMES = ['SYS', 'TIM1/2', 'TIM3-5', 'TIM8-11', 'I2C1-3', 'SPI1/2', 'SPI3', 'USART1-3', 'UART4-6/USART6', 'CAN/TIM12-14', 'OTG', 'ETH', 'FSMC/SDIO', 'DCMI', 'AF14', 'EVENTOUT'];

const NO_PINS: string[] = [];
const watchStore = persisted<Record<string, string[]>>('sim.io.watch', {});

// Pins the board wires to something, plus the DTS buttons and LEDs: 'PB10' -> label.
function namedPins(inst: Instance) {
    const profile = inst.profile || { buttons: [], leds: [] };
    const names = new Map<string, string>();
    for (const b of profile.buttons) names.set(`P${b.port}${b.pin}`, b.id === 'mdbutton' ? 'MD button' : b.label);
    for (const l of profile.leds) names.set(`P${l.port}${l.pin}`, l.label);
    const board: Array<[string, string]> = [
        ['PA10', 'Blue bar RST'], ['PA11', 'Blue bar CLK'], ['PA12', 'Blue bar DATA'],
        ['PA15', 'DataFlash CS'], ['PB8', 'EEPROM SCL'], ['PB9', 'EEPROM SDA'],
    ];
    if (inst.profile && inst.profile.lcd) {
        board.push(['PA9', 'LCD backlight'], ['PC0', 'LCD RD'], ['PC2', 'LCD WR'], ['PC3', 'LCD DC'], ['PB0', 'LCD CS'], ['PC13', 'LCD RESET']);
        for (let i = 0; i < 8; i++) board.push([`PE${i}`, `LCD D${i}`]);
    }
    for (const [pin, label] of board) if (!names.has(pin)) names.set(pin, label);
    return names;
}

interface Pin {
    level: boolean;
    mode: 'in' | 'out' | 'af' | 'an';
    od?: boolean;
    pull?: string;
    af?: number;
    ext?: boolean | null;
}

function pinOf(running: boolean, state: InstState | undefined, cfg: PinConfig | undefined, port: string, pin: number): Pin | null {
    if (!running || !state) return null;
    const bit = 1 << pin;
    const level = ((state.pins[port] || 0) & bit) !== 0;
    const c = cfg && cfg[port];
    if (!c) {
        const out = (((state.out || {})[port] || 0) & bit) !== 0;
        return { level, mode: out ? 'out' : 'in' };
    }
    return {
        level,
        mode: (['in', 'out', 'af', 'an'] as const)[(c[0] >>> (2 * pin)) & 3],
        od: ((c[1] >>> pin) & 1) === 1,
        pull: ['', 'up', 'down', ''][(c[2] >>> (2 * pin)) & 3],
        af: pin < 8 ? (c[3] >>> (4 * pin)) & 15 : (c[4] >>> (4 * (pin - 8))) & 15,
        ext: ((c[5] >>> pin) & 1) === 1 ? ((c[6] >>> pin) & 1) === 1 : null,
    };
}

function modeText(p: Pin | null) {
    if (!p) return '–';
    let t = p.mode === 'in' ? 'input' : p.mode === 'out' ? (p.od ? 'output, open-drain' : 'output') : p.mode === 'af' ? `AF${p.af} (${AF_NAMES[p.af!]})` : 'analog';
    if (p.pull) t += `, pull-${p.pull}`;
    return t;
}

const cellText = (p: Pin | null) => (!p ? '' : p.mode === 'out' ? 'O' : p.mode === 'af' ? String(p.af) : p.mode === 'an' ? 'A' : '');

function split(key: string): [string, number] {
    const m = /^P([A-I])(\d{1,2})$/.exec(key)!;
    return [m[1], Number(m[2])];
}

function Trace({ hist, running, now }: { hist: Array<[number, number]> | undefined; running: boolean; now: number }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const c = ref.current!;
        const ctx = c.getContext('2d')!;
        ctx.clearRect(0, 0, c.width, c.height);
        if (!hist || !hist.length) return;
        const style = getComputedStyle(document.documentElement);
        const hi = style.getPropertyValue('--gpio-hi').trim() || '#f59e0b';
        const lo = style.getPropertyValue('--muted').trim() || '#888';
        const x = (t: number) => c.width - ((now - t) / IO_TRACE_MS) * c.width;
        const y = (v: number) => (v ? 3 : c.height - 3);
        ctx.lineWidth = 1.5;
        let px = Math.max(0, x(hist[0][0]));
        for (let i = 0; i < hist.length; i++) {
            const end = i + 1 < hist.length ? x(hist[i + 1][0]) : running ? c.width : px;
            ctx.strokeStyle = hist[i][1] ? hi : lo;
            ctx.beginPath();
            ctx.moveTo(px, y(i > 0 ? hist[i - 1][1] : hist[i][1]));
            ctx.lineTo(px, y(hist[i][1]));
            ctx.lineTo(Math.max(px, end), y(hist[i][1]));
            ctx.stroke();
            px = Math.max(px, end);
        }
    });
    return <canvas ref={ref} className="io-trace" width={180} height={18} />;
}

export function IoTab({ inst }: { inst: Instance }) {
    const state = useInstanceState(inst.id);
    const cfg = usePinConfig(inst.id);
    const watch = watchStore.use();
    const [sel, setSel] = useState<string | null>(null);
    const [, tick] = useState(0);
    const running = inst.status === 'running' && !!(state && state.pins);

    const names = useMemo(() => namedPins(inst), [inst]);
    const watched = watch[inst.id] || NO_PINS;
    const listed = useMemo(() => {
        const keys = [...names.keys(), ...watched.filter((p) => !names.has(p))];
        // The LCD data bus is better read in the matrix; list its control lines only.
        return keys.filter((k) => !/^LCD D\d$/.test(names.get(k) || ''));
    }, [names, watched]);

    const prev = useRef<Record<string, number>>({});
    const changedAt = useRef<Record<string, number>>({});
    const hist = useRef<Record<string, Array<[number, number]>>>({});

    useEffect(() => {
        if (!running || !state) return;
        const now = performance.now();
        for (const port of IO_PORTS) {
            const lv = state.pins[port] || 0;
            const was = prev.current[port];
            if (was !== undefined && was !== lv) {
                for (let pin = 0; pin < 16; pin++) if (((was ^ lv) >> pin) & 1) changedAt.current[`P${port}${pin}`] = now;
            }
            prev.current[port] = lv;
        }
        for (const key of listed) {
            const [port, pin] = split(key);
            const v = ((state.pins[port] || 0) >> pin) & 1;
            const h = hist.current[key] || (hist.current[key] = []);
            if (!h.length || h[h.length - 1][1] !== v) h.push([now, v]);
            while (h.length > 1 && h[1][0] < now - IO_TRACE_MS) h.shift();
        }
    }, [state, running, listed]);

    // Activity highlights and traces move with time even when no state arrives.
    useEffect(() => {
        const t = setInterval(() => tick((n) => n + 1), 100);
        return () => clearInterval(t);
    }, []);

    const toggleWatch = (key: string) => {
        const next = watched.includes(key) ? watched.filter((k) => k !== key) : [...watched, key];
        const all = { ...watch };
        if (next.length) all[inst.id] = next;
        else delete all[inst.id];
        watchStore.set(all);
    };

    const now = performance.now();
    const selPin = sel ? pinOf(running, state, cfg, ...split(sel)) : null;
    const drive = (level: 0 | 1 | null) => {
        if (sel) {
            const [port, pin] = split(sel);
            sendPin(inst.id, port, pin, level);
        }
    };

    return (
        <div className="io-pane">
            <div className="io-legend">
                <span><i className="iopin hi" />high</span>
                <span><i className="iopin" />low</span>
                <span><i className="iopin m-out">O</i>output</span>
                <span><i className="iopin m-af">7</i>alt. function</span>
                <span><i className="iopin m-an">A</i>analog</span>
                <span><i className="iopin ext" />driven externally</span>
                <span><i className="iopin named" />named</span>
                <span className="io-note">{running ? (cfg ? '' : 'pin modes arrive after a restart of this instance') : 'not running'}</span>
            </div>
            <div className="io-grid">
                <div className="io-scroll">
                    <table className="io-matrix">
                        <thead>
                            <tr>
                                <th />
                                {Array.from({ length: 16 }, (_, i) => <th key={i}>{i}</th>)}
                            </tr>
                        </thead>
                        <tbody>
                            {IO_PORTS.map((port) => (
                                <tr key={port}>
                                    <th>P{port}</th>
                                    {Array.from({ length: 16 }, (_, pin) => {
                                        const key = `P${port}${pin}`;
                                        const p = pinOf(running, state, cfg, port, pin);
                                        const label = names.get(key);
                                        const cls = [
                                            'iopin',
                                            names.has(key) && 'named',
                                            !p && 'off',
                                            p && p.level && 'hi',
                                            p && p.mode === 'out' && 'm-out',
                                            p && p.mode === 'af' && 'm-af',
                                            p && p.mode === 'an' && 'm-an',
                                            p && p.ext !== null && p.ext !== undefined && 'ext',
                                            sel === key && 'sel',
                                            now - (changedAt.current[key] || -1e9) < IO_ACTIVE_MS && 'act',
                                        ].filter(Boolean).join(' ');
                                        return (
                                            <td key={pin}>
                                                <button
                                                    className={cls}
                                                    title={`${key}${label ? ` · ${label}` : ''}\n${p ? `${p.level ? 'high' : 'low'} · ${modeText(p)}` : 'not running'}`}
                                                    onClick={() => setSel(sel === key ? null : key)}
                                                >
                                                    {cellText(p)}
                                                </button>
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div className="io-side">
                    <div className="io-inspect">
                        {!sel ? (
                            <span className="muted">Select a pin to see its configuration and drive it.</span>
                        ) : (
                            <>
                                <strong className="io-key">{sel}</strong>
                                {names.get(sel) && <span>{names.get(sel)}</span>}
                                <span className="muted">
                                    {selPin
                                        ? `${selPin.level ? 'HIGH' : 'LOW'} · ${modeText(selPin)}${selPin.ext === true ? ' · driven high externally' : selPin.ext === false ? ' · driven low externally' : ''}${selPin.mode === 'out' && !selPin.od ? ' · a push-pull output wins over an external drive' : ''}`
                                        : 'not running'}
                                </span>
                                <span className="spacer" />
                                <button className="btn small" title="Drive the line high, as an external circuit would" onClick={() => drive(1)}>Drive high</button>
                                <button className="btn small" title="Drive the line low" onClick={() => drive(0)}>Drive low</button>
                                <button className="btn small" title="Stop driving the line (Hi-Z)" onClick={() => drive(null)}>Release</button>
                                {!names.get(sel) && <button className="btn small" onClick={() => toggleWatch(sel)}>{watched.includes(sel) ? 'Unwatch' : 'Watch'}</button>}
                            </>
                        )}
                    </div>
                    <div className="io-list">
                        {listed.map((key) => {
                            const [port, pin] = split(key);
                            const p = pinOf(running, state, cfg, port, pin);
                            return (
                                <div key={key} className={`io-row${sel === key ? ' sel' : ''}`} onClick={() => setSel(sel === key ? null : key)}>
                                    <span className="io-key">{key}</span>
                                    <span className="io-label">{names.get(key) || (watched.includes(key) ? 'watched' : '')}</span>
                                    <span className="io-mode">{modeText(p)}</span>
                                    <span className={`io-lvl${p && p.level ? ' hi' : ''}`}>{p ? (p.level ? 'HIGH' : 'LOW') : '–'}</span>
                                    <Trace hist={hist.current[key]} running={running} now={now} />
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}

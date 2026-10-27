import type { ReactNode } from 'react';
import { resetMonitor } from '../../actions';
import { ledColor } from '../../art';
import { buttonDown, buttonUp, usePressed } from '../../buttons';
import { hexAddr } from '../../firmware';
import { useInstanceState, useMonitors } from '../../store';
import type { BoardButton, Instance } from '../../types';
import { LcdCanvas, lcdDark, ledOn } from '../Faceplate';

function HwButton({ inst, b }: { inst: Instance; b: BoardButton }) {
    const pressed = usePressed(inst.id).includes(b.id);
    const label = b.id === 'mdbutton' ? 'MD' : b.label.replace(/ button$/i, '');
    return (
        <button
            className={`hwbtn${pressed ? ' pressed' : ''}`}
            title={`${b.label} — P${b.port}${b.pin}`}
            onPointerDown={(e) => {
                e.preventDefault();
                if (buttonDown(inst.id, b.id, e.pointerId, e.shiftKey)) e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerUp={(e) => buttonUp(e.pointerId)}
            onPointerCancel={(e) => buttonUp(e.pointerId)}
        >
            {label}
        </button>
    );
}

export function PropertiesTab({ inst }: { inst: Instance }) {
    const state = useInstanceState(inst.id);
    const monitors = useMonitors();
    const profile = inst.profile || { buttons: [], leds: [], uarts: [], board: '', model: '' };
    const fw = inst.firmware;
    const mon = inst.bootMonitor;
    const webUrl = `${location.protocol}//${location.hostname}:${inst.httpPort}/`;
    const lcd = state && state.lcd;

    const facts: Array<[string, ReactNode]> = [
        ['MAC', `${inst.tibboMac}  (${inst.mac})`],
        ['IP', `${inst.ip} (DHCP reservation)`],
        ['Board', `${inst.board.toUpperCase()} (${inst.generation === 'g3' ? 'STM32F439' : 'STM32F207'})${profile.board && profile.board !== inst.board ? ` · DTS ${profile.board}` : ''}`],
        [
            'Firmware',
            fw
                ? `${fw.name} · ${new Date(fw.uploadedAt).toLocaleString()}${fw.hasDts ? '' : ' · no DTS (TPP defaults)'}`
                : mon
                    ? 'none (upload a .elf, or from TIDE through the monitor)'
                    : 'none (upload a .elf or a monitor .bin to start)',
        ],
        [
            'Monitor',
            mon ? (
                <span>
                    {mon.name} · {mon.own ? 'this instance' : `${inst.generation.toUpperCase()} default`}{' '}
                    {mon.own && (
                        <button className="btn small" onClick={() => resetMonitor(inst.id)}>
                            {monitors[inst.generation] ? 'Use default' : 'Remove'}
                        </button>
                    )}
                </span>
            ) : (
                'none (boot stub)'
            ),
        ],
    ];
    const writes = inst.flashWrites || [];
    if (writes.length) facts.push(['Flash .bin', <span style={{ whiteSpace: 'pre-line' }}>{writes.map((w) => `${w.name} @ ${hexAddr(w.address)} (${w.size} B)`).join('\n')}</span>]);
    facts.push(
        ['Boot', inst.monitor ? 'Tibbo monitor (UDP upload)' : 'boot stub'],
        [
            'Device web',
            <a href={webUrl} target="_blank" rel="noopener noreferrer">
                {webUrl}
            </a>,
        ],
        ['Renode monitor', `port ${inst.monitorPort} inside the container`],
        ['Virtual time', state ? `${(state.vtime / 1000).toFixed(1)} s` : '–'],
    );

    return (
        <div className="props">
            <dl className="facts">
                {facts.map(([k, v]) => (
                    <div key={k} className="fact">
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                    </div>
                ))}
            </dl>

            <div className="props-side">
                {profile.lcd ? (
                    <div className="lcd-preview">
                        <div className="bezel">
                            <LcdCanvas id={inst.id} dark={lcdDark(inst, state)} />
                        </div>
                        <span className="muted">{lcd ? `Backlight ${lcd.backlight ? 'on' : 'off'} · display ${lcd.on ? 'on' : 'off'}` : ''}</span>
                    </div>
                ) : (
                    <p className="muted">No LCD in this build.</p>
                )}

                <div className="hw">
                    <h4>Buttons</h4>
                    <div className="hw-row">
                        {profile.buttons.length ? profile.buttons.map((b) => <HwButton key={b.id} inst={inst} b={b} />) : <span className="muted">none in the DTS</span>}
                    </div>
                    <p className="muted small-print">Hold to press (or use a key / the MD pinhole on the faceplate). Shift+click latches.</p>
                    <h4>LEDs</h4>
                    <div className="hw-row">
                        {profile.leds.map((led) => (
                            <span className="led" key={led.id}>
                                <span className={`dot ${ledColor(led)}${ledOn(state, led) ? ' on' : ''}`} />
                                {led.label}
                            </span>
                        ))}
                        {!profile.leds.length && <span className="muted">none in the DTS</span>}
                    </div>
                </div>
            </div>
        </div>
    );
}

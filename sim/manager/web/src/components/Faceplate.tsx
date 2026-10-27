import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { artFor, ledColor } from '../art';
import { buttonDown, buttonUp, usePressed } from '../buttons';
import { registerCanvas } from '../lcd';
import type { BoardLed, Instance, InstState } from '../types';

export function ledOn(state: InstState | undefined, led: BoardLed) {
    const pins = state && state.pins;
    if (!pins || pins[led.port] === undefined) return false;
    return (((pins[led.port] >> led.pin) & 1) === 1) !== led.activeLow;
}

// The LCD's pixels are painted by lcd.ts straight onto this canvas.
export function LcdCanvas({ id, dark, className }: { id: string; dark: boolean; className?: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => registerCanvas(id, ref.current!), [id]);
    return <canvas ref={ref} width={320} height={240} className={`${className || ''}${dark ? ' dark' : ''}`} />;
}

export const lcdDark = (inst: Instance, state: InstState | undefined) => {
    const lcd = state && state.lcd;
    return inst.status === 'running' && (!lcd || !lcd.on || !lcd.backlight);
};

// The device's front panel: the board art with its LEDs lit from the simulated pins, the keys and
// the MD pinhole pressable, and the LCD in its screen window.
export const Faceplate = memo(function Faceplate({ inst, state }: { inst: Instance; state: InstState | undefined }) {
    const art = artFor(inst);
    const uid = useId().replace(/[^a-z0-9]/gi, '');
    const root = useRef<HTMLDivElement>(null);
    const profile = inst.profile || { buttons: [], leds: [], uarts: [] };
    const pressed = usePressed(inst.id);

    // Gradient ids are per copy: copies share the page, and a reference into another copy breaks
    // when that one is hidden.
    const html = useMemo(
        () => ({ __html: art.raw.replace(/id="([^"]+)"/g, `id="$1-${uid}"`).replace(/url\(#([^)]+)\)/g, `url(#$1-${uid})`) }),
        [art, uid],
    );

    // Hooks the art's parts up to the profile (on mount, and when the firmware brings another profile).
    useLayoutEffect(() => {
        const svg = root.current;
        if (!svg) return;
        const part = (name: string) => svg.querySelector<SVGElement>(`[data-part="${name}"]`);
        const titled = (node: Element, text: string) => {
            node.querySelector('title')?.remove();
            const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            t.textContent = text;
            node.append(t);
        };
        for (const color of ['red', 'green']) {
            const led = profile.leds.find((l) => ledColor(l) === color);
            const node = part(`${color}-led`);
            if (!node) continue;
            if (led) {
                node.dataset.led = led.id;
                node.classList.remove('unused');
                titled(node, led.label);
            } else {
                delete node.dataset.led;
                node.classList.add('unused');
            }
        }
        for (let i = 0; i < 5; i++) {
            const node = part(`blue-led-${i}`);
            if (node) node.dataset.blue = String(i);
        }
        const link = part('link-led');
        if (link) {
            link.dataset.link = '';
            titled(link, 'Ethernet link');
        }
        const md = profile.buttons.find((b) => b.id === 'mdbutton');
        const keys = profile.buttons.filter((b) => b.id !== 'mdbutton');
        const bind = (node: SVGElement | null, b?: { id: string; label: string; port: string; pin: number }) => {
            if (!node) return;
            if (!b) {
                delete node.dataset.btn;
                node.classList.remove('press');
                return;
            }
            node.dataset.btn = b.id;
            node.classList.add('press');
            titled(node, `${b.label} — P${b.port}${b.pin}`);
        };
        bind(part('md'), md);
        for (let i = 0; i < 4; i++) bind(part(`key-${i}`), keys[i]);
    }, [html, profile]);

    // Live indicators.
    useLayoutEffect(() => {
        const svg = root.current;
        if (!svg) return;
        svg.querySelectorAll<SVGElement>('[data-led]').forEach((n) => {
            const led = profile.leds.find((l) => l.id === n.dataset.led);
            n.classList.toggle('on', !!led && ledOn(state, led));
        });
        const bar = state ? state.blueBar : 0;
        svg.querySelectorAll<SVGElement>('[data-blue]').forEach((n) => n.classList.toggle('on', ((bar >> (4 - Number(n.dataset.blue))) & 1) === 1));
        // The simulated LAN is always up while the instance runs.
        svg.querySelectorAll<SVGElement>('[data-link]').forEach((n) => n.classList.toggle('on', inst.status === 'running'));
    }, [state, inst.status, profile, html]);

    useLayoutEffect(() => {
        root.current?.querySelectorAll<SVGElement>('[data-btn]').forEach((n) => n.classList.toggle('pressed', pressed.includes(n.dataset.btn!)));
    }, [pressed, html, profile]);

    const onDown = (e: React.PointerEvent) => {
        const node = (e.target as Element).closest<SVGElement>('[data-btn]');
        if (!node || e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        if (buttonDown(inst.id, node.dataset.btn!, e.pointerId, e.shiftKey)) node.setPointerCapture(e.pointerId);
    };

    const lcd = art.lcd && profile.lcd ? art.lcd : null;
    return (
        <div className="faceplate" style={{ aspectRatio: `${art.w} / ${art.h}` }}>
            <div ref={root} className="board" dangerouslySetInnerHTML={html} onPointerDown={onDown} onPointerUp={(e) => buttonUp(e.pointerId)} onPointerCancel={(e) => buttonUp(e.pointerId)} />
            {lcd && (
                <div
                    className="lcd-window"
                    style={{ left: `${(lcd.x / art.w) * 100}%`, top: `${(lcd.y / art.h) * 100}%`, width: `${(lcd.w / art.w) * 100}%`, height: `${(lcd.h / art.h) * 100}%` }}
                >
                    <LcdCanvas id={inst.id} dark={lcdDark(inst, state)} />
                </div>
            )}
        </div>
    );
});

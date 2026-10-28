import { TERM_BLOCK_H, TERM_HEAD_H, type PlacedBlock, type PlacedTerm } from '../scene';
import type { TermRef } from '../types';

// A row of green screw terminals, like the terminal-block Tibbits (#20, #21) or a field device's
// connector. Dragging from one terminal to another makes a wire.

interface Props {
    block: PlacedBlock;
    wired: Set<string>; // "owner/term" keys that have a wire
    dragging: TermRef | null;
    onDown: (e: React.PointerEvent, t: PlacedTerm) => void;
}

const ROLE_TITLE: Record<string, string> = {
    a: 'RS485 A (+)',
    b: 'RS485 B (-)',
    tx: 'RS232 TX',
    rx: 'RS232 RX',
    rts: 'RS232 RTS',
    cts: 'RS232 CTS',
    w0: 'Wiegand D0',
    w1: 'Wiegand D1',
    io: 'I/O line',
    vcc: 'supply',
    gnd: 'ground',
};

export function TerminalBlock({ block, wired, dragging, onDown }: Props) {
    return (
        <div className={`tblock ${block.edge}`} style={{ left: block.x, top: block.y, width: block.w, height: TERM_HEAD_H + TERM_BLOCK_H }}>
            {block.terms.map((t) => {
                const key = `${t.owner}/${t.id}`;
                const self = !!dragging && dragging.owner === t.owner && dragging.term === t.id;
                const cls = ['tterm', t.role, !t.wirable && 'inert', wired.has(key) && 'wired', dragging && t.wirable && !self && 'target', dragging && !t.wirable && 'dim', self && 'self'].filter(Boolean).join(' ');
                const title = t.wirable ? `${t.label || t.n}${t.role ? ` · ${ROLE_TITLE[t.role] || t.role}` : ''}\nDrag to another terminal to wire it` : `Terminal ${t.n}: nothing simulated behind it`;
                return (
                    <div
                        key={t.id}
                        className={cls}
                        style={{ left: t.x - block.x - block.termW / 2, width: block.termW }}
                        data-term={t.wirable ? t.id : undefined}
                        data-owner={t.owner}
                        title={title}
                        onPointerDown={t.wirable ? (e) => onDown(e, t) : undefined}
                    >
                        <span className="tterm-label">{t.label || ''}</span>
                        <span className="tterm-body">
                            <span className="tterm-screw" />
                            <span className="tterm-hole" />
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

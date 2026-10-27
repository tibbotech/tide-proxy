import { useSyncExternalStore } from 'react';
import { sendButton } from './store';

// Hardware buttons are held while the pointer is down; shift+click latches one. Every control for
// the same button (a faceplate key, the row in Properties) shows the same pressed state.

const pressed = new Map<string, string[]>(); // instance id -> pressed button ids
const latched = new Map<string, Set<string>>();
const held = new Map<number, { inst: string; btn: string }>(); // pointer id -> what it holds
const listeners = new Set<() => void>();
const NONE: string[] = [];

const set = (inst: string, btn: string, on: boolean) => {
    const cur = pressed.get(inst) || NONE;
    if (cur.includes(btn) === on) return;
    pressed.set(inst, on ? [...cur, btn] : cur.filter((b) => b !== btn));
    sendButton(inst, btn, on);
    listeners.forEach((l) => l());
};

const latchSet = (inst: string) => {
    let s = latched.get(inst);
    if (!s) latched.set(inst, (s = new Set()));
    return s;
};

export const usePressed = (inst: string) =>
    useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => {
                listeners.delete(l);
            };
        },
        () => pressed.get(inst) || NONE,
    );

// Returns true when the pointer should be captured (a plain hold).
export function buttonDown(inst: string, btn: string, pointerId: number, shift: boolean): boolean {
    const lat = latchSet(inst);
    if (shift) {
        const on = !lat.has(btn);
        if (on) lat.add(btn);
        else lat.delete(btn);
        set(inst, btn, on);
        return false;
    }
    if (lat.has(btn)) {
        lat.delete(btn);
        set(inst, btn, false);
        return false;
    }
    held.set(pointerId, { inst, btn });
    set(inst, btn, true);
    return true;
}

export function buttonUp(pointerId: number) {
    const h = held.get(pointerId);
    if (!h) return;
    held.delete(pointerId);
    if (!latchSet(h.inst).has(h.btn)) set(h.inst, h.btn, false);
}

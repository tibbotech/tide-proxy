import { useSyncExternalStore } from 'react';

// Per-viewer conveniences (layout, watched pins, panel sizes) kept in localStorage. Storage can be
// missing or throw (private windows), so everything falls back to the default.

export function loadLocal<T>(key: string, def: T): T {
    try {
        const v = localStorage.getItem(key);
        return v ? (JSON.parse(v) as T) : def;
    } catch {
        return def;
    }
}

export function saveLocal(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Nothing to do without storage.
    }
}

// A small store whose value persists; `use()` is the React hook.
export function persisted<T>(key: string, initial: T) {
    let value = loadLocal(key, initial);
    const listeners = new Set<() => void>();
    const subscribe = (l: () => void) => {
        listeners.add(l);
        return () => {
            listeners.delete(l);
        };
    };
    const get = () => value;
    return {
        get,
        set(next: T) {
            value = next;
            saveLocal(key, next);
            listeners.forEach((l) => l());
        },
        use: () => useSyncExternalStore(subscribe, get),
    };
}

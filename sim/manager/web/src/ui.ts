import { persisted } from './local';

export type InspectorTab = 'properties' | 'tibbits' | 'console' | 'io' | 'log' | 'wires';

// Panel state kept per viewer.
export const uiStore = persisted<{ tab: InspectorTab; height: number; collapsed: boolean }>('sim.ui', {
    tab: 'properties',
    height: 290,
    collapsed: false,
});

export const patchUi = (patch: Partial<ReturnType<typeof uiStore.get>>) => uiStore.set({ ...uiStore.get(), ...patch });

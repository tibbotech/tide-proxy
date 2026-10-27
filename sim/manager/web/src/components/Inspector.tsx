import { act, removeInstance } from '../actions';
import { patchUi, uiStore, type InspectorTab } from '../ui';
import type { Instance } from '../types';
import { Icon } from './icons';
import { ConsoleTab } from './tabs/ConsoleTab';
import { IoTab } from './tabs/IoTab';
import { LogTab } from './tabs/LogTab';
import { PropertiesTab } from './tabs/PropertiesTab';
import { WiresTab } from './tabs/WiresTab';

const TABS: Array<[InspectorTab, string]> = [
    ['properties', 'Properties'],
    ['console', 'Console'],
    ['io', 'IO'],
    ['log', 'Renode log'],
    ['wires', 'Wires'],
];

interface Props {
    inst: Instance | null;
    onUpload: (inst: Instance) => void;
}

export function Inspector({ inst, onUpload }: Props) {
    const ui = uiStore.use();

    const startResize = (e: React.PointerEvent) => {
        e.preventDefault();
        const sy = e.clientY;
        const h0 = ui.height;
        const move = (ev: PointerEvent) => patchUi({ height: Math.max(140, Math.min(window.innerHeight - 200, h0 + sy - ev.clientY)), collapsed: false });
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    const running = inst && (inst.status === 'running' || inst.status === 'starting');
    const needsDevice = ui.tab !== 'wires';

    return (
        <section className="inspector" style={{ height: ui.collapsed ? 'auto' : ui.height }}>
            <div className="resize-handle" onPointerDown={startResize} title="Drag to resize" />
            <header className="insp-head">
                <div className="tabs" role="tablist">
                    {TABS.map(([id, label]) => (
                        <button key={id} role="tab" aria-selected={ui.tab === id} className={`tab${ui.tab === id ? ' active' : ''}`} onClick={() => patchUi({ tab: id, collapsed: false })}>
                            {label}
                        </button>
                    ))}
                </div>
                <span className="spacer" />
                {inst && (
                    <div className="insp-actions">
                        <strong className="insp-name">{inst.name || inst.id}</strong>
                        <span className={`pill ${inst.status}`}>{inst.status + (inst.status === 'exited' && inst.exitCode !== undefined && inst.exitCode !== null ? ` (${inst.exitCode})` : '')}</span>
                        <button className="btn small" onClick={() => onUpload(inst)}>
                            <Icon name="upload" /> Upload firmware
                        </button>
                        {inst.monitor && inst.firmware ? (
                            <button className="btn small" title="Reinstall the app from the firmware ELF" onClick={() => act(inst.id, 'reflash')}>
                                Reflash
                            </button>
                        ) : null}
                        <button className="btn small" disabled={inst.status !== 'running'} onClick={() => act(inst.id, 'reset')}>
                            <Icon name="reset" /> Reset
                        </button>
                        <button className="btn small" onClick={() => act(inst.id, 'restart')}>
                            Restart
                        </button>
                        {running ? (
                            <button className="btn small" onClick={() => act(inst.id, 'stop')}>
                                <Icon name="stop" /> Stop
                            </button>
                        ) : (
                            <button className="btn small primary" disabled={!inst.canStart} onClick={() => act(inst.id, 'start')}>
                                <Icon name="play" /> Start
                            </button>
                        )}
                        <button className="icon-btn danger" title="Delete this device" onClick={() => confirm(`Delete ${inst.name}? Its flash and EEPROM contents are removed too.`) && removeInstance(inst)}>
                            <Icon name="trash" />
                        </button>
                    </div>
                )}
                <button className={`icon-btn collapse${ui.collapsed ? ' up' : ''}`} title={ui.collapsed ? 'Expand' : 'Collapse'} onClick={() => patchUi({ collapsed: !ui.collapsed })}>
                    <Icon name="chevron" />
                </button>
            </header>
            {!ui.collapsed && (
                <div className="insp-body">
                    {needsDevice && !inst ? (
                        <p className="empty-note">Select a device on the rail to see its {ui.tab === 'properties' ? 'properties' : ui.tab === 'io' ? 'GPIO' : ui.tab}.</p>
                    ) : ui.tab === 'properties' && inst ? (
                        <PropertiesTab key={inst.id} inst={inst} />
                    ) : ui.tab === 'console' && inst ? (
                        <ConsoleTab key={inst.id} inst={inst} />
                    ) : ui.tab === 'io' && inst ? (
                        <IoTab key={inst.id} inst={inst} />
                    ) : ui.tab === 'log' && inst ? (
                        <LogTab key={inst.id} />
                    ) : (
                        <WiresTab />
                    )}
                </div>
            )}
        </section>
    );
}

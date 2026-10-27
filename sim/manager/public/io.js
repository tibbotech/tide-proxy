'use strict';

// ---- IO view: live GPIO state of the open instance ----
// Levels and output masks come with every 'state' message (40 ms stream); the pin configuration
// (mode, pulls, alternate function, external drivers) comes as 'pinConfig' when it changes.
// Watched pins are per-viewer (localStorage).

const IO_PORTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const IO_TRACE_MS = 10000;
const IO_ACTIVE_MS = 400;
// STM32F2/F4 alternate functions (the same on both).
const AF_NAMES = ['SYS', 'TIM1/2', 'TIM3-5', 'TIM8-11', 'I2C1-3', 'SPI1/2', 'SPI3', 'USART1-3', 'UART4-6/USART6', 'CAN/TIM12-14', 'OTG', 'ETH', 'FSMC/SDIO', 'DCMI', 'AF14', 'EVENTOUT'];

const IO = {
    cfg: {}, // instance id -> { A: [moder, otyper, pupdr, afrl, afrh, extDriven, extLevel], ... }
    watch: loadLocal('sim.io.watch', {}), // instance id -> ['PA0', ...]
    builtFor: null,
    sel: null, // 'PB10'
    prev: {}, // port -> levels at the last update
    changedAt: {}, // 'PB10' -> time of the last level change
    hist: {}, // 'PB10' -> [[time, level], ...] for listed pins
    timer: null,
};

// Pins the board wires to something, plus the DTS buttons and LEDs: 'PB10' -> label.
function ioNamedPins(inst) {
    const profile = inst.profile || { buttons: [], leds: [] };
    const names = new Map();
    for (const b of profile.buttons) names.set(`P${b.port}${b.pin}`, b.id === 'mdbutton' ? 'MD button' : b.label);
    for (const l of profile.leds) names.set(`P${l.port}${l.pin}`, l.label);
    const board = [
        ['PA10', 'Blue bar RST'], ['PA11', 'Blue bar CLK'], ['PA12', 'Blue bar DATA'],
        ['PA15', 'DataFlash CS'], ['PB8', 'EEPROM SCL'], ['PB9', 'EEPROM SDA'],
    ];
    if (profile.lcd) {
        board.push(['PA9', 'LCD backlight'], ['PC0', 'LCD RD'], ['PC2', 'LCD WR'], ['PC3', 'LCD DC'], ['PB0', 'LCD CS'], ['PC13', 'LCD RESET']);
        for (let i = 0; i < 8; i++) board.push([`PE${i}`, `LCD D${i}`]);
    }
    for (const [pin, label] of board) if (!names.has(pin)) names.set(pin, label);
    return names;
}

function ioListed(inst) {
    const names = ioNamedPins(inst);
    const keys = [...names.keys()];
    for (const p of IO.watch[inst.id] || []) if (!names.has(p)) keys.push(p);
    // The LCD data bus is better read in the matrix; list its control lines only.
    return keys.filter((k) => !/^LCD D\d$/.test(names.get(k) || '')).map((k) => ({ key: k, label: names.get(k) || '' }));
}

function ioRunning(inst) {
    return inst.status === 'running' && !!(inst.state && inst.state.pins);
}

// Everything known about one pin, or null while the instance isn't running.
function ioPin(inst, port, pin) {
    if (!ioRunning(inst)) return null;
    const bit = 1 << pin;
    const level = ((inst.state.pins[port] || 0) & bit) !== 0;
    const c = (IO.cfg[inst.id] || {})[port];
    if (!c) {
        const out = (((inst.state.out || {})[port] || 0) & bit) !== 0;
        return { level, mode: out ? 'out' : 'in' };
    }
    const mode = ['in', 'out', 'af', 'an'][(c[0] >>> (2 * pin)) & 3];
    return {
        level,
        mode,
        od: ((c[1] >>> pin) & 1) === 1,
        pull: ['', 'up', 'down', ''][(c[2] >>> (2 * pin)) & 3],
        af: pin < 8 ? (c[3] >>> (4 * pin)) & 15 : (c[4] >>> (4 * (pin - 8))) & 15,
        ext: ((c[5] >>> pin) & 1) === 1 ? ((c[6] >>> pin) & 1) === 1 : null,
    };
}

function ioModeText(p) {
    if (!p) return '–';
    let t = p.mode === 'in' ? 'input' : p.mode === 'out' ? (p.od ? 'output, open-drain' : 'output') : p.mode === 'af' ? `AF${p.af} (${AF_NAMES[p.af]})` : 'analog';
    if (p.pull) t += `, pull-${p.pull}`;
    return t;
}

function ioCellText(p) {
    if (!p) return '';
    return p.mode === 'out' ? 'O' : p.mode === 'af' ? String(p.af) : p.mode === 'an' ? 'A' : '';
}

function ioSplit(key) {
    const m = /^P([A-I])(\d{1,2})$/.exec(key);
    return m ? [m[1], Number(m[2])] : null;
}

// Builds the pane for the open instance (on open, and when its firmware changes).
function ioBuild(inst) {
    IO.builtFor = inst.id;
    IO.sel = null;
    IO.prev = {};
    IO.changedAt = {};
    IO.hist = {};
    const pane = $('#paneIo');
    pane.textContent = '';

    const names = ioNamedPins(inst);
    const head = el('tr', {}, el('th', {}), ...Array.from({ length: 16 }, (_, i) => el('th', {}, String(i))));
    const rows = IO_PORTS.map((port) => el('tr', {},
        el('th', {}, `P${port}`),
        ...Array.from({ length: 16 }, (_, pin) => {
            const key = `P${port}${pin}`;
            return el('td', {}, el('button', {
                class: `iopin${names.has(key) ? ' named' : ''}`,
                'data-io': key,
                onclick: () => ioSelect(inst.id, key),
            }));
        })));
    pane.append(
        el('div', { class: 'io-legend' },
            el('span', {}, el('i', { class: 'iopin hi' }), 'high'),
            el('span', {}, el('i', { class: 'iopin' }), 'low'),
            el('span', {}, el('i', { class: 'iopin m-out' }, 'O'), 'output'),
            el('span', {}, el('i', { class: 'iopin m-af' }, '7'), 'alt. function'),
            el('span', {}, el('i', { class: 'iopin m-an' }, 'A'), 'analog'),
            el('span', {}, el('i', { class: 'iopin ext' }), 'driven externally'),
            el('span', {}, el('i', { class: 'iopin named' }), 'named'),
            el('span', { class: 'io-note', id: 'ioNote' })),
        el('div', { class: 'io-scroll' }, el('table', { class: 'io-matrix' }, el('thead', {}, head), el('tbody', {}, rows))),
        el('div', { class: 'io-inspect', id: 'ioInspect' }),
        el('div', { class: 'io-list', id: 'ioList' }));
    ioBuildList(inst);
    ioInspect(inst);
    ioUpdate(inst);
}

function ioBuildList(inst) {
    const list = $('#ioList');
    list.textContent = '';
    const watched = IO.watch[inst.id] || [];
    for (const { key, label } of ioListed(inst)) {
        list.append(el('div', { class: 'io-row', 'data-row': key, onclick: () => ioSelect(inst.id, key) },
            el('span', { class: 'io-key' }, key),
            el('span', { class: 'io-label' }, label || (watched.includes(key) ? 'watched' : '')),
            el('span', { class: 'io-mode' }),
            el('span', { class: 'io-lvl' }),
            el('canvas', { class: 'io-trace', width: 180, height: 18 })));
    }
}

function ioSelect(id, key) {
    IO.sel = IO.sel === key ? null : key;
    const inst = S.instances.find((i) => i.id === id);
    if (inst) {
        ioInspect(inst);
        ioUpdate(inst);
    }
}

function ioInspect(inst) {
    const box = $('#ioInspect');
    box.textContent = '';
    if (!IO.sel) {
        box.append(el('span', { class: 'muted' }, 'Select a pin to see its configuration and drive it.'));
        return;
    }
    const [port, pin] = ioSplit(IO.sel);
    const label = ioNamedPins(inst).get(IO.sel);
    const watched = (IO.watch[inst.id] || []).includes(IO.sel);
    const drive = (level) => send({ t: 'input', id: inst.id, port, pin, level });
    box.append(...[
        el('strong', { class: 'io-key' }, IO.sel),
        label && el('span', {}, label),
        el('span', { class: 'muted', id: 'ioSelInfo' }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn small', title: 'Drive the line high, as an external circuit would', onclick: () => drive(1) }, 'Drive high'),
        el('button', { class: 'btn small', title: 'Drive the line low', onclick: () => drive(0) }, 'Drive low'),
        el('button', { class: 'btn small', title: 'Stop driving the line (Hi-Z)', onclick: () => drive(null) }, 'Release'),
        !label && el('button', { class: 'btn small', onclick: () => ioToggleWatch(inst, IO.sel) }, watched ? 'Unwatch' : 'Watch'),
    ].filter(Boolean));
}

function ioToggleWatch(inst, key) {
    const list = IO.watch[inst.id] || [];
    IO.watch[inst.id] = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
    if (!IO.watch[inst.id].length) delete IO.watch[inst.id];
    saveLocal('sim.io.watch', IO.watch);
    ioBuildList(inst);
    ioInspect(inst);
    ioUpdate(inst);
}

// Applies the latest state to the pane: cell classes, the inspector line and the list.
function ioUpdate(inst) {
    if (IO.builtFor !== inst.id || !$('#paneIo').childElementCount) return;
    const now = performance.now();
    const running = ioRunning(inst);
    const names = ioNamedPins(inst);
    const listed = ioListed(inst).map((r) => r.key);
    if (running) {
        for (const port of IO_PORTS) {
            const lv = inst.state.pins[port] || 0;
            const was = IO.prev[port];
            if (was !== undefined && was !== lv) {
                for (let pin = 0; pin < 16; pin++) if (((was ^ lv) >> pin) & 1) IO.changedAt[`P${port}${pin}`] = now;
            }
            IO.prev[port] = lv;
        }
        for (const key of listed) {
            const [port, pin] = ioSplit(key);
            const v = ((inst.state.pins[port] || 0) >> pin) & 1;
            const h = IO.hist[key] || (IO.hist[key] = []);
            if (!h.length || h[h.length - 1][1] !== v) h.push([now, v]);
            while (h.length > 1 && h[1][0] < now - IO_TRACE_MS) h.shift();
        }
    }
    // History keeps being recorded while another tab is shown.
    if ($('#paneIo').hidden) return;
    $('#ioNote').textContent = running ? (IO.cfg[inst.id] ? '' : 'pin modes arrive after a restart of this instance') : 'not running';
    document.querySelectorAll('#paneIo [data-io]').forEach((cell) => {
        const [port, pin] = ioSplit(cell.dataset.io);
        const p = ioPin(inst, port, pin);
        cell.classList.toggle('off', !p);
        cell.classList.toggle('hi', !!p && p.level);
        cell.classList.toggle('m-out', !!p && p.mode === 'out');
        cell.classList.toggle('m-af', !!p && p.mode === 'af');
        cell.classList.toggle('m-an', !!p && p.mode === 'an');
        cell.classList.toggle('ext', !!p && p.ext !== null && p.ext !== undefined);
        cell.classList.toggle('sel', IO.sel === cell.dataset.io);
        const text = ioCellText(p);
        if (cell.textContent !== text) cell.textContent = text;
        const label = names.get(cell.dataset.io);
        cell.title = `${cell.dataset.io}${label ? ` · ${label}` : ''}\n${p ? `${p.level ? 'high' : 'low'} · ${ioModeText(p)}` : 'not running'}`;
    });
    if (IO.sel) {
        const [port, pin] = ioSplit(IO.sel);
        const p = ioPin(inst, port, pin);
        const info = $('#ioSelInfo');
        if (info) {
            info.textContent = p
                ? `${p.level ? 'HIGH' : 'LOW'} · ${ioModeText(p)}${p.ext === true ? ' · driven high externally' : p.ext === false ? ' · driven low externally' : ''}${p.mode === 'out' && !p.od ? ' · a push-pull output wins over an external drive' : ''}`
                : 'not running';
        }
    }
    document.querySelectorAll('#ioList [data-row]').forEach((row) => {
        const [port, pin] = ioSplit(row.dataset.row);
        const p = ioPin(inst, port, pin);
        row.classList.toggle('sel', IO.sel === row.dataset.row);
        row.querySelector('.io-mode').textContent = ioModeText(p);
        const lvl = row.querySelector('.io-lvl');
        lvl.textContent = p ? (p.level ? 'HIGH' : 'LOW') : '–';
        lvl.classList.toggle('hi', !!p && p.level);
    });
    ioTick();
}

// Activity highlight and traces move with time even when no state arrives.
function ioTick() {
    const inst = S.instances.find((i) => i.id === S.detail);
    const visible = inst && IO.builtFor === inst.id && !$('#paneIo').hidden;
    if (!visible) {
        clearInterval(IO.timer);
        IO.timer = null;
        return;
    }
    if (!IO.timer) IO.timer = setInterval(ioTick, 100);
    const now = performance.now();
    document.querySelectorAll('#paneIo [data-io]').forEach((cell) => {
        cell.classList.toggle('act', now - (IO.changedAt[cell.dataset.io] || -1e9) < IO_ACTIVE_MS);
    });
    const style = getComputedStyle(document.documentElement);
    const hiColor = style.getPropertyValue('--gpio-hi').trim() || '#f59e0b';
    const loColor = style.getPropertyValue('--muted').trim() || '#888';
    const running = ioRunning(inst);
    document.querySelectorAll('#ioList [data-row]').forEach((row) => {
        const c = row.querySelector('canvas');
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);
        const h = IO.hist[row.dataset.row];
        if (!h || !h.length) return;
        const x = (t) => c.width - ((now - t) / IO_TRACE_MS) * c.width;
        const y = (v) => (v ? 3 : c.height - 3);
        ctx.lineWidth = 1.5;
        let px = Math.max(0, x(h[0][0]));
        for (let i = 0; i < h.length; i++) {
            const end = i + 1 < h.length ? x(h[i + 1][0]) : running ? c.width : px;
            ctx.strokeStyle = h[i][1] ? hiColor : loColor;
            ctx.beginPath();
            if (i > 0) ctx.moveTo(px, y(h[i - 1][1]));
            else ctx.moveTo(px, y(h[i][1]));
            ctx.lineTo(px, y(h[i][1]));
            ctx.lineTo(Math.max(px, end), y(h[i][1]));
            ctx.stroke();
            px = Math.max(px, end);
        }
    });
}

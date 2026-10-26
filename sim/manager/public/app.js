'use strict';

// ---- state ----
const S = {
    instances: [],
    monitors: {},
    frames: new Map(), // id -> { image: ImageData, canvases: Set<HTMLCanvasElement> }
    detail: null, // instance id
    uart: null,
    latched: new Set(),
    info: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null) e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c !== null && c !== undefined) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
};

async function api(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
}

// ---- websocket ----
let ws;
function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => subscribe();
    ws.onclose = () => setTimeout(connect, 1500);
    ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') {
            onLcd(ev.data);
            return;
        }
        const msg = JSON.parse(ev.data);
        switch (msg.t) {
        case 'instances':
            S.instances = msg.list;
            render();
            break;
        case 'state': {
            const inst = S.instances.find((i) => i.id === msg.id);
            if (inst) {
                inst.state = msg.state;
                updateIndicators(inst);
                if (S.wiring) updateWiringLive();
            }
            break;
        }
        case 'links':
            S.links = msg.links;
            S.linkStats = msg.stats;
            if (S.wiring) renderWiring();
            break;
        case 'linkStats':
            S.linkStats = msg.stats;
            if (S.wiring) updateWiringLive();
            break;
        case 'uart':
            if (msg.id === S.detail && msg.uart === S.uart) termWrite(atob(msg.data));
            break;
        case 'backlog':
            if (msg.id === S.detail && msg.uart === S.uart) {
                termReset();
                termWrite(atob(msg.data));
            }
            break;
        case 'log':
            if (msg.id === S.detail) appendLog([msg.line]);
            break;
        case 'logBacklog':
            if (msg.id === S.detail) {
                $('#renodeLog').textContent = '';
                appendLog(msg.lines);
            }
            break;
        case 'error':
            console.warn(msg.message);
            break;
        }
    };
}

function subscribe() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        // The wiring view shows no LCDs.
        ws.send(JSON.stringify({ t: 'sub', lcd: S.detail ? [S.detail] : S.wiring ? [] : '*', detail: S.detail }));
    }
}

function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---- LCD ----
function frameFor(id, w, h) {
    let f = S.frames.get(id);
    if (!f || f.image.width !== w || f.image.height !== h) {
        const image = new ImageData(w, h);
        for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
        f = { image, canvases: f ? f.canvases : new Set() };
        S.frames.set(id, f);
    }
    return f;
}

function onLcd(buf) {
    const bytes = new Uint8Array(buf);
    const idLen = bytes[0];
    const id = new TextDecoder().decode(bytes.subarray(1, 1 + idLen));
    const dv = new DataView(buf, 1 + idLen);
    const x = dv.getUint16(0, true), y = dv.getUint16(2, true), w = dv.getUint16(4, true), h = dv.getUint16(6, true);
    const rgb = bytes.subarray(1 + idLen + 8);
    const inst = S.instances.find((i) => i.id === id);
    const lcd = inst && inst.state && inst.state.lcd;
    const fw = lcd ? lcd.width : Math.max(320, x + w);
    const fh = lcd ? lcd.height : Math.max(240, y + h);
    const f = frameFor(id, fw, fh);
    const d = f.image.data;
    let o = 0;
    for (let row = 0; row < h; row++) {
        let p = ((y + row) * fw + x) * 4;
        for (let col = 0; col < w; col++, p += 4) {
            d[p] = rgb[o++];
            d[p + 1] = rgb[o++];
            d[p + 2] = rgb[o++];
        }
    }
    paint(id);
}

function paint(id) {
    const f = S.frames.get(id);
    if (!f) return;
    for (const c of f.canvases) {
        if (!c.isConnected) {
            f.canvases.delete(c);
            continue;
        }
        if (c.width !== f.image.width || c.height !== f.image.height) {
            c.width = f.image.width;
            c.height = f.image.height;
        }
        c.getContext('2d').putImageData(f.image, 0, 0);
    }
}

function bindCanvas(id, canvas) {
    let f = S.frames.get(id);
    if (!f) {
        f = frameFor(id, 320, 240);
    }
    f.canvases.add(canvas);
    paint(id);
}

// ---- board art (boards/*.svg) ----
// Faceplates with data-part hooks: lcd, key-0..3, md, link-led, blue-led-0..4, red-led, green-led.
const SVG_NS = 'http://www.w3.org/2000/svg';
const BOARD_ART = {};
let artSeq = 0;

async function loadBoardArt() {
    await Promise.all(['tps2', 'tps2l', 'tps3'].map(async (name) => {
        const res = await fetch(`boards/${name}.svg`).catch(() => null);
        if (res && res.ok) BOARD_ART[name] = await res.text();
    }));
}

function boardArtName(inst, profile) {
    if (/^tpp3/i.test(inst.board || profile.board || '')) return 'tps3';
    return profile.lcd ? 'tps2l' : 'tps2';
}

// Inline copy of the faceplate, or null if the art didn't load. Gradient ids get a per-copy suffix:
// copies share the page, and a reference into a hidden copy (grid vs. detail view) doesn't render.
function boardSvg(inst, profile) {
    const text = BOARD_ART[boardArtName(inst, profile)];
    if (!text) return null;
    const sfx = `-b${++artSeq}`;
    const holder = document.createElement('div');
    holder.innerHTML = text.replace(/id="([^"]+)"/g, `id="$1${sfx}"`).replace(/url\(#([^)]+)\)/g, `url(#$1${sfx})`);
    return holder.querySelector('svg');
}

// Faceplate for an instance, with LEDs wired for updateIndicators() and, when `interactive`, the
// MD pinhole and front keys bound to the board's buttons. `canvas` goes into the LCD window if the
// art has one; `lcdInArt` says whether it did.
function boardView(inst, canvas, interactive) {
    const profile = inst.profile || { buttons: [], leds: [] };
    const svg = boardSvg(inst, profile);
    if (!svg) return null;
    const part = (name) => svg.querySelector(`[data-part="${name}"]`);
    const titled = (node, text) => {
        const t = document.createElementNS(SVG_NS, 'title');
        t.textContent = text;
        node.append(t);
    };

    let lcdInArt = false;
    const lcd = part('lcd');
    if (lcd && profile.lcd && canvas) {
        const fo = document.createElementNS(SVG_NS, 'foreignObject');
        for (const a of ['x', 'y', 'width', 'height']) fo.setAttribute(a, lcd.getAttribute(a));
        fo.append(canvas);
        lcd.after(fo);
        lcdInArt = true;
    }

    const mapped = new Set();
    for (const color of ['red', 'green']) {
        const led = profile.leds.find((l) => ledClass(l) === color);
        const node = part(`${color}-led`);
        if (led && node) {
            node.dataset.led = led.id;
            titled(node, led.label);
            mapped.add(led.id);
        } else if (node) {
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

    if (interactive) {
        const md = profile.buttons.find((b) => b.id === 'mdbutton');
        const keys = profile.buttons.filter((b) => b.id !== 'mdbutton');
        const bind = (node, b) => {
            if (!node || !b) return;
            node.classList.add('press');
            titled(node, `${b.label} — P${b.port}${b.pin}`);
            bindButton(node, inst, b);
        };
        bind(part('md'), md);
        keys.slice(0, 4).forEach((b, i) => bind(part(`key-${i}`), b));
    }

    const root = el('div', { class: 'board' });
    root.append(svg);
    return { root, lcdInArt, mappedLeds: mapped };
}

// ---- pins / indicators ----
function pinLevel(inst, port, pin) {
    const pins = inst.state && inst.state.pins;
    if (!pins || pins[port] === undefined) return null;
    return ((pins[port] >> pin) & 1) === 1;
}

function ledOn(inst, led) {
    const lvl = pinLevel(inst, led.port, led.pin);
    return lvl === null ? false : lvl !== led.activeLow;
}

function ledClass(led) {
    const l = (led.label + ' ' + led.id).toLowerCase();
    return l.includes('green') ? 'green' : l.includes('red') ? 'red' : 'other';
}

function ledDots(inst, leds) {
    return leds.map((led) => el('span', { class: `dot ${ledClass(led)}${ledOn(inst, led) ? ' on' : ''}`, title: led.label, 'data-led': led.id }));
}

function updateIndicators(inst) {
    const profile = inst.profile;
    if (!profile) return;
    const scope = `[data-inst="${inst.id}"]`;
    document.querySelectorAll(`${scope} [data-led]`).forEach((dot) => {
        const led = profile.leds.find((l) => l.id === dot.dataset.led);
        if (led) dot.classList.toggle('on', ledOn(inst, led));
    });
    const bar = inst.state ? inst.state.blueBar : 0;
    document.querySelectorAll(`${scope} [data-blue]`).forEach((n) => n.classList.toggle('on', ((bar >> (4 - Number(n.dataset.blue))) & 1) === 1));
    // The simulated LAN is always up while the instance runs.
    document.querySelectorAll(`${scope} [data-link]`).forEach((n) => n.classList.toggle('on', inst.status === 'running'));
    const lcd = inst.state && inst.state.lcd;
    const dark = !lcd || !lcd.on || !lcd.backlight;
    document.querySelectorAll(`${scope} canvas`).forEach((c) => c.classList.toggle('dark', dark && inst.status === 'running'));
    if (S.detail === inst.id) {
        $('#dBacklight').textContent = lcd ? `Backlight ${lcd.backlight ? 'on' : 'off'} · display ${lcd.on ? 'on' : 'off'}` : '';
        const vt = inst.state ? (inst.state.vtime / 1000).toFixed(1) + ' s' : '–';
        const vtEl = document.getElementById('dVtime');
        if (vtEl) vtEl.textContent = vt;
    }
}

// ---- rendering ----
function render() {
    renderMonitors();
    if (S.wiring) {
        renderWiring();
        return;
    }
    if (S.detail && !S.instances.find((i) => i.id === S.detail)) {
        showGrid();
        return;
    }
    if (S.detail) renderDetail();
    else renderGrid();
}

function boardLabel(inst) {
    return (inst.board || '').toUpperCase();
}

function statusPill(status) {
    return el('span', { class: `pill ${status}` }, status);
}

function renderGrid() {
    const grid = $('#grid');
    grid.textContent = '';
    $('#instCount').textContent = S.instances.length ? `${S.instances.length} · ${S.instances.filter((i) => i.status === 'running').length} running` : '';
    $('#emptyHint').hidden = S.instances.length > 0;
    for (const inst of S.instances) {
        const canvas = el('canvas', { width: 320, height: 240 });
        const running = inst.status === 'running' || inst.status === 'starting';
        // Faceplate unless the LCD would be lost (an LCD build on art without a screen window).
        const board = boardView(inst, canvas, false);
        const hasLcd = !!(inst.profile && inst.profile.lcd);
        const face = board && (board.lcdInArt || !hasLcd) ? board.root : canvas;
        const card = el('article', { class: 'card', 'data-inst': inst.id },
            el('div', { class: 'screen', onclick: () => showDetail(inst.id), title: 'Open' }, face),
            el('div', { class: 'body' },
                el('div', { class: 'title' }, el('strong', {}, inst.name), statusPill(inst.status)),
                el('div', { class: 'info' },
                    el('span', {}, inst.tibboMac),
                    el('span', {}, inst.ip),
                    el('span', {}, `${boardLabel(inst)} · ${inst.firmware ? inst.firmware.name : 'no firmware'}`)),
                el('div', { class: 'title' },
                    el('span', { class: 'dots' }, ledDots(inst, (inst.profile && inst.profile.leds.slice(0, 6)) || [])),
                    el('span', { class: 'ops' },
                        el('button', { class: 'btn small', onclick: () => showDetail(inst.id) }, 'Open'),
                        running
                            ? el('button', { class: 'btn small', onclick: () => act(inst.id, 'reset') }, 'Reset')
                            : null,
                        running || inst.canStart
                            ? el('button', { class: 'btn small', onclick: () => act(inst.id, running ? 'stop' : 'start') }, running ? 'Stop' : 'Start')
                            : el('button', { class: 'btn small', onclick: () => openUpload(inst) }, 'Upload firmware'),
                        el('button', { class: 'btn small danger', onclick: () => removeInstance(inst) }, 'Delete')))));
        grid.append(card);
        bindCanvas(inst.id, canvas);
        updateIndicators(inst);
    }
}

function renderMonitors() {
    const mons = $('#monitorList');
    mons.textContent = '';
    for (const gen of ['g2', 'g3']) {
        const m = S.monitors[gen];
        mons.append(el('div', { class: 'fw' },
            el('div', {},
                el('strong', {}, `${gen.toUpperCase()}: ${m ? m.name : 'boot stub'}`),
                el('div', { class: 'meta' }, m ? `${m.size} bytes · set ${new Date(m.uploadedAt).toLocaleString()}` : 'no UDP firmware upload')),
            el('button', { class: 'btn small', onclick: () => pickMonitor(gen) }, m ? 'Replace' : 'Upload'),
            m ? el('button', { class: 'btn small danger', onclick: () => removeMonitor(gen) }, 'Remove') : null));
    }
}

let renderedDetail = null;
function renderDetail() {
    const inst = S.instances.find((i) => i.id === S.detail);
    if (!inst) return;
    const profile = inst.profile || { buttons: [], leds: [], uarts: [] };
    $('#dName').textContent = inst.name;
    const pill = $('#dStatus');
    pill.className = `pill ${inst.status}`;
    pill.textContent = inst.status + (inst.status === 'exited' && inst.exitCode !== undefined ? ` (${inst.exitCode})` : '');
    const running = inst.status === 'running' || inst.status === 'starting';
    document.querySelector('[data-act="start"]').hidden = running;
    document.querySelector('[data-act="start"]').disabled = !inst.canStart;
    document.querySelector('[data-act="stop"]').hidden = !running;
    document.querySelector('[data-act="reset"]').disabled = inst.status !== 'running';
    document.querySelector('[data-act="reflash"]').hidden = !inst.monitor || !inst.firmware;

    const webUrl = `${location.protocol}//${location.hostname}:${inst.httpPort}/`;
    const facts = $('#dFacts');
    facts.textContent = '';
    const fact = (k, v) => facts.append(el('dt', {}, k), el('dd', {}, v));
    fact('MAC', `${inst.tibboMac}  (${inst.mac})`);
    fact('IP', `${inst.ip} (DHCP reservation)`);
    fact('Board', `${boardLabel(inst)} (${inst.generation === 'g3' ? 'STM32F439' : 'STM32F207'})${profile.board && profile.board !== inst.board ? ` · DTS ${profile.board}` : ''}`);
    const fw = inst.firmware;
    const mon = inst.bootMonitor;
    fact('Firmware', fw
        ? `${fw.name} · ${new Date(fw.uploadedAt).toLocaleString()}${fw.hasDts ? '' : ' · no DTS (TPP defaults)'}`
        : mon ? 'none (upload a .elf, or from TIDE through the monitor)' : 'none (upload a .elf or a monitor .bin to start)');
    fact('Monitor', mon
        ? el('span', {},
            `${mon.name} · ${mon.own ? 'this instance' : `${inst.generation.toUpperCase()} default`} `,
            mon.own ? el('button', { class: 'btn small', onclick: () => useDefaultMonitor(inst) }, S.monitors[inst.generation] ? 'Use default' : 'Remove') : null)
        : 'none (boot stub)');
    const writes = inst.flashWrites || [];
    if (writes.length) {
        fact('Flash .bin', writes.map((w) => `${w.name} @ ${hexAddr(w.address)} (${w.size} B)`).join('\n'));
    }
    fact('Boot', inst.monitor ? 'Tibbo monitor (UDP upload)' : 'boot stub');
    fact('Device web', el('a',{ href: webUrl, target: '_blank', rel: 'noopener' }, webUrl));
    fact('Renode monitor', `port ${inst.monitorPort} inside the container`);
    fact('Virtual time', el('span', { id: 'dVtime' }, '–'));

    // Rebuilt when the firmware changes too: a new DTS can bring other buttons, LEDs and UARTs.
    const key = `${inst.id}|${fw ? fw.uploadedAt : ''}`;
    if (renderedDetail !== key) {
        renderedDetail = key;
        S.latched.clear();
        $('#dDevice').setAttribute('data-inst', inst.id);

        // Board faceplate; the LCD sits in its screen window, or in the plain bezel below when the
        // art has none. LEDs the faceplate shows are left out of the list under it.
        const boardHost = $('#dBoard');
        boardHost.textContent = '';
        const artCanvas = el('canvas', { width: 320, height: 240 });
        const board = boardView(inst, artCanvas, true);
        if (board) boardHost.append(board.root);
        const lcdInArt = !!(board && board.lcdInArt);
        if (lcdInArt) bindCanvas(inst.id, artCanvas);
        $('#dBezel').hidden = lcdInArt || (!!board && !profile.lcd);
        bindCanvas(inst.id, $('#dLcd'));
        $('#dNoLcd').hidden = !!profile.lcd;

        const leds = $('#dLeds');
        leds.textContent = '';
        for (const led of profile.leds) {
            if (board && board.mappedLeds.has(led.id)) continue;
            leds.append(el('span', { class: 'led' }, el('span', { class: `dot ${ledClass(led)}`, 'data-led': led.id }), led.label));
        }
        const blue = $('#dBlue');
        blue.textContent = '';
        blue.hidden = !!board;
        for (let i = 0; i < 5; i++) blue.append(el('span', { 'data-blue': String(i) }));

        const buttons = $('#dButtons');
        buttons.textContent = '';
        for (const b of profile.buttons) buttons.append(hwButton(inst, b));

        // 'udp' is the debug print read over the Tibbo UDP protocol; UARTs follow.
        const consoles = inst.consoles || ['udp'];
        const uartSel = $('#dUart');
        uartSel.textContent = '';
        for (const u of consoles) {
            const label = u === 'udp' ? 'udp (debug print)' : u + (u === profile.consoleUart ? ' (zephyr console)' : '');
            uartSel.append(el('option', { value: u }, label));
        }
        S.uart = consoles[0];
        uartSel.value = S.uart;
        uartSel.hidden = consoles.length < 2;
        termReset();
        $('#renodeLog').textContent = '';
        subscribe();
    }
    updateIndicators(inst);
}

function hwButton(inst, b) {
    const label = b.id === 'mdbutton' ? 'MD' : b.label.replace(/ button$/i, '');
    const btn = el('button', { class: 'hwbtn', title: `${b.label} — P${b.port}${b.pin}` }, label);
    bindButton(btn, inst, b);
    return btn;
}

// Hold to press, shift+click to latch. Every control for the same button (row button, faceplate
// key) shows the pressed state.
function bindButton(btn, inst, b) {
    btn.dataset.btn = b.id;
    const press = (pressed) => {
        document.querySelectorAll(`#dDevice [data-btn="${b.id}"]`).forEach((n) => n.classList.toggle('pressed', pressed));
        send({ t: 'input', id: inst.id, button: b.id, pressed });
    };
    btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (e.shiftKey) {
            const on = !S.latched.has(b.id);
            on ? S.latched.add(b.id) : S.latched.delete(b.id);
            press(on);
            return;
        }
        if (S.latched.has(b.id)) {
            S.latched.delete(b.id);
            press(false);
            return;
        }
        btn.setPointerCapture(e.pointerId);
        press(true);
    });
    const up = () => {
        if (btn.classList.contains('pressed') && !S.latched.has(b.id)) press(false);
    };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
}

// ---- terminal ----
let term, fit, fallback;
function initTerm() {
    const host = $('#term');
    if (window.Terminal) {
        term = new window.Terminal({ convertEol: false, fontSize: 12, scrollback: 5000, theme: { background: '#0b0d12' } });
        if (window.FitAddon) {
            fit = new window.FitAddon.FitAddon();
            term.loadAddon(fit);
        }
        term.open(host);
        // Keyboard input goes to UART consoles only; debug print is output-only.
        term.onData((d) => S.detail && S.uart && S.uart !== 'udp' && send({ t: 'console', id: S.detail, uart: S.uart, data: d }));
        window.addEventListener('resize', () => fit && fit.fit());
    } else {
        fallback = el('pre', { class: 'fallback-term' });
        host.append(fallback);
    }
}

function termReset() {
    if (term) {
        term.reset();
        setTimeout(() => fit && fit.fit(), 0);
    } else if (fallback) fallback.textContent = '';
}

function termWrite(s) {
    if (term) term.write(s);
    else if (fallback) {
        fallback.textContent += s.replace(/\x1b\[[0-9;]*m/g, '');
        fallback.scrollTop = fallback.scrollHeight;
    }
}

function appendLog(lines) {
    const pre = $('#renodeLog');
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.textContent += lines.join('\n') + '\n';
    if (pre.textContent.length > 200000) pre.textContent = pre.textContent.slice(-150000);
    if (atBottom) pre.scrollTop = pre.scrollHeight;
}

// ---- navigation & actions ----
function showDetail(id) {
    S.detail = id;
    S.wiring = false;
    renderedDetail = null;
    $('#gridView').hidden = true;
    $('#wiringView').hidden = true;
    $('#detailView').hidden = false;
    history.replaceState(null, '', `#${id}`);
    renderDetail();
    setTimeout(() => fit && fit.fit(), 0);
}

function showGrid() {
    S.detail = null;
    S.wiring = false;
    renderedDetail = null;
    $('#gridView').hidden = false;
    $('#detailView').hidden = true;
    $('#wiringView').hidden = true;
    history.replaceState(null, '', location.pathname);
    subscribe();
    renderGrid();
}

async function act(id, action) {
    try {
        await api('POST', `/api/instances/${id}/${action}`);
    } catch (e) {
        alert(e.message);
    }
}

async function removeInstance(inst) {
    if (!confirm(`Delete ${inst.name}? Its flash and EEPROM contents are removed too.`)) return;
    await api('DELETE', `/api/instances/${inst.id}`).catch((e) => alert(e.message));
}

async function loadMonitors() {
    S.monitors = await api('GET', '/api/monitors').catch(() => ({}));
    render();
}

let monitorGen = null;
function pickMonitor(gen) {
    monitorGen = gen;
    $('#monitorFile').value = '';
    $('#monitorFile').click();
}

async function removeMonitor(gen) {
    if (!confirm(`Remove the ${gen.toUpperCase()} monitor? Instances started afterwards use the boot stub.`)) return;
    await api('DELETE', `/api/monitors/${gen}`).catch((e) => alert(e.message));
    loadMonitors();
}

async function loadInfo() {
    try {
        S.info = await api('GET', '/api/info');
        const r = S.info.relay;
        $('#relayInfo').textContent = `Renode · sim LAN ${S.info.subnet} · tide-proxy relay udp/${S.info.relayPort} · ${r.clients.length} client${r.clients.length === 1 ? '' : 's'}`;
    } catch {
        $('#relayInfo').textContent = 'Renode · manager unreachable';
    }
}

function openNew() {
    const form = $('#formNew');
    const board = form.elements.board.value;
    form.reset();
    form.elements.board.value = board;
    $('#newError').textContent = '';
    updateNewHint();
    $('#dlgNew').showModal();
}

// What a new instance boots: the picked ELF, a monitor's Loader (picked .bin or the default), or nothing yet.
function updateNewHint() {
    const f = $('#formNew').elements;
    const gen = f.board.value.slice(-2);
    let picked = {};
    try {
        picked = pickedFiles(f.files);
    } catch {}
    describeFiles(f, gen, $('#addrNew'), $('#newFiles'));
    const monBin = picked.bin && parseHex(f.binAddress.value) === FLASH_START;
    const mon = monBin ? picked.bin.name : S.monitors[gen] ? `the ${gen.toUpperCase()} default monitor` : null;
    let hint, start = true;
    if (picked.elf) hint = mon ? `Boots through ${mon} into this app.` : 'Boots this app (no monitor: boot stub).';
    else if (mon) hint = `No app: boots into the Loader of ${mon}, ready for an upload from TIDE. You can also upload a .elf later.`;
    else if (picked.bin) hint = 'Boots what the .bin puts into flash (an app at the app base runs through the boot stub).';
    else {
        hint = `No app and no monitor: the instance is created stopped. Upload a .elf or a .bin to it to start it.`;
        start = false;
    }
    $('#newHint').textContent = hint;
    $('#btnDoNew').textContent = start ? 'Create & start' : 'Create';
}

let uploadInst = null;
function openUpload(inst) {
    uploadInst = inst.id;
    $('#formUpload').reset();
    describeFiles($('#formUpload').elements, inst.generation, $('#addrUpload'), $('#uploadFiles'));
    $('#uploadTarget').textContent = `· ${inst.name} (${boardLabel(inst)})`;
    $('#uploadError').textContent = '';
    $('#dlgUpload').showModal();
}

// Files picked in a multi-file input, by type: { elf, dts, bin }.
function pickedFiles(input) {
    const out = {};
    for (const file of input.files) {
        const ext = (file.name.match(/\.(elf|dts|bin)$/i) || [])[1];
        if (!ext) throw new Error(`${file.name}: pick .elf, .dts or .bin files`);
        const key = ext.toLowerCase();
        if (out[key]) throw new Error(`more than one .${key} picked`);
        out[key] = file;
    }
    return out;
}

// Well-known places for a .bin in each generation's flash.
const FLASH_START = 0x08000000;
const FLASH_ADDRESSES = {
    g2: [[FLASH_START, 'monitor'], [0x08008000, 'app image with TiOS header'], [0x08008200, 'app']],
    g3: [[FLASH_START, 'monitor'], [0x08040000, 'app image with TiOS header'], [0x08040200, 'app']],
};

function parseHex(v) {
    const t = String(v).trim().replace(/^0x/i, '');
    return /^[0-9a-f]{1,8}$/i.test(t) ? parseInt(t, 16) : NaN;
}

function hexAddr(n) {
    return '0x' + n.toString(16).padStart(8, '0');
}

// Shows what each picked file of form `f` becomes, and the .bin address field (with the well-known
// addresses of `gen` as suggestions) only when a .bin is picked.
function describeFiles(f, gen, datalist, target) {
    const known = FLASH_ADDRESSES[gen] || [];
    datalist.textContent = '';
    for (const [addr, what] of known) datalist.append(el('option', { value: hexAddr(addr) }, what));
    let p = {};
    try {
        p = pickedFiles(f.files);
    } catch (e) {
        target.textContent = e.message;
        return;
    }
    f.binAddress.closest('label').hidden = !p.bin;
    const addr = parseHex(f.binAddress.value);
    const place = Number.isNaN(addr) ? 'nowhere: the address is not hex'
        : `flash @ ${hexAddr(addr)}${(known.find(([a]) => a === addr) || [])[1] ? ` (${known.find(([a]) => a === addr)[1]})` : ''}`;
    target.textContent = [
        p.elf && `${p.elf.name} → app`,
        p.dts && `${p.dts.name} → devicetree`,
        p.bin && `${p.bin.name} → ${place}`,
    ].filter(Boolean).join(' · ');
}

// The request fields for the picked files of form `f`: { elf, elfName, dts, bin, binName, binAddress }
// (absent ones left out).
async function firmwareFields(f) {
    const p = pickedFiles(f.files);
    return {
        elf: p.elf && await fileToBase64(p.elf),
        elfName: p.elf && p.elf.name,
        dts: p.dts && await p.dts.text(),
        bin: p.bin && await fileToBase64(p.bin),
        binName: p.bin && p.bin.name,
        binAddress: p.bin ? f.binAddress.value : undefined,
    };
}

async function useDefaultMonitor(inst) {
    await api('DELETE', `/api/instances/${inst.id}/monitor`).catch((e) => alert(e.message));
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}

function setup() {
    $('#btnNew').onclick = () => openNew();
    $('#btnBack').onclick = showGrid;
    $('#btnFwUpload').onclick = () => {
        const inst = S.instances.find((i) => i.id === S.detail);
        if (inst) openUpload(inst);
    };

    $('#formUpload').addEventListener('submit', async (e) => {
        if (e.submitter && e.submitter.value === 'cancel') return;
        e.preventDefault();
        const btn = $('#btnDoUpload');
        btn.disabled = true;
        $('#uploadError').textContent = '';
        try {
            await api('PUT', `/api/instances/${uploadInst}/firmware`, await firmwareFields(e.target.elements));
            $('#dlgUpload').close();
        } catch (err) {
            $('#uploadError').textContent = err.message;
        } finally {
            btn.disabled = false;
        }
    });

    const describeUpload = () => {
        const inst = S.instances.find((i) => i.id === uploadInst);
        if (inst) describeFiles($('#formUpload').elements, inst.generation, $('#addrUpload'), $('#uploadFiles'));
    };
    $('#formUpload').elements.files.addEventListener('change', describeUpload);
    $('#formUpload').elements.binAddress.addEventListener('input', describeUpload);

    $('#monitorFile').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file || !monitorGen) return;
        try {
            await api('PUT', `/api/monitors/${monitorGen}`, { name: file.name, bin: await fileToBase64(file) });
        } catch (err) {
            alert(err.message);
        }
        loadMonitors();
    });

    $('#formNew').elements.board.addEventListener('change', updateNewHint);
    $('#formNew').elements.files.addEventListener('change', updateNewHint);
    $('#formNew').elements.binAddress.addEventListener('input', updateNewHint);
    $('#formNew').addEventListener('submit', async (e) => {
        if (e.submitter && e.submitter.value === 'cancel') return;
        e.preventDefault();
        const f = e.target.elements;
        const btn = $('#btnDoNew');
        btn.disabled = true;
        $('#newError').textContent = '';
        try {
            const files = await firmwareFields(f);
            await api('POST', '/api/instances', { board: f.board.value, name: f.name.value || undefined, count: f.count.value, ...files });
            $('#dlgNew').close();
        } catch (err) {
            $('#newError').textContent = err.message;
        } finally {
            btn.disabled = false;
        }
    });

    document.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => S.detail && act(S.detail, b.dataset.act)));

    document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
        $('#paneConsole').hidden = t.dataset.tab !== 'console';
        $('#paneLog').hidden = t.dataset.tab !== 'log';
        $('#dUart').style.visibility = t.dataset.tab === 'console' ? 'visible' : 'hidden';
        if (t.dataset.tab === 'console') setTimeout(() => fit && fit.fit(), 0);
        else $('#renodeLog').scrollTop = $('#renodeLog').scrollHeight;
    }));

    $('#dUart').addEventListener('change', (e) => {
        S.uart = e.target.value;
        // Re-subscribe to receive this UART's backlog.
        const id = S.detail;
        S.detail = null;
        subscribe();
        S.detail = id;
        termReset();
        subscribe();
    });

    initTerm();
    // Instances render with their faceplate, so have the art first.
    loadBoardArt().then(connect);
    loadMonitors();
    loadInfo();
    setInterval(loadInfo, 5000);

    const hash = location.hash.slice(1);
    // #wiring is handled by wiring.js.
    if (hash && hash !== 'wiring') {
        const wait = setInterval(() => {
            if (S.instances.find((i) => i.id === hash)) {
                clearInterval(wait);
                showDetail(hash);
            }
        }, 200);
        setTimeout(() => clearInterval(wait), 5000);
    }
}

setup();

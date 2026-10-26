'use strict';

// ---- state ----
const S = {
    instances: [],
    firmware: [],
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
            }
            break;
        }
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
        ws.send(JSON.stringify({ t: 'sub', lcd: S.detail ? [S.detail] : '*', detail: S.detail }));
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
    const profile = inst.firmware && inst.firmware.profile;
    if (!profile) return;
    document.querySelectorAll(`[data-inst="${inst.id}"] [data-led]`).forEach((dot) => {
        const led = profile.leds.find((l) => l.id === dot.dataset.led);
        if (led) dot.classList.toggle('on', ledOn(inst, led));
    });
    if (S.detail === inst.id) {
        const bar = inst.state ? inst.state.blueBar : 0;
        $('#dBlue').querySelectorAll('span').forEach((s, i) => s.classList.toggle('on', ((bar >> (4 - i)) & 1) === 1));
        const lcd = inst.state && inst.state.lcd;
        $('#dBacklight').textContent = lcd ? `Backlight ${lcd.backlight ? 'on' : 'off'} · display ${lcd.on ? 'on' : 'off'}` : '';
        const vt = inst.state ? (inst.state.vtime / 1000).toFixed(1) + ' s' : '–';
        const vtEl = document.getElementById('dVtime');
        if (vtEl) vtEl.textContent = vt;
    }
}

// ---- rendering ----
function render() {
    renderFirmware();
    if (S.detail && !S.instances.find((i) => i.id === S.detail)) {
        showGrid();
        return;
    }
    if (S.detail) renderDetail();
    else renderGrid();
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
        const card = el('article', { class: 'card', 'data-inst': inst.id },
            el('div', { class: 'screen', onclick: () => showDetail(inst.id), title: 'Open' }, canvas),
            el('div', { class: 'body' },
                el('div', { class: 'title' }, el('strong', {}, inst.name), statusPill(inst.status)),
                el('div', { class: 'info' },
                    el('span', {}, inst.tibboMac),
                    el('span', {}, inst.ip),
                    el('span', {}, inst.firmware ? `${inst.firmware.name} (${inst.firmware.generation.toUpperCase()})` : 'firmware missing')),
                el('div', { class: 'title' },
                    el('span', { class: 'dots' }, ledDots(inst, (inst.firmware && inst.firmware.profile.leds.slice(0, 6)) || [])),
                    el('span', { class: 'ops' },
                        el('button', { class: 'btn small', onclick: () => showDetail(inst.id) }, 'Open'),
                        running
                            ? el('button', { class: 'btn small', onclick: () => act(inst.id, 'reset') }, 'Reset')
                            : null,
                        el('button', { class: 'btn small', onclick: () => act(inst.id, running ? 'stop' : 'start') }, running ? 'Stop' : 'Start'),
                        el('button', { class: 'btn small danger', onclick: () => removeInstance(inst) }, 'Delete')))));
        grid.append(card);
        bindCanvas(inst.id, canvas);
    }
}

function renderFirmware() {
    const list = $('#firmwareList');
    list.textContent = '';
    $('#fwCount').textContent = S.firmware.length ? String(S.firmware.length) : '';
    if (!S.firmware.length) {
        list.append(el('span', { class: 'muted' }, 'None uploaded yet.'));
    }
    for (const fw of S.firmware) {
        const p = fw.profile;
        list.append(el('div', { class: 'fw' },
            el('div', {},
                el('strong', {}, fw.name),
                el('div', { class: 'meta' },
                    `${p.board || '?'} · ${fw.generation.toUpperCase()} · ${p.buttons.length} buttons · console ${p.consoleUart || 'none'}${fw.hasDts ? '' : ' · no DTS'}`)),
            el('button', { class: 'btn small', onclick: () => openNew(fw.id) }, 'Run'),
            el('button', { class: 'btn small danger', onclick: () => removeFirmware(fw) }, 'Delete')));
    }
    const sel = $('#dFirmware');
    const keep = sel.value;
    sel.textContent = '';
    for (const fw of S.firmware) sel.append(el('option', { value: fw.id }, `${fw.name} (${fw.generation.toUpperCase()})`));
    if (keep) sel.value = keep;
}

let renderedDetail = null;
function renderDetail() {
    const inst = S.instances.find((i) => i.id === S.detail);
    if (!inst) return;
    const profile = (inst.firmware && inst.firmware.profile) || { buttons: [], leds: [], uarts: [] };
    $('#dName').textContent = inst.name;
    const pill = $('#dStatus');
    pill.className = `pill ${inst.status}`;
    pill.textContent = inst.status + (inst.status === 'exited' && inst.exitCode !== undefined ? ` (${inst.exitCode})` : '');
    const running = inst.status === 'running' || inst.status === 'starting';
    document.querySelector('[data-act="start"]').hidden = running;
    document.querySelector('[data-act="stop"]').hidden = !running;
    document.querySelector('[data-act="reset"]').disabled = inst.status !== 'running';

    const webUrl = `${location.protocol}//${location.hostname}:${inst.httpPort}/`;
    const facts = $('#dFacts');
    facts.textContent = '';
    const fact = (k, v) => facts.append(el('dt', {}, k), el('dd', {}, v));
    fact('MAC', `${inst.tibboMac}  (${inst.mac})`);
    fact('IP', `${inst.ip} (DHCP reservation)`);
    fact('Board', inst.firmware ? `${profile.board || '?'} · ${inst.firmware.generation.toUpperCase()}` : '–');
    fact('Device web', el('a', { href: webUrl, target: '_blank', rel: 'noopener' }, webUrl));
    fact('Renode monitor', `port ${inst.monitorPort} inside the container`);
    fact('Virtual time', el('span', { id: 'dVtime' }, '–'));
    $('#dFirmware').value = inst.firmwareId;

    if (renderedDetail !== inst.id) {
        renderedDetail = inst.id;
        S.latched.clear();
        bindCanvas(inst.id, $('#dLcd'));
        $('#dNoLcd').hidden = !!profile.lcd;

        const leds = $('#dLeds');
        leds.textContent = '';
        for (const led of profile.leds) {
            leds.append(el('span', { class: 'led' }, el('span', { class: `dot ${ledClass(led)}`, 'data-led': led.id }), led.label));
        }
        $('#dLeds').parentElement.setAttribute('data-inst', inst.id);
        const blue = $('#dBlue');
        blue.textContent = '';
        for (let i = 0; i < 5; i++) blue.append(el('span'));

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
    const press = (pressed) => {
        btn.classList.toggle('pressed', pressed);
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
    return btn;
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
    renderedDetail = null;
    $('#gridView').hidden = true;
    $('#detailView').hidden = false;
    history.replaceState(null, '', `#${id}`);
    renderDetail();
    setTimeout(() => fit && fit.fit(), 0);
}

function showGrid() {
    S.detail = null;
    renderedDetail = null;
    $('#gridView').hidden = false;
    $('#detailView').hidden = true;
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

async function removeFirmware(fw) {
    if (!confirm(`Delete firmware ${fw.name}?`)) return;
    await api('DELETE', `/api/firmware/${fw.id}`).catch((e) => alert(e.message));
    loadFirmware();
}

async function loadFirmware() {
    S.firmware = await api('GET', '/api/firmware').catch(() => []);
    renderFirmware();
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

function openNew(firmwareId) {
    if (!S.firmware.length) {
        $('#dlgUpload').showModal();
        return;
    }
    const sel = $('#formNew').elements.firmwareId;
    sel.textContent = '';
    for (const fw of S.firmware) sel.append(el('option', { value: fw.id }, `${fw.name} (${fw.generation.toUpperCase()})`));
    if (firmwareId) sel.value = firmwareId;
    $('#newError').textContent = '';
    $('#dlgNew').showModal();
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
    $('#btnUpload').onclick = () => {
        $('#uploadError').textContent = '';
        $('#dlgUpload').showModal();
    };
    $('#btnNew').onclick = () => openNew();
    $('#btnBack').onclick = showGrid;

    $('#formUpload').addEventListener('submit', async (e) => {
        if (e.submitter && e.submitter.value === 'cancel') return;
        e.preventDefault();
        const f = e.target.elements;
        const btn = $('#btnDoUpload');
        btn.disabled = true;
        $('#uploadError').textContent = '';
        try {
            const elf = await fileToBase64(f.elf.files[0]);
            const dts = f.dts.files[0] ? await f.dts.files[0].text() : undefined;
            await api('POST', '/api/firmware', { name: f.name.value, elf, dts });
            $('#dlgUpload').close();
            e.target.reset();
            await loadFirmware();
        } catch (err) {
            $('#uploadError').textContent = err.message;
        } finally {
            btn.disabled = false;
        }
    });
    $('#formUpload').elements.elf.addEventListener('change', (e) => {
        const name = $('#formUpload').elements.name;
        if (!name.value && e.target.files[0]) name.value = e.target.files[0].name.replace(/\.elf$/, '');
    });

    $('#formNew').addEventListener('submit', async (e) => {
        if (e.submitter && e.submitter.value === 'cancel') return;
        e.preventDefault();
        const f = e.target.elements;
        try {
            await api('POST', '/api/instances', { firmwareId: f.firmwareId.value, name: f.name.value || undefined, count: f.count.value });
            $('#dlgNew').close();
        } catch (err) {
            $('#newError').textContent = err.message;
        }
    });

    document.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => S.detail && act(S.detail, b.dataset.act)));

    $('#dFirmware').addEventListener('change', async (e) => {
        if (!S.detail) return;
        if (!confirm('Switch firmware? The instance restarts; its flash and EEPROM are kept.')) {
            renderDetail();
            return;
        }
        await api('PATCH', `/api/instances/${S.detail}`, { firmwareId: e.target.value }).catch((err) => alert(err.message));
        renderedDetail = null;
    });

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
    connect();
    loadFirmware();
    loadInfo();
    setInterval(loadInfo, 5000);

    const hash = location.hash.slice(1);
    if (hash) {
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

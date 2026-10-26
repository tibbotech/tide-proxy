'use strict';

// ---- wiring view: connections between instances ----
// Model on the server (links.ts): UART buses and GPIO wires, via /api/links and the websocket
// messages 'links' / 'linkStats'. Box positions and hand-added pins are per-viewer (localStorage).

S.links = [];
S.linkStats = {};
S.wiring = false;

const W = {
    layout: loadLocal('sim.wiring.layout', {}),
    extraPins: loadLocal('sim.wiring.pins', {}),
    selected: null, // { link, ep }
    drag: null,
    pendingRender: false,
    prevBytes: {},
    activeUntil: {},
    liveQueued: false,
};

function loadLocal(key, def) {
    try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : def;
    } catch {
        return def;
    }
}

function saveLocal(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Positions are a convenience; nothing to do without storage.
    }
}

const svgEl = (tag, attrs = {}) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
    return e;
};
const instById = (id) => S.instances.find((i) => i.id === id);
const instName = (id) => {
    const i = instById(id);
    return i ? i.name || i.id : id;
};
const sameEp = (a, b) => a.instance === b.instance && a.port === b.port;
const linkOf = (ep) => S.links.find((l) => l.endpoints.some((e) => sameEp(e, ep)));
const PIN_RE = /^P([A-I])(\d{1,2})$/;

function normPort(kind, port) {
    port = String(port || '').trim();
    if (kind === 'uart') return port.toLowerCase();
    const m = PIN_RE.exec(port.toUpperCase());
    return m ? `P${m[1]}${Number(m[2])}` : port.toUpperCase();
}

// Ports a box offers: the DTS UARTs, DTS-named pins (buttons, LEDs), pins added by hand and
// anything already wired (so a wire stays visible after a firmware switch).
function portsOf(inst) {
    const profile = (inst.firmware && inst.firmware.profile) || { buttons: [], leds: [] };
    const uarts = (inst.consoles || []).filter((c) => c !== 'udp')
        .map((u) => ({ kind: 'uart', port: u, label: u === profile.consoleUart ? 'console' : '' }));
    const pins = new Map();
    for (const b of profile.buttons || []) pins.set(`P${b.port}${b.pin}`, { label: b.id === 'mdbutton' ? 'MD button' : b.label });
    for (const l of profile.leds || []) pins.set(`P${l.port}${l.pin}`, { label: l.label });
    for (const p of W.extraPins[inst.id] || []) if (!pins.has(p)) pins.set(p, { label: '', extra: true });
    for (const link of S.links) {
        for (const e of link.endpoints) {
            if (e.instance !== inst.id) continue;
            if (link.kind === 'gpio' && !pins.has(e.port)) pins.set(e.port, { label: '' });
            if (link.kind === 'uart' && !uarts.some((u) => u.port === e.port)) uarts.push({ kind: 'uart', port: e.port, label: 'not in DTS', missing: true });
        }
    }
    const pinOrder = (p) => {
        const m = PIN_RE.exec(p);
        return m ? m[1].charCodeAt(0) * 100 + Number(m[2]) : 0;
    };
    const gpio = [...pins.entries()]
        .sort((a, b) => pinOrder(a[0]) - pinOrder(b[0]))
        .map(([port, p]) => ({ kind: 'gpio', port, label: p.label, extra: p.extra }));
    return [...uarts, ...gpio];
}

function pinInfo(inst, port) {
    const st = inst.state;
    const m = PIN_RE.exec(port);
    if (!m || !st || !st.pins || inst.status !== 'running') return null;
    const bit = 1 << Number(m[2]);
    return { out: (((st.out || {})[m[1]] || 0) & bit) !== 0, high: ((st.pins[m[1]] || 0) & bit) !== 0 };
}

// ---- view ----
function showWiring() {
    S.detail = null;
    renderedDetail = null;
    S.wiring = true;
    $('#gridView').hidden = true;
    $('#detailView').hidden = true;
    $('#wiringView').hidden = false;
    history.replaceState(null, '', '#wiring');
    subscribe();
    renderWiring();
}

function renderWiring() {
    if (W.drag) {
        W.pendingRender = true;
        return;
    }
    const canvas = $('#wireCanvas');
    canvas.querySelectorAll('.wbox').forEach((b) => b.remove());
    const boxes = S.instances.map(wireBox);
    canvas.append(...boxes);
    placeBoxes(boxes);
    $('#wiringEmpty').hidden = S.instances.length > 0;
    renderLinkList();
    drawWires();
    applyLive();
}

// Boxes without a saved position flow into columns across the canvas, by their real height.
function placeBoxes(boxes) {
    const colWidth = 300;
    const cols = Math.max(1, Math.floor(($('#wireCanvas').clientWidth - 24) / colWidth));
    const bottoms = new Array(cols).fill(20);
    boxes.forEach((box, i) => {
        if (W.layout[box.dataset.wbox]) return;
        const col = i % cols;
        box.style.left = `${24 + col * colWidth}px`;
        box.style.top = `${bottoms[col]}px`;
        bottoms[col] += box.offsetHeight + 24;
    });
}

function wireBox(inst) {
    const pos = W.layout[inst.id];
    const box = el('div', { class: `wbox ${inst.status}`, 'data-wbox': inst.id, style: pos ? `left:${pos.x}px;top:${pos.y}px` : null });
    const head = el('div', { class: 'whead', title: 'Drag to move' },
        el('strong', {}, inst.name || inst.id),
        el('span', { class: 'muted' }, inst.firmware ? inst.firmware.generation.toUpperCase() : ''),
        statusPill(inst.status));
    head.addEventListener('pointerdown', (e) => startMove(e, box, inst.id));
    box.append(head);
    const ports = portsOf(inst);
    for (const kind of ['uart', 'gpio']) {
        box.append(el('div', { class: 'wsec' }, kind === 'uart' ? 'UART' : 'GPIO'));
        const list = ports.filter((p) => p.kind === kind);
        if (!list.length) box.append(el('div', { class: 'wnone' }, kind === 'uart' ? 'none enabled in the DTS' : 'add a pin below'));
        for (const p of list) box.append(portRow(inst, p));
    }
    const add = el('input', { class: 'wadd', placeholder: '+ pin, e.g. PA0', spellcheck: 'false' });
    add.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addPin(inst.id, add.value);
    });
    box.append(add);
    return box;
}

function portRow(inst, p) {
    const ep = { instance: inst.id, port: p.port };
    const linked = !!linkOf(ep);
    const row = el('div', {
        class: `wport ${p.kind}${linked ? ' linked' : ''}${p.missing ? ' missing' : ''}`,
        'data-wi': inst.id, 'data-port': p.port, 'data-kind': p.kind,
        title: linked ? 'Drag to connect more' : 'Drag to another port to connect',
    },
    el('span', { class: 'wdot l' }),
    el('span', { class: 'wname' }, p.port),
    el('span', { class: 'wlabel' }, p.label),
    p.kind === 'gpio' ? el('span', { class: 'wlvl' }) : null,
    p.extra && !linked ? el('button', { class: 'wx', title: 'Remove pin', onclick: () => removePin(inst.id, p.port) }, '×') : null,
    el('span', { class: 'wdot r' }));
    row.querySelectorAll('.wdot').forEach((d) => d.addEventListener('pointerdown', (e) => startWire(e, { ...ep, kind: p.kind })));
    return row;
}

function addPin(id, value) {
    const port = normPort('gpio', value);
    const m = PIN_RE.exec(port);
    if (!m || Number(m[2]) > 15) {
        showLinkError(`${value} is not a pin (PA0..PI15)`);
        return;
    }
    const pins = W.extraPins[id] || [];
    if (!pins.includes(port)) W.extraPins[id] = [...pins, port];
    saveLocal('sim.wiring.pins', W.extraPins);
    showLinkError('');
    renderWiring();
}

function removePin(id, port) {
    W.extraPins[id] = (W.extraPins[id] || []).filter((p) => p !== port);
    saveLocal('sim.wiring.pins', W.extraPins);
    renderWiring();
}

// ---- wires ----
// Viewport position of the canvas's content origin (inside its border, scrolled), where the
// boxes and the wire layer are placed.
function canvasOrigin(c) {
    const cr = c.getBoundingClientRect();
    return { x: cr.left + c.clientLeft - c.scrollLeft, y: cr.top + c.clientTop - c.scrollTop };
}

// Port position in canvas coordinates. With `towardX`, the side of the box facing that x.
function anchor(ep, towardX) {
    const c = $('#wireCanvas');
    const row = c.querySelector(`.wport[data-wi="${ep.instance}"][data-port="${ep.port}"]`);
    if (!row) return null;
    const o = canvasOrigin(c);
    const r = row.getBoundingClientRect();
    const left = r.left - o.x;
    const right = left + r.width;
    const y = r.top - o.y + r.height / 2;
    const cx = (left + right) / 2;
    if (towardX === undefined) return { x: cx, y, dir: 0 };
    return towardX < cx ? { x: left - 1, y, dir: -1 } : { x: right + 1, y, dir: 1 };
}

function curve(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + a.dir * dx},${a.y} ${b.x + (b.dir || 0) * dx},${b.y} ${b.x},${b.y}`;
}

function boxRects() {
    return [...document.querySelectorAll('#wireCanvas .wbox')].map((b) => ({
        id: b.dataset.wbox, left: b.offsetLeft, top: b.offsetTop, right: b.offsetLeft + b.offsetWidth, bottom: b.offsetTop + b.offsetHeight,
    }));
}

// A wire from a to b. When the straight run would pass behind another box (and so look attached
// to its ports), it leaves sideways, drops below those boxes into its own lane, and comes back up.
function route(a, b, own, boxes, lanes) {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y) - 10;
    const maxY = Math.max(a.y, b.y) + 10;
    const blockers = boxes.filter((r) => !own.includes(r.id) && r.left < maxX && r.right > minX && r.top < maxY && r.bottom > minY);
    if (!blockers.length) return curve(a, b);
    const y = Math.max(...blockers.map((r) => r.bottom)) + 18 + 8 * lanes.n++;
    const ad = a.dir || (b.x > a.x ? 1 : -1);
    const bd = b.dir || (a.x > b.x ? 1 : -1);
    const r = 26;
    return `M${a.x},${a.y} C${a.x + ad * r},${a.y} ${a.x + ad * r},${y} ${a.x + ad * 2 * r},${y}`
        + ` L${b.x + bd * 2 * r},${y} C${b.x + bd * r},${y} ${b.x + bd * r},${b.y} ${b.x},${b.y}`;
}

// Segments per link: a 2-ended link is one wire; a UART bus joins at a junction; a GPIO wire fans
// out from its driver. `ep` is the endpoint a segment belongs to (deleting it drops that endpoint).
function segments(link, boxes, lanes) {
    const segs = [];
    const eps = link.endpoints;
    if (link.kind === 'gpio' || eps.length === 2) {
        const src = anchor(eps[0]);
        if (!src) return { segs };
        for (let i = 1; i < eps.length; i++) {
            const t = anchor(eps[i]);
            if (!t) continue;
            const own = [eps[0].instance, eps[i].instance];
            segs.push({ d: route(anchor(eps[0], t.x), anchor(eps[i], src.x), own, boxes, lanes), ep: i, arrow: link.kind === 'gpio' });
        }
        return { segs };
    }
    const pts = eps.map((e) => anchor(e)).filter(Boolean);
    if (pts.length < 2) return { segs };
    const j = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length, dir: 0 };
    // Keep the junction visible: out from under any box it lands on.
    for (const r of boxes) {
        if (j.x > r.left && j.x < r.right && j.y > r.top && j.y < r.bottom) j.y = r.bottom + 20;
    }
    eps.forEach((e, i) => {
        const a = anchor(e, j.x);
        if (a) segs.push({ d: route(a, j, [e.instance], boxes, lanes), ep: i });
    });
    return { segs, junction: j };
}

function drawWires() {
    const c = $('#wireCanvas');
    const svg = $('#wireSvg');
    let w = c.clientWidth;
    let h = c.clientHeight;
    c.querySelectorAll('.wbox').forEach((b) => {
        w = Math.max(w, b.offsetLeft + b.offsetWidth + 40);
        h = Math.max(h, b.offsetTop + b.offsetHeight + 40);
    });
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.textContent = '';
    const marker = svgEl('marker', { id: 'warrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerUnits: 'userSpaceOnUse', markerWidth: '10', markerHeight: '10', orient: 'auto-start-reverse' });
    marker.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: 'warrow' }));
    const defs = svgEl('defs');
    defs.append(marker);
    svg.append(defs);

    const del = $('#wireDel');
    del.hidden = true;
    const boxes = boxRects();
    const lanes = { n: 0 };
    for (const link of S.links) {
        const { segs, junction } = segments(link, boxes, lanes);
        for (const s of segs) {
            const sel = W.selected && W.selected.link === link.id && W.selected.ep === s.ep;
            const path = svgEl('path', { d: s.d, class: `wire ${link.kind}${sel ? ' sel' : ''}`, 'data-link': link.id, 'marker-end': s.arrow ? 'url(#warrow)' : null });
            const hit = svgEl('path', { d: s.d, class: 'wire-hit' });
            const title = svgEl('title');
            title.textContent = linkTitle(link);
            hit.append(title);
            hit.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                W.selected = { link: link.id, ep: s.ep };
                drawWires();
            });
            svg.append(path, hit);
            if (sel) {
                const mid = path.getPointAtLength(path.getTotalLength() / 2);
                del.style.left = `${mid.x}px`;
                del.style.top = `${mid.y}px`;
                del.hidden = false;
            }
        }
        if (junction) svg.append(svgEl('circle', { cx: junction.x, cy: junction.y, r: 5, class: `junction ${link.kind}`, 'data-link': link.id }));
    }
    applyWireState();
}

function linkTitle(link) {
    const eps = link.endpoints.map((e) => `${instName(e.instance)} ${e.port}`);
    const what = link.kind === 'gpio' ? `${eps[0]} drives ${eps.slice(1).join(', ')}` : eps.join(' ↔ ');
    return `${link.name ? link.name + ': ' : ''}${what}`;
}

function startWire(e, from) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const c = $('#wireCanvas');
    const temp = svgEl('path', { class: `wire temp ${from.kind}` });
    $('#wireSvg').append(temp);
    W.drag = { wire: from };
    c.classList.add(`dragging-${from.kind}`);
    const move = (ev) => {
        const o = canvasOrigin(c);
        const p = { x: ev.clientX - o.x, y: ev.clientY - o.y, dir: 0 };
        const a = anchor(from, p.x);
        if (a) temp.setAttribute('d', curve(a, p));
    };
    const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        temp.remove();
        c.classList.remove(`dragging-${from.kind}`);
        W.drag = null;
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        const row = target && target.closest('#wireCanvas .wport');
        if (row) connectPorts(from, { instance: row.dataset.wi, port: row.dataset.port, kind: row.dataset.kind });
        if (W.pendingRender) {
            W.pendingRender = false;
            renderWiring();
        }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
}

function startMove(e, box, id) {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = box.offsetLeft;
    const oy = box.offsetTop;
    W.drag = { box: id };
    box.classList.add('moving');
    const move = (ev) => {
        box.style.left = `${Math.max(0, ox + ev.clientX - sx)}px`;
        box.style.top = `${Math.max(0, oy + ev.clientY - sy)}px`;
        drawWires();
    };
    const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        box.classList.remove('moving');
        W.layout[id] = { x: box.offsetLeft, y: box.offsetTop };
        saveLocal('sim.wiring.layout', W.layout);
        W.drag = null;
        if (W.pendingRender) {
            W.pendingRender = false;
            renderWiring();
        }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
}

// ---- editing ----
// Joins two ports. UART: both end up on one bus (buses merge). GPIO: the first port drives the
// second; a pin already driven, or a target used as a source, is refused.
async function connectPorts(a, b) {
    showLinkError('');
    try {
        if (a.kind !== b.kind) throw new Error('Connect a UART to a UART, and a pin to a pin.');
        const ea = { instance: a.instance, port: normPort(a.kind, a.port) };
        const eb = { instance: b.instance, port: normPort(b.kind, b.port) };
        if (sameEp(ea, eb)) return;
        const la = linkOf(ea);
        const lb = linkOf(eb);
        if (a.kind === 'uart') {
            if (la && la === lb) return;
            if (la && lb) {
                await api('DELETE', `/api/links/${lb.id}`);
                await api('PATCH', `/api/links/${la.id}`, { endpoints: [...la.endpoints, ...lb.endpoints] });
            } else if (la) {
                await api('PATCH', `/api/links/${la.id}`, { endpoints: [...la.endpoints, eb] });
            } else if (lb) {
                await api('PATCH', `/api/links/${lb.id}`, { endpoints: [...lb.endpoints, ea] });
            } else {
                await api('POST', '/api/links', { kind: 'uart', endpoints: [ea, eb] });
            }
            return;
        }
        if (lb) throw new Error(`${instName(eb.instance)} ${eb.port} is already wired. Drag from the driving pin to a free pin.`);
        if (la && !sameEp(la.endpoints[0], ea)) throw new Error(`${instName(ea.instance)} ${ea.port} is driven by another pin. Drag from the driver instead.`);
        if (la) await api('PATCH', `/api/links/${la.id}`, { endpoints: [...la.endpoints, eb] });
        else await api('POST', '/api/links', { kind: 'gpio', endpoints: [ea, eb] });
    } catch (err) {
        showLinkError(err.message);
    }
}

// Drops one endpoint; a link left with one end, or a GPIO wire losing its driver, is deleted.
async function removeWire(linkId, ep) {
    const link = S.links.find((l) => l.id === linkId);
    if (!link) return;
    W.selected = null;
    const rest = link.endpoints.filter((_, i) => i !== ep);
    try {
        if (rest.length < 2 || (link.kind === 'gpio' && ep === 0)) await api('DELETE', `/api/links/${link.id}`);
        else await api('PATCH', `/api/links/${link.id}`, { endpoints: rest });
    } catch (err) {
        showLinkError(err.message);
    }
}

function showLinkError(text) {
    $('#linkError').textContent = text;
}

// ---- connection list ----
function renderLinkList() {
    const list = $('#linkList');
    list.textContent = '';
    $('#linkCount').textContent = S.links.length ? String(S.links.length) : '';
    if (!S.links.length) {
        list.append(el('p', { class: 'muted' }, 'No connections yet. Drag from a port to a port above, or add one below.'));
    }
    for (const link of S.links) {
        const name = el('input', { class: 'lname', value: link.name, placeholder: link.kind === 'uart' ? 'UART link' : 'GPIO wire' });
        name.addEventListener('change', () => api('PATCH', `/api/links/${link.id}`, { name: name.value }).catch((e) => showLinkError(e.message)));
        const chip = (e, i) => el('span', { class: 'chip' },
            `${instName(e.instance)} · ${e.port}`,
            el('button', { class: 'wx', title: 'Remove this end', onclick: () => removeWire(link.id, i) }, '×'));
        const chips = link.kind === 'gpio'
            ? [chip(link.endpoints[0], 0), el('span', { class: 'muted' }, 'drives'), ...link.endpoints.slice(1).map((e, i) => chip(e, i + 1))]
            : link.endpoints.map(chip);
        list.append(el('div', { class: 'lrow' },
            el('span', { class: `kind ${link.kind}` }, link.kind.toUpperCase()),
            name,
            el('span', { class: 'chips' }, chips),
            el('span', { class: 'lstat', 'data-lstat': link.id }),
            el('button', { class: 'btn small danger', onclick: () => api('DELETE', `/api/links/${link.id}`).catch((e) => showLinkError(e.message)) }, 'Delete')));
    }
    fillLinkForm();
}

function fillLinkForm() {
    const f = $('#formLink').elements;
    for (const name of ['fromInst', 'toInst']) {
        const sel = f[name];
        const keep = sel.value;
        sel.textContent = '';
        for (const inst of S.instances) sel.append(el('option', { value: inst.id }, inst.name || inst.id));
        if (keep && instById(keep)) sel.value = keep;
        else if (name === 'toInst' && S.instances[1]) sel.value = S.instances[1].id;
    }
    for (const [inst, list] of [['fromInst', 'portsFrom'], ['toInst', 'portsTo']]) {
        const dl = $(`#${list}`);
        dl.textContent = '';
        const i = instById(f[inst].value);
        if (i) portsOf(i).filter((p) => p.kind === f.kind.value).forEach((p) => dl.append(el('option', { value: p.port }, p.label)));
    }
}

// ---- live state ----
function updateWiringLive() {
    if (!S.wiring || W.liveQueued) return;
    W.liveQueued = true;
    requestAnimationFrame(() => {
        W.liveQueued = false;
        applyLive();
    });
}

function applyLive() {
    document.querySelectorAll('#wireCanvas .wport.gpio').forEach((row) => {
        const inst = instById(row.dataset.wi);
        const info = inst && pinInfo(inst, row.dataset.port);
        const lvl = row.querySelector('.wlvl');
        lvl.textContent = info ? `${info.out ? 'out' : 'in'} ${info.high ? 'H' : 'L'}` : '';
        lvl.className = `wlvl${info && info.high ? ' hi' : ''}`;
    });
    applyWireState();
}

function formatBytes(n) {
    return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`;
}

// Wire looks: dashed while an end isn't running or a GPIO driver is released, amber while a GPIO
// wire is high, glowing for a second after UART traffic.
function applyWireState() {
    const now = Date.now();
    for (const link of S.links) {
        const st = S.linkStats[link.id] || { bytes: 0, level: null };
        const prev = W.prevBytes[link.id];
        if (link.kind === 'uart' && prev !== undefined && st.bytes !== prev) W.activeUntil[link.id] = now + 1000;
        W.prevBytes[link.id] = st.bytes;
        const running = link.endpoints.every((e) => (instById(e.instance) || {}).status === 'running');
        document.querySelectorAll(`#wireSvg [data-link="${link.id}"]`).forEach((n) => {
            n.classList.toggle('off', !running);
            n.classList.toggle('active', link.kind === 'uart' && (W.activeUntil[link.id] || 0) > now);
            n.classList.toggle('hi', link.kind === 'gpio' && st.level === true);
            n.classList.toggle('z', link.kind === 'gpio' && st.level === null);
        });
        const stat = document.querySelector(`[data-lstat="${link.id}"]`);
        if (stat) {
            stat.textContent = link.kind === 'uart'
                ? formatBytes(st.bytes)
                : st.level === null ? 'released' : st.level ? 'high' : 'low';
        }
    }
}

// ---- setup ----
(function setupWiring() {
    $('#btnWiring').onclick = showWiring;
    $('#btnWiringBack').onclick = showGrid;
    $('#wireDel').onclick = () => W.selected && removeWire(W.selected.link, W.selected.ep);

    $('#wireCanvas').addEventListener('pointerdown', (e) => {
        if (W.selected && !e.target.closest('.wbox') && e.target.id !== 'wireDel') {
            W.selected = null;
            drawWires();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (!S.wiring || !W.selected || e.target.closest('input, select, textarea')) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            removeWire(W.selected.link, W.selected.ep);
        } else if (e.key === 'Escape') {
            W.selected = null;
            drawWires();
        }
    });

    const form = $('#formLink');
    form.addEventListener('change', (e) => {
        if (e.target.tagName === 'SELECT') fillLinkForm();
    });
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const f = form.elements;
        const kind = f.kind.value;
        connectPorts(
            { instance: f.fromInst.value, port: f.fromPort.value, kind },
            { instance: f.toInst.value, port: f.toPort.value, kind });
    });

    window.addEventListener('resize', () => S.wiring && drawWires());
    // UART glow fades without new stats arriving.
    setInterval(() => S.wiring && updateWiringLive(), 500);

    if (location.hash === '#wiring') showWiring();
})();

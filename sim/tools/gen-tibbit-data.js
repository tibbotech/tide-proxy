#!/usr/bin/env node
// Regenerates manager/src/data/{sockets,tibbits}.json from the Cody repo (packages/platforms).
//   node sim/tools/gen-tibbit-data.js [path/to/cody]
//
// sockets.json: per TPP board, each socket's accepted Tibbit forms, the MCU pin behind each of its
// four lines (null when the line is not a GPIO) and the UART on lines 0/1.
// tibbits.json: every Tibbit's model, name, form, category and, where Cody has a wiring diagram, the
// label of each of its four socket lines.
const fs = require('fs');
const path = require('path');

const cody = path.resolve(process.argv[2] || 'D:/projects/cody');
const platforms = path.join(cody, 'packages/platforms');
const diagrams = path.join(cody, 'packages/codegeneration/tibbitDiagrams');
const out = path.resolve(__dirname, '../manager/src/data');

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const BOARDS = { 'TPP2W(G2)': 'tpp2g2', 'TPP3W(G2)': 'tpp3g2', 'TPP2W(G3)': 'tpp2g3', 'TPP3W(G3)': 'tpp3g3' };

const sockets = {};
for (const [dir, id] of Object.entries(BOARDS)) {
    const board = read(path.join(platforms, 'boards/tibbo', dir, 'board.json'));
    const pinById = new Map(board.pins.map((p) => [String(p.num), p]));
    const mcuPin = (num) => {
        const gpio = pinById.get(String(num))?.peripherals.find((p) => p.peripheralType === 'gpio');
        return gpio ? { port: gpio.peripheralPort.replace(/^gpio/, '').toUpperCase(), pin: Number(gpio.num) } : null;
    };
    const serial = board.peripherals.filter((p) => p.type === 'serial' && p.settings.TX && p.settings.RX);
    sockets[id] = board.sockets.map((s) => {
        const uart = serial.find((p) => p.settings.TX.value === s.pins[0] && p.settings.RX.value === s.pins[1]);
        const entry = { socket: String(s.socket), accept: s.accept, lines: s.pins.map(mcuPin) };
        if (uart) entry.uart = uart.settings.PORT.value;
        return entry;
    });
}

// Line labels from the diagrams: each line of a terminal block is tied to one of the Tibbit's 4 socket
// lines ("device-pin-<n>-1-<line>"); a label only counts when each line appears once.
function lineLabels(model) {
    const file = path.join(diagrams, `tibbit_${model}.json`);
    if (!fs.existsSync(file)) return undefined;
    const els = read(file);
    const points = new Map(els.filter((e) => e.type === 'point').map((e) => [e.id, e]));
    const labels = [];
    for (const e of els) {
        if (e.type !== 'line') continue;
        const m = /^device-pin-\d+-\d+-(\d+)$/.exec(e.endPointId);
        if (!m) continue;
        const line = Number(m[1]);
        if (labels[line] !== undefined) return undefined;
        labels[line] = { label: e.targetLabel || e.sourceLabel || '', x: points.get(e.startPointId)?.x ?? 0 };
    }
    return [0, 1, 2, 3].map((i) => (labels[i] ? labels[i].label : ''));
}

const tibbits = read(path.join(platforms, 'TibbitDefinitions/tibbits.json'))
    .filter((t) => t.good && t.good.model)
    .map((t) => {
        const entry = { model: t.good.model, name: t.good.name, form: t.main.form, category: t.main.category };
        const lines = lineLabels(t.good.model.replace(/_\d+$/, ''));
        if (lines) entry.lines = lines;
        return entry;
    });

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'sockets.json'), JSON.stringify(sockets, null, 1) + '\n');
fs.writeFileSync(path.join(out, 'tibbits.json'), JSON.stringify(tibbits, null, 1) + '\n');
console.log(`${Object.keys(sockets).length} boards, ${tibbits.length} Tibbits -> ${out}`);

// Reads the final devicetree (build/zephyr/zephyr.dts) of a Tibbo Zephyr build to learn
// which board it targets, which UART is the console, and which buttons/LEDs exist.

export interface DtsNode {
    name: string;
    labels: string[];
    props: Record<string, string | true>;
    children: DtsNode[];
    parent?: DtsNode;
}

export interface GpioRef {
    port: string; // 'A'..'K'
    pin: number;
    activeLow: boolean;
}

export interface BoardButton extends GpioRef {
    id: string;
    label: string;
}

export interface BoardLed extends GpioRef {
    id: string;
    label: string;
}

export interface BoardProfile {
    board: string; // e.g. tpp2g2
    model: string;
    consoleUart?: string; // Renode name, e.g. usart2
    uarts: string[]; // enabled UARTs (Renode names)
    buttons: BoardButton[];
    leds: BoardLed[];
    lcd?: { width: number; height: number };
}

const UART_BY_ADDRESS: Record<string, string> = {
    '40011000': 'usart1',
    '40004400': 'usart2',
    '40004800': 'usart3',
    '40004c00': 'uart4',
    '40005000': 'uart5',
    '40011400': 'usart6',
};

export function parseDts(text: string): DtsNode {
    const src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    let pos = 0;

    const skipWs = () => {
        while (pos < src.length && /\s/.test(src[pos])) {
            pos++;
        }
    };

    // Reads until one of the stop characters at nesting level 0, honouring strings and <> [] groups.
    const readUntil = (stops: string): string => {
        const start = pos;
        let inStr = false;
        let depth = 0;
        while (pos < src.length) {
            const c = src[pos];
            if (inStr) {
                if (c === '\\') {
                    pos++;
                } else if (c === '"') {
                    inStr = false;
                }
            } else if (c === '"') {
                inStr = true;
            } else if (c === '<' || c === '[') {
                depth++;
            } else if (c === '>' || c === ']') {
                depth--;
            } else if (depth <= 0 && stops.includes(c)) {
                break;
            }
            pos++;
        }
        return src.slice(start, pos);
    };

    const parseBody = (node: DtsNode) => {
        for (;;) {
            skipWs();
            if (pos >= src.length) {
                return;
            }
            if (src[pos] === '}') {
                pos++;
                skipWs();
                if (src[pos] === ';') {
                    pos++;
                }
                return;
            }
            const head = readUntil('{=;}').trim();
            const c = src[pos];
            if (c === '{') {
                pos++;
                const tokens = head.split(/\s+/).filter(Boolean);
                const labels: string[] = [];
                let name = '';
                for (const t of tokens) {
                    if (t.endsWith(':')) {
                        labels.push(t.slice(0, -1));
                    } else {
                        name = t;
                    }
                }
                const child: DtsNode = { name, labels, props: {}, children: [], parent: node };
                node.children.push(child);
                parseBody(child);
            } else if (c === '=') {
                pos++;
                const value = readUntil(';').trim();
                pos++;
                node.props[head] = value;
            } else if (c === ';') {
                pos++;
                if (head) {
                    node.props[head] = true;
                }
            } else if (c === '}') {
                // tolerate a missing ';' before '}'
                if (head) {
                    node.props[head] = true;
                }
            } else {
                return;
            }
        }
    };

    const root: DtsNode = { name: '', labels: [], props: {}, children: [] };
    parseBody(root);
    return root;
}

function walk(node: DtsNode, fn: (n: DtsNode) => void) {
    fn(node);
    node.children.forEach((c) => walk(c, fn));
}

function strings(value: string | true | undefined): string[] {
    if (typeof value !== 'string') {
        return [];
    }
    return Array.from(value.matchAll(/"((?:[^"\\]|\\.)*)"/g)).map((m) => m[1]);
}

function cells(value: string | true | undefined): string[] {
    if (typeof value !== 'string') {
        return [];
    }
    const m = value.match(/<([^>]*)>/);
    return m ? m[1].trim().split(/\s+/) : [];
}

function toNum(s: string): number {
    return s.startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
}

function gpioPortFromLabel(label: string, byLabel: Map<string, DtsNode>): string | undefined {
    const m = label.match(/^gpio([a-k])$/i);
    if (m) {
        return m[1].toUpperCase();
    }
    const node = byLabel.get(label);
    const addr = node?.name.split('@')[1];
    if (addr) {
        const idx = (parseInt(addr, 16) - 0x40020000) / 0x400;
        if (idx >= 0 && idx < 11 && Number.isInteger(idx)) {
            return String.fromCharCode(65 + idx);
        }
    }
    return undefined;
}

function gpioRef(value: string | true | undefined, byLabel: Map<string, DtsNode>): GpioRef | undefined {
    const c = cells(value);
    if (c.length < 3 || !c[0].startsWith('&')) {
        return undefined;
    }
    const port = gpioPortFromLabel(c[0].slice(1), byLabel);
    if (!port) {
        return undefined;
    }
    return { port, pin: toNum(c[1]), activeLow: (toNum(c[2]) & 1) === 1 };
}

function okay(node: DtsNode): boolean {
    const s = strings(node.props['status'])[0];
    return s === undefined || s === 'okay';
}

export function boardProfile(dtsText: string): BoardProfile {
    const root = parseDts(dtsText);
    const top = root.children.find((c) => c.name === '/') || root;
    const byLabel = new Map<string, DtsNode>();
    walk(root, (n) => n.labels.forEach((l) => byLabel.set(l, n)));

    const compatibles = strings(top.props['compatible']);
    const tibbo = compatibles.find((c) => c.startsWith('tibbo,')) || compatibles[0] || '';
    const profile: BoardProfile = {
        board: tibbo.replace(/^tibbo,/, ''),
        model: strings(top.props['model'])[0] || '',
        uarts: [],
        buttons: [],
        leds: [],
    };

    const uartName = (node: DtsNode | undefined) => {
        const addr = node?.name.split('@')[1];
        return addr ? UART_BY_ADDRESS[addr.toLowerCase()] : undefined;
    };

    const chosen = top.children.find((c) => c.name === 'chosen');
    const consoleRef = chosen?.props['zephyr,console'];
    if (typeof consoleRef === 'string' && consoleRef.startsWith('&')) {
        profile.consoleUart = uartName(byLabel.get(consoleRef.slice(1).trim()));
    }

    walk(root, (n) => {
        const compat = strings(n.props['compatible']);
        if (n.name.startsWith('serial@') && okay(n)) {
            const u = uartName(n);
            if (u && !profile.uarts.includes(u)) {
                profile.uarts.push(u);
            }
        }
        if (compat.includes('gpio-keys') && okay(n)) {
            for (const k of n.children) {
                const ref = gpioRef(k.props['gpios'], byLabel);
                if (ref) {
                    profile.buttons.push({
                        id: k.labels[0] || k.name,
                        label: strings(k.props['label'])[0] || k.name,
                        ...ref,
                    });
                }
            }
        }
        if (compat.includes('gpio-leds') && okay(n) && n.name !== 'blue_led_bar') {
            for (const k of n.children) {
                const ref = gpioRef(k.props['gpios'], byLabel);
                if (ref) {
                    profile.leds.push({
                        id: k.labels[0] || k.name,
                        label: strings(k.props['label'])[0] || k.name.replace(/_gpio$/, '').replace(/_/g, ' '),
                        ...ref,
                    });
                }
            }
        }
        if (compat.includes('solomon,ssd1963') && okay(n)) {
            const w = cells(n.props['width'])[0];
            const h = cells(n.props['height'])[0];
            profile.lcd = { width: w ? toNum(w) : 320, height: h ? toNum(h) : 240 };
        }
    });
    if (profile.consoleUart && !profile.uarts.includes(profile.consoleUart)) {
        profile.uarts.push(profile.consoleUart);
    }
    return profile;
}

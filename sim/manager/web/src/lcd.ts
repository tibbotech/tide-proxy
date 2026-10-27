// LCD frames arrive as binary websocket messages: [idLen][id][x,y,w,h as u16 LE][RGB bytes].
// They are painted straight onto the registered canvases; React never sees the pixels.

interface Frame {
    image: ImageData;
    canvases: Set<HTMLCanvasElement>;
}

const frames = new Map<string, Frame>();

function frameFor(id: string, w: number, h: number): Frame {
    let f = frames.get(id);
    if (!f || f.image.width !== w || f.image.height !== h) {
        const image = new ImageData(w, h);
        for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
        f = { image, canvases: f ? f.canvases : new Set() };
        frames.set(id, f);
    }
    return f;
}

function paint(id: string) {
    const f = frames.get(id);
    if (!f) return;
    for (const c of f.canvases) {
        if (c.width !== f.image.width || c.height !== f.image.height) {
            c.width = f.image.width;
            c.height = f.image.height;
        }
        c.getContext('2d')?.putImageData(f.image, 0, 0);
    }
}

// `size` is the instance's current LCD size, if its state says one.
export function handleLcd(buf: ArrayBuffer, size: (id: string) => { width: number; height: number } | undefined) {
    const bytes = new Uint8Array(buf);
    const idLen = bytes[0];
    const id = new TextDecoder().decode(bytes.subarray(1, 1 + idLen));
    const dv = new DataView(buf, 1 + idLen);
    const x = dv.getUint16(0, true);
    const y = dv.getUint16(2, true);
    const w = dv.getUint16(4, true);
    const h = dv.getUint16(6, true);
    const rgb = bytes.subarray(1 + idLen + 8);
    const lcd = size(id);
    const fw = lcd ? lcd.width : Math.max(320, x + w);
    const fh = lcd ? lcd.height : Math.max(240, y + h);
    const d = frameFor(id, fw, fh).image.data;
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

export function registerCanvas(id: string, canvas: HTMLCanvasElement): () => void {
    const f = frames.get(id) || frameFor(id, 320, 240);
    f.canvases.add(canvas);
    paint(id);
    return () => {
        frames.get(id)?.canvases.delete(canvas);
    };
}

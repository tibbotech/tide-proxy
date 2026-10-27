export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as any).error || res.statusText);
    return data as T;
}

export function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
    });
}

import { ISerialPort } from './ISerialPort';
import CryptoJS from 'crypto-js';

let readerTimeout: any;


export default class BrowserSerialPort implements ISerialPort {
    port: any;

    baudRate = 115200;

    async maybeGetPort() {
        const ports = await navigator.serial.getPorts();
        if (ports.length === 1) {
            const port = ports[0];
            const portInfo = port.getInfo();
            return port;
        }
        return undefined;
    }

    async connect(portString: string, baudRate: number = 115200) {
        this.baudRate = baudRate;
        await this.disconnect();
        const port = await this.getPort();
        if (port === undefined) {
            return false;
        }
        return true;
    }

    async disconnect() {
        try {
            const port = await this.maybeGetPort();
            if (port === undefined) {
                return;
            }
            await port.forget();
            // await port.cancel();
            await port.close();
        } catch (e) {
            //
        }
    }

    async getPort() {
        this.port = await this.maybeGetPort() || await this.forceReselectPort();
        if (this.port !== undefined) {
            this.port.addEventListener('disconnect', async () => {
                this.port = undefined;
            });
        }
        return this.port;
    }

    async read() {
        let reader = this.port.readable.getReader();
        readerTimeout = setTimeout(() => {
            readerTimeout = undefined;
            try {
                reader.cancel();
                reader.releaseLock();
            } catch (e) {
                // do nothing
            }
        }, 1);
        const result = await reader.read();
        clearTimeout(readerTimeout);
        readerTimeout = undefined;
        reader.releaseLock();
        reader = undefined;
        const text = new TextDecoder().decode(result.value);
        return text;
    }

    write(data: string) {
        const encoder = new TextEncoder();
        const writer = this.port.writable.getWriter();
        writer.write(encoder.encode(data));
        writer.releaseLock();
    }

    async forceReselectPort() {
        await this.disconnect();
        if (navigator.serial) {
            const chosen = await navigator.serial.requestPort({ filters: [] });
            await chosen.open({ baudRate: this.baudRate });
            return chosen;
        }
        return undefined;
    }

    async getChecksum(buf: any) {
        const blob = new Blob([buf], {
            type: 'application/octet-stream',
        });
        const reader = new FileReader();
        reader.readAsArrayBuffer(blob);
        const data: ArrayBuffer = await new Promise((resolve) => {
            reader.onload = () => {
                resolve(reader.result as ArrayBuffer);
            };
        });
        const wordArray = CryptoJS.lib.WordArray.create(data);
        const fileChecksum = CryptoJS.SHA256(wordArray).toString();

        return fileChecksum;
    }
}
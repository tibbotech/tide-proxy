import { SerialPort } from 'serialport'
const { TextEncoder, TextDecoder } = require('util');
import { TIDEProxy } from './tide-proxy';
import { ISerialPort } from './ISerialPort';
import { EventEmitter } from 'events';
const { createHash } = require('node:crypto');

export default class NodeSerialPort extends EventEmitter implements ISerialPort {
    port: SerialPort | null = null;
    baudRate = 115200;
    portPath: string = '';
    flowingMode = true;

    constructor(portPath: string) {
        super();
        this.portPath = portPath;
        this.sendDebug = this.sendDebug.bind(this);
    }

    async connect(baudRate: number): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            try {
                this.baudRate = baudRate;
                const serialPort = new SerialPort({
                    path: this.portPath,
                    baudRate: this.baudRate,
                });
                this.port= serialPort,
                this.flowingMode = true;
                this.port.on('open', (err) => { 
                    if (err) {
                        reject(false);
                    }
                    // open logic
                    resolve(true);
                })
                this.port.on('data', (data) => {
                    if (!this.flowingMode) {
                        return;
                    }
                    this.emit('data', data);
                    const text = new TextDecoder().decode(data);
                    // this.sendDebug(text);
                });
                this.port.on('error', (err) => {
                    this.sendDebug(`Error: ${err.message}`);
                    err.message = `Error: ${err.message}`;
                    this.emit('error', err);
                    reject(false);
                });
                this.port.on('close', (err: any) => {
                    if (err) {
                        this.emit('error', err);
                    }
                });
            } catch (e) {
                reject(false);
            }
        });
    }

    async disconnect() {
        return new Promise<void>((resolve, reject) => {
            try {
                let serialPort = this.port;
                if (!serialPort || serialPort.path !== this.portPath) {
                    serialPort = new SerialPort(
                        {
                            path: this.portPath,
                            baudRate: this.baudRate,
                            autoOpen: false,
                        }
                    );
                }
                serialPort.close((err) => {
                    if (this.port && this.port.path === this.portPath) {
                        this.port = null;
                    }
                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    async getPort() {
        if (!this.port) {
            await this.connect(this.baudRate);
        }
        return this.port;
    }

    private async sendDebug(data: string) {
        return;
    }

    public async read(raw = false, size: number = 1) {
        const data = await this.port?.read(size);
        if (!data) {
            return '';
        }
        if (raw) {
            return data;
        }
        const text = new TextDecoder().decode(data);
        return text;
    }

    public async write(data: string) {
        const encoder = new TextEncoder();
        this.port?.write(encoder.encode(data));
    }

    public setFlowingMode(mode: boolean) {
        this.flowingMode = mode;
        if (this.flowingMode) {
            this.port?.resume();
        } else {
            this.port?.pause();
        }
    }

    async getChecksum(data: any) {
        return createHash('sha256').update(data).digest('hex');
    }
}


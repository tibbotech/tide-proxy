import { SerialPort } from 'serialport'
const { TextEncoder, TextDecoder } = require('util');
import { TIDEProxy } from './tide-proxy';
import { ISerialPort } from './ISerialPort';
const { createHash } = require('node:crypto');

class NodeSerialPort implements ISerialPort {
    port: SerialPort | null = null;
    baudRate = 115200;
    portPath: string = '';
    tideProxy: TIDEProxy | null = null;
    flowingMode = true;

    constructor() {
        this.sendDebug = this.sendDebug.bind(this);
    }

    setTideProxy(tideProxy: TIDEProxy) {
        this.tideProxy = tideProxy;
    }


    async connect(portPath: string, baudRate: number, reset = false): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            try {
                if (!this.tideProxy) {
                    throw new Error('TIDEProxy not set');
                }
                this.portPath = portPath;
                this.baudRate = baudRate;
                const serialPort = new SerialPort({
                    path: this.portPath,
                    baudRate: this.baudRate,
                });
                this.port= serialPort,
                this.flowingMode = true;
                this.port.on('open', () => { 
                    // open logic
                    if (reset) {
                        serialPort.write('\x03');
                        serialPort.write('\x04');
                    }
                    resolve(true);
                    // console.log('port opened');
                })
                this.port.on('data', (data) => {
                    if (!this.flowingMode) {
                        return;
                    }
                    const text = new TextDecoder().decode(data);
                    this.sendDebug(text);
                });
                this.port.on('error', (err) => {
                    this.sendDebug(`Error: ${err.message}`);
                    reject(false);
                });
                this.port.on('close', function() {
                    // console.log('port closed');
                });
            } catch (e) {
                reject(false);
            }
        });
    }

    async disconnect(port: string) {
        return new Promise<void>((resolve, reject) => {
            try {
                let serialPort = this.port;
                if (!serialPort || serialPort.path !== port) {
                    serialPort = new SerialPort(
                        {
                            path: port,
                            baudRate: this.baudRate,
                            autoOpen: false,
                        }
                    );
                }
                serialPort.close((err) => {
                    if (this.port && this.port.path === port) {
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
        if (!this.port && this.tideProxy) {
            await this.connect(this.portPath, this.baudRate);
        }
        return this.port;
    }

    private async sendDebug(data: string) {
        const proxy = this.tideProxy as TIDEProxy;
        proxy.emit('debug_print', {
            data: JSON.stringify({
                data: data,
                state: '',
            }),
            mac: this.portPath
        });
    }

    public async read(size: number = 1) {
        const data = await this.port?.read(size);
        if (!data) {
            return '';
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

const serialPortInstance = new NodeSerialPort();

export default serialPortInstance;

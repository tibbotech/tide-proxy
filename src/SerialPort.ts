import { SerialPort } from 'serialport'
const { TextEncoder, TextDecoder } = require('util');
import { TIDEProxy } from './tide-proxy';


class SerialPortInstance {
    port: SerialPort | null = null;
    queue: string[] = [];
    baudRate = 115200;
    portPath: string = '';
    tideProxy: TIDEProxy | null = null;

    constructor() {
        this.sendDebug = this.sendDebug.bind(this);
        this.addToQueue = this.addToQueue.bind(this);
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
                this.queue = [],
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
                    const text = new TextDecoder().decode(data);
                    this.addToQueue(text);
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
                if (this.port && this.port.path === port) {
                    this.port = null;
                }
                serialPort.close((err) => {
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
        console.log(data);
        proxy.emit('debug_print', {
            data: JSON.stringify({
                data: data,
                state: '',
            }),
            mac: this.portPath
        });
    }

    public async read() {
        if (this.queue.length === 0) {
            return '';
        }
        const data = this.queue.shift();
        return data;
    }

    private addToQueue(data: string) {
        this.queue.push(data);
        if (this.queue.length > 20) {
            this.queue.shift();
        }
    }
}

const serialPortInstance = new SerialPortInstance();

export default serialPortInstance;

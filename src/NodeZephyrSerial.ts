/* eslint-disable no-await-in-loop */
import { Buffer } from 'buffer';
import { ISerialPort } from './ISerialPort';
import {
    ESPLoader, FlashOptions, LoaderOptions, Transport,
} from 'esptool-js/lib/index.js';
import CryptoJS from 'crypto-js';
// import { DataPacket } from './esptool';
import path from 'path';
import fs from 'fs';
import cp from 'child_process';

// // Import required Node.js type
// import { TextEncoder as NodeTextEncoder } from 'util';

// // Check for TextEncoder in the global scope or fallback to Node.js's util.TextEncoder
// const TextEncoder: typeof globalThis.TextEncoder =
//   typeof globalThis.TextEncoder !== 'undefined'
//     ? globalThis.TextEncoder
//     : NodeTextEncoder;

export class ZephyrSerial {
    serialPort: ISerialPort | null;


    constructor (serialPort: ISerialPort | null = null) {
        this.serialPort = serialPort;
    }

    async getPort() {
        if (this.serialPort) {
            return this.serialPort.getPort();
        }
    }

    setSerialPort(port: ISerialPort | null) {
        this.serialPort = port;
    }

    async writeFilesToDevice(files: any[], proxy: any): Promise<void> {
        return new Promise(async (resolve, reject) => {
            if (this.serialPort === null) {
                return;
            }
            if (files.length !== 1) {
                throw new Error('Only one file is supported');
            }
            const {
                data,
                address,
            } = files[0];
            const fileBase = proxy.makeid(8);
            let fileName = `${fileBase}.bin`;
            const bytes = Buffer.from(data, 'binary');
            const filePath = path.join(__dirname, fileName);
            fs.writeFileSync(filePath, bytes);
            const cleanup = () => {
                if (filePath && fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }

            const esptool = `${process.env.ZEPHYR_BASE}/../modules/hal/espressif/tools/esptool_py/esptool.py`;
            const ccmd = `python ${esptool} --port ${this.serialPort.portPath} write_flash ${address} ${filePath}`;
            const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60000, shell: true });
            if (!exec.pid) {
                return;
            }
            exec.on('error', () => {
                cleanup();
                reject();
            });
            exec.on('exit', () => {
                cleanup();
                resolve();
            });
            exec.on('close', (code) => {
                console.log(`child process exited with code ${code}`);
            });
            exec.on('data', (data) => {
                console.log(data);
            });
        });
    }
}

/* eslint-disable no-await-in-loop */
import { ISerialPort } from '../ISerialPort';

export default class ESP32Serial {
    serialPort: ISerialPort | null;
    baudRate: number = 460800;


    constructor (serialPort: ISerialPort | null = null) {
        this.serialPort = serialPort;
    }

    async getPort() {
        if (this.serialPort) {
            return this.serialPort.getPort();
        }
    }

    // implemented in either browser.ts or node.ts
    async writeFilesToDevice(files: any[], espLoaderTerminal: any) {
        return;
    }
}
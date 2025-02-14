/// <reference types="node" />
import { EventEmitter } from 'stream';
import { ISerialPort } from '../ISerialPort';
export default class ESP32Serial extends EventEmitter {
    serialPort: ISerialPort | null;
    baudRate: number;
    constructor(serialPort?: ISerialPort | null);
    getPort(): Promise<any>;
    writeFilesToDevice(files: any[], espLoaderTerminal: any): Promise<void>;
}

/// <reference types="dom-serial" />
/// <reference types="node" />
import { ISerialPort } from './ISerialPort';
import { EventEmitter } from 'events';
export default class BrowserSerialPort extends EventEmitter implements ISerialPort {
    port: any;
    baudRate: number;
    flowingMode: boolean;
    dataTimer: any;
    maybeGetPort(): Promise<SerialPort | undefined>;
    connect(baudRate?: number): Promise<boolean>;
    disconnect(): Promise<void>;
    getPort(): Promise<any>;
    read(raw?: boolean): Promise<any>;
    write(data: string): void;
    forceReselectPort(): Promise<SerialPort | undefined>;
    getChecksum(buf: any): Promise<string>;
    setFlowingMode(mode: boolean): void;
    readData(): Promise<void>;
}

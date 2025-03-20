/// <reference types="node" />
import { ISerialPort } from './ISerialPort';
import { EventEmitter } from 'events';
export default class BrowserSerialPort extends EventEmitter implements ISerialPort {
    port: any;
    baudRate: number;
    flowingMode: boolean;
    dataTimer: any;
    maybeGetPort(): Promise<any>;
    connect(baudRate?: number, reset?: boolean): Promise<boolean>;
    disconnect(): Promise<void>;
    getPort(): Promise<any>;
    read(raw?: boolean): Promise<any>;
    write(data: string): void;
    forceReselectPort(): Promise<any>;
    getChecksum(buf: any): Promise<any>;
    setFlowingMode(mode: boolean): void;
    readData(): Promise<void>;
}

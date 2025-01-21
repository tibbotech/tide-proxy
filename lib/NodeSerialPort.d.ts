/// <reference types="node" />
import { SerialPort } from 'serialport';
import { ISerialPort } from './ISerialPort';
import { EventEmitter } from 'events';
export default class NodeSerialPort extends EventEmitter implements ISerialPort {
    port: SerialPort | null;
    baudRate: number;
    portPath: string;
    flowingMode: boolean;
    constructor(portPath: string);
    connect(baudRate: number, reset?: boolean): Promise<boolean>;
    disconnect(): Promise<void>;
    getPort(): Promise<SerialPort<import("@serialport/bindings-cpp").AutoDetectTypes> | null>;
    private sendDebug;
    read(raw?: boolean, size?: number): Promise<any>;
    write(data: string): Promise<void>;
    setFlowingMode(mode: boolean): void;
    getChecksum(data: any): Promise<string>;
}

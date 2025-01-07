import { Transport } from 'esptool-js/lib/index.js';
export interface SerialOptions {
    baudRate?: number | undefined;
    dataBits?: number | undefined;
    stopBits?: number | undefined;
    parity?: any | undefined;
    bufferSize?: number | undefined;
    flowControl?: any | undefined;
}
declare class NodeTransport extends Transport {
    device: any;
    tracing: boolean;
    constructor(device: any, tracing?: boolean, enableSlipReader?: boolean);
    getInfo(): string;
    getPid(): number | undefined;
    write(data: Uint8Array): Promise<void>;
    inWaiting(): number;
    read(timeout: number): AsyncGenerator<Uint8Array>;
    rawRead(): AsyncGenerator<Uint8Array>;
    private setupDataListener;
    newRead(numBytes: number, timeout: number): Promise<Uint8Array>;
    flushInput(): Promise<void>;
    flushOutput(): Promise<void>;
    setRTS(state: boolean): Promise<void>;
    setDTR(state: boolean): Promise<void>;
    connect(baud?: number, serialOptions?: SerialOptions): Promise<void>;
    sleep(ms: number): Promise<unknown>;
    waitForUnlock(timeout: number): Promise<void>;
    disconnect(): Promise<void>;
}
export { NodeTransport };

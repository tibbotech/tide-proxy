import { ISerialPort } from './ISerialPort';
export declare class MicropythonSerial {
    serialPort: ISerialPort | null;
    constructor(serialPort?: ISerialPort | null);
    getPort(): Promise<any>;
    sendToDevice(content: string): Promise<void>;
    stopRunning(): Promise<void>;
    runFileOnDevice(code: string): Promise<void>;
    read(timeout?: number): Promise<string>;
    readUntil(prompt: string, timeout?: number): Promise<string>;
    execRaw(code: string, timeout?: number): Promise<string>;
    enterRawMode(reset?: boolean): Promise<void>;
    exitRawMode(): Promise<void>;
    getFileChecksum(fileName: string, fileChecksum: string): Promise<string>;
    writeFileToDevice(file: any, blockSize?: number): Promise<void>;
}

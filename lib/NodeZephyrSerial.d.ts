import { ISerialPort } from './ISerialPort';
export declare class ZephyrSerial {
    serialPort: ISerialPort | null;
    constructor(serialPort?: ISerialPort | null);
    getPort(): Promise<any>;
    setSerialPort(port: ISerialPort | null): void;
    writeFilesToDevice(files: any[], proxy: any): Promise<void>;
}

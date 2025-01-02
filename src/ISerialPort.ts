export interface ISerialPort {
    port: any;
    portPath?: string;
    connect(baudRate: number, reset: boolean): Promise<boolean>;
    read(raw: boolean, size?: number): Promise<string>;
    write(data: string): void;
    setFlowingMode?(mode: boolean): void;
    getPort(): Promise<any>;
    getChecksum(data: any): Promise<string>;
}
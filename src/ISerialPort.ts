export interface ISerialPort {
    port: any;
    portPath?: string;
    connect(port: string, baudRate: number): Promise<boolean>;
    read(size: number): Promise<string>;
    write(data: string): void;
    setFlowingMode?(mode: boolean): void;
    getPort(): Promise<any>;
    getChecksum(data: any): Promise<string>;
}
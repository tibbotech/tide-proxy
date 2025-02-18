import ESP32Serial from './base';
export declare class UnixTightReset {
    resetDelay: number;
    transport: any;
    constructor(transport: any, resetDelay: number);
    reset(): Promise<void>;
}
export declare class NodeESP32Serial extends ESP32Serial {
    writeFilesToDevice(files: any[]): Promise<void>;
}

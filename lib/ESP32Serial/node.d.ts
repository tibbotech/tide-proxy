import ESP32Serial from './base';
export declare class NodeESP32Serial extends ESP32Serial {
    writeFilesToDevice(files: any[]): Promise<void>;
}

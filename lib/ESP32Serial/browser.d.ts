import ESP32Serial from './base';
export declare class BrowserESP32Serial extends ESP32Serial {
    writeFilesToDevice(files: any[], espLoaderTerminal: any): Promise<void>;
}

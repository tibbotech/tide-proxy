export declare class DebugPrintListener {
    private socket;
    private onOutput;
    private sendCommand;
    private handler;
    private pollInterval;
    private mac;
    constructor(socket: any, onOutput: (text: string) => void, sendCommand: (mac: string, command: string, data?: string) => void);
    attach(mac: string): void;
    detach(): void;
    get attachedMac(): string;
}

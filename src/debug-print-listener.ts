'use strict';

import { TIBBO_PROXY_MESSAGE, PCODE_COMMANDS } from './tide-proxy';
import { appendDebugOutput } from './debug-output';

const POLL_INTERVAL_MS = 2000;

/**
 * Listens for DEBUG_PRINT messages on a socket.io connection and polls
 * the device to flush pending output. Used by both the device explorer
 * (Tibbo Basic) and the GDB proxy server (Zephyr).
 */
export class DebugPrintListener {

    private handler: ((data: any) => void) | null = null;
    private pollInterval: NodeJS.Timeout | null = null;
    private mac: string = '';

    constructor(
        private socket: any,
        private onOutput: (text: string) => void,
        private sendCommand: (mac: string, command: string, data?: string) => void
    ) { }

    public attach(mac: string): void {
        this.detach();
        this.mac = mac;

        this.handler = (data: any) => {
            if (data.mac !== this.mac) {
                return;
            }
            try {
                const message = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
                const text = message.data != undefined ? message.data : String(message);
                this.onOutput(text);
                appendDebugOutput(text);
            } catch {
                if (typeof data.data === 'string') {
                    this.onOutput(data.data);
                    appendDebugOutput(data.data);
                }
            }
        };

        this.socket.emit(TIBBO_PROXY_MESSAGE.REGISTER, { mac });
        this.socket.on(TIBBO_PROXY_MESSAGE.DEBUG_PRINT, this.handler);

        this.pollInterval = setInterval(() => {
            if (this.mac === mac) {
                this.sendCommand(mac, PCODE_COMMANDS.STATE);
            }
        }, POLL_INTERVAL_MS);
    }

    public detach(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.handler) {
            this.socket.off(TIBBO_PROXY_MESSAGE.DEBUG_PRINT, this.handler);
            this.handler = null;
        }
        this.mac = '';
    }

    public get attachedMac(): string {
        return this.mac;
    }
}

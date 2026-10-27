import * as dgram from 'dgram';

import { config } from './config';

const DEVICE_PORT = 65535;
const CLIENT_TTL_MS = 60_000;

// Bridges tide-proxy (outside the container) to the simulated LAN.
// Datagrams a client sends to <relayPort> are broadcast on the sim bridge to port 65535;
// replies from devices go back to every client heard from in the last minute.
export interface RelayObserver {
    observeClientPacket(msg: Buffer): void;
    observeDevicePacket(msg: Buffer): void;
}

export class UdpRelay {
    private clientSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    private lanSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    private clients = new Map<string, { address: string; port: number; seen: number }>();

    stats = { toDevices: 0, fromDevices: 0 };

    constructor(private observer?: RelayObserver) {}

    start(): void {
        this.clientSock.on('message', (msg, rinfo) => {
            this.clients.set(`${rinfo.address}:${rinfo.port}`, { address: rinfo.address, port: rinfo.port, seen: Date.now() });
            this.stats.toDevices++;
            this.observer?.observeClientPacket(msg);
            this.lanSock.send(msg, DEVICE_PORT, '255.255.255.255');
        });
        this.lanSock.on('message', (msg) => {
            this.stats.fromDevices++;
            this.observer?.observeDevicePacket(msg);
            const now = Date.now();
            for (const [key, c] of this.clients) {
                if (now - c.seen > CLIENT_TTL_MS) {
                    this.clients.delete(key);
                    continue;
                }
                this.clientSock.send(msg, c.port, c.address);
            }
        });
        this.clientSock.on('error', (e) => console.error(`relay client socket: ${e.message}`));
        this.lanSock.on('error', (e) => console.error(`relay LAN socket: ${e.message}`));
        this.clientSock.bind(config.relayPort, '0.0.0.0');
        this.lanSock.bind(0, config.bridgeIp, () => this.lanSock.setBroadcast(true));
        console.log(`UDP relay: clients -> :${config.relayPort}, devices via ${config.bridgeIp}`);
    }

    clientList() {
        return Array.from(this.clients.values());
    }
}

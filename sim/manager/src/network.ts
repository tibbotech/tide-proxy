import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { execFile } from 'child_process';

import { config } from './config';

function run(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`${cmd} ${args.join(' ')}: ${stderr || err.message}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

export async function createTap(name: string): Promise<void> {
    if (!config.manageNetwork) {
        return;
    }
    await run('ip', ['link', 'del', name]).catch(() => undefined);
    await run('ip', ['tuntap', 'add', 'dev', name, 'mode', 'tap']);
    await run('ip', ['link', 'set', name, 'master', config.bridge]);
    await run('ip', ['link', 'set', name, 'up']);
}

export async function deleteTap(name: string): Promise<void> {
    if (!config.manageNetwork) {
        return;
    }
    await run('ip', ['link', 'del', name]).catch(() => undefined);
}

// Fixed DHCP leases so each instance keeps its IP: one "mac,ip" line per instance.
export function writeDhcpHosts(entries: { mac: string; ip: string }[]): void {
    if (!config.manageNetwork) {
        return;
    }
    try {
        fs.mkdirSync(path.dirname(config.dnsmasqHostsFile), { recursive: true });
        fs.writeFileSync(config.dnsmasqHostsFile, entries.map((e) => `${e.mac},${e.ip}`).join('\n') + '\n');
        const pid = parseInt(fs.readFileSync(config.dnsmasqPidFile, 'utf8'), 10);
        if (pid > 0) {
            process.kill(pid, 'SIGHUP');
        }
    } catch (e: any) {
        console.warn(`dnsmasq hosts update: ${e.message}`);
    }
}

// Forwards a local TCP port to the instance's web server (port 80).
export class TcpForward {
    private server?: net.Server;

    constructor(private listenPort: number, private targetHost: string, private targetPort: number) {}

    start(): void {
        if (this.server) {
            return;
        }
        this.server = net.createServer((client) => {
            const upstream = net.connect(this.targetPort, this.targetHost);
            client.pipe(upstream).pipe(client);
            const close = () => {
                client.destroy();
                upstream.destroy();
            };
            client.on('error', close);
            upstream.on('error', close);
        });
        this.server.on('error', (e) => console.warn(`forward :${this.listenPort}: ${e.message}`));
        this.server.listen(this.listenPort);
    }

    stop(): void {
        this.server?.close();
        this.server = undefined;
    }
}

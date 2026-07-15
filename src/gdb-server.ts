'use strict';

import * as Net from 'net';
import * as io from 'socket.io-client';
import { TIBBO_PROXY_MESSAGE, PCODE_COMMANDS } from './tide-proxy';
import { DebugPrintListener } from './debug-print-listener';

/**
 * GDB RSP server that lets a stock GDB debug a Zephyr device over the Taiko
 * UDP-broadcast protocol.
 *
 * GDB connects to a local TCP port (`target remote localhost:<port>`). Each
 * RSP packet body is tunneled to the target inside a Taiko command
 * (`_[MAC]R<body>|nonce`, sent by the TIDE proxy over UDP broadcast /
 * AF_PACKET, so it reaches devices that have no valid IP configuration).
 * The device feeds the body to its on-board GDB stub and returns the RSP
 * reply in the Taiko response. Reliability comes from the proxy's
 * nonce-matched retries, so RSP ack characters ('+'/'-') are handled locally
 * on the TCP side and never tunneled.
 *
 * Asynchronous execution (continue/step) is bridged by polling: the device
 * answers a resume packet with an empty reply and the server then sends empty
 * 'R' commands until the device reports the deferred stop reply (e.g. S05).
 */

const GDB_TUNNEL_COMMAND = 'R';
/** Interval between stop-reply polls while the target is running. */
const RUN_POLL_INTERVAL = 150;
/** Per-exchange timeout. The proxy retries ~10 times with backoff below this. */
const EXCHANGE_TIMEOUT = 4000;
/**
 * Maximum RSP packet body the tunnel can carry. Taiko frames are capped at
 * 256 bytes on the device and replies carry a 35-byte MAC/status/nonce
 * overhead; 200 (0xc8) leaves comfortable margin. The device stub advertises
 * PacketSize=3ff for its direct TCP/UDP transports, so the qSupported reply
 * is rewritten on the way through.
 */
const TUNNEL_PACKET_SIZE = 0xc8;

interface PendingExchange {
    resolve: (data: string | undefined) => void;
    timer: NodeJS.Timeout;
}

interface RegisterInfo {
    regnum: number;
    bitsize: number;
}

export class GdbProxyServer {

    private server: Net.Server | undefined;
    private socket: any;
    private targetMac = '';
    private client: Net.Socket | undefined;
    private port = 0;

    private pendingExchanges: Map<string, PendingExchange> = new Map();
    /** Serializes tunnel exchanges: RSP allows one outstanding packet. */
    private chain: Promise<void> = Promise.resolve();
    private polling = false;
    private interruptRequested = false;

    /** Parsed register map from target XML for g-packet splitting. */
    private registers: RegisterInfo[] = [];
    private targetXmlBuffer = '';
    private targetXmlComplete = false;

    /** Listener for device console output (debug_print messages). */
    private debugPrintListener: DebugPrintListener | undefined;

    // RSP stream parser state
    private inPacket = false;
    private packetBody = '';
    private checksumChars = '';
    private inChecksum = false;

    constructor(private socketPort: number) {
    }

    /**
     * Start listening (idempotent). Resolves with the TCP port GDB should
     * connect to.
     */
    public start(): Promise<number> {
        if (this.server != undefined) {
            return Promise.resolve(this.port);
        }
        if (this.socket == undefined) {
            this.socket = io.connect(`http://localhost:${this.socketPort}/tide`);
            this.socket.on(TIBBO_PROXY_MESSAGE.REPLY, (message: any) => {
                this.onReply(message);
            });
        }
        return new Promise((resolve, reject) => {
            const server = Net.createServer((client) => {
                this.onClient(client);
            });
            server.on('error', (err) => {
                this.server = undefined;
                reject(err);
            });
            server.listen(0, '127.0.0.1', () => {
                this.server = server;
                this.port = (<Net.AddressInfo>server.address()).port;
                resolve(this.port);
            });
        });
    }

    public setTarget(mac: string): void {
        if (mac != this.targetMac && this.client != undefined) {
            this.client.destroy();
            this.client = undefined;
        }
        this.targetMac = mac;
    }

    /**
     * Register a callback to receive device console output (printk, etc.)
     * that arrives as DEBUG_PRINT messages alongside the GDB traffic.
     */
    public onConsoleOutput(handler: (text: string) => void): void {
        this.detachConsoleOutput();
        if (this.socket == undefined || this.targetMac == '') {
            return;
        }
        this.socket.emit('set_pdb_storage_address', { mac: this.targetMac, data: 0 });
        this.socket.emit(TIBBO_PROXY_MESSAGE.COMMAND, { mac: this.targetMac, command: PCODE_COMMANDS.RUN, data: '' });
        this.debugPrintListener = new DebugPrintListener(
            this.socket,
            handler,
            (mac, cmd, data) => {
                this.socket.emit(TIBBO_PROXY_MESSAGE.COMMAND, { mac, command: cmd, data: data || '' });
            }
        );
        this.debugPrintListener.attach(this.targetMac);
    }

    /** Stop listening for device console output. */
    public detachConsoleOutput(): void {
        if (this.debugPrintListener) {
            this.debugPrintListener.detach();
            this.debugPrintListener = undefined;
        }
    }

    public dispose(): void {
        if (this.client != undefined) {
            this.client.destroy();
            this.client = undefined;
        }
        if (this.server != undefined) {
            this.server.close();
            this.server = undefined;
        }
        this.detachConsoleOutput();
        if (this.socket != undefined) {
            this.socket.disconnect();
            this.socket = undefined;
        }
        for (const pending of this.pendingExchanges.values()) {
            clearTimeout(pending.timer);
            pending.resolve(undefined);
        }
        this.pendingExchanges.clear();
    }

    private onClient(client: Net.Socket): void {
        // one debugger at a time; a new connection supersedes the old one
        if (this.client != undefined) {
            this.client.destroy();
        }
        this.client = client;
        this.inPacket = false;
        this.inChecksum = false;
        this.packetBody = '';
        this.checksumChars = '';
        this.polling = false;
        this.interruptRequested = false;
        this.registers = [];
        this.targetXmlBuffer = '';
        this.targetXmlComplete = false;
        client.setNoDelay(true);
        client.on('data', (data: Buffer) => {
            this.onClientData(client, data);
        });
        const cleanup = () => {
            if (this.client === client) {
                this.client = undefined;
                this.polling = false;
            }
        };
        client.on('close', cleanup);
        client.on('error', cleanup);
    }

    private onClientData(client: Net.Socket, data: Buffer): void {
        for (let i = 0; i < data.length; i++) {
            const byte = data[i];
            const char = String.fromCharCode(byte);
            if (this.inChecksum) {
                this.checksumChars += char;
                if (this.checksumChars.length == 2) {
                    this.inChecksum = false;
                    const body = this.packetBody;
                    const expected = parseInt(this.checksumChars, 16);
                    if (this.checksum(body) == expected) {
                        client.write('+');
                        this.enqueuePacket(client, body);
                    } else {
                        client.write('-');
                    }
                }
                continue;
            }
            if (this.inPacket) {
                if (char == '#') {
                    this.inPacket = false;
                    this.inChecksum = true;
                    this.checksumChars = '';
                } else {
                    this.packetBody += char;
                }
                continue;
            }
            switch (char) {
                case '$':
                    this.inPacket = true;
                    this.packetBody = '';
                    break;
                case '+':
                case '-':
                    // acks are handled locally; the tunnel is reliable
                    break;
                case '\x03':
                    this.onInterrupt(client);
                    break;
            }
        }
    }

    private checksum(body: string): number {
        let sum = 0;
        for (let i = 0; i < body.length; i++) {
            sum = (sum + body.charCodeAt(i)) & 0xff;
        }
        return sum;
    }

    private sendToGdb(client: Net.Socket, body: string): void {
        if (client.destroyed) {
            return;
        }
        const cksum = this.checksum(body).toString(16).padStart(2, '0');
        client.write(`$${body}#${cksum}`, 'binary');
    }

    private onInterrupt(client: Net.Socket): void {
        if (this.polling) {
            // picked up by the poll loop, which forwards the stop reply
            this.interruptRequested = true;
            return;
        }
        this.chain = this.chain.then(async () => {
            const reply = await this.exchange('\x03');
            this.sendToGdb(client, reply != undefined ? reply : 'S00');
        });
    }

    private enqueuePacket(client: Net.Socket, body: string): void {
        this.chain = this.chain.then(async () => {
            try {
                await this.handlePacket(client, body);
            }
            catch (ex) {
                this.sendToGdb(client, 'E01');
            }
        });
    }

    private async handlePacket(client: Net.Socket, body: string): Promise<void> {
        // Binary-payload packets ('X') can contain bytes the ASCII tunnel
        // would mangle; an empty reply makes GDB fall back to hex 'M' writes.
        if (body[0] == 'X') {
            this.sendToGdb(client, '');
            return;
        }
        // Intercept 'g' (read all registers): the full response may exceed the
        // Taiko frame capacity; read registers individually with 'p' instead.
        if (body == 'g' && this.registers.length > 0) {
            const result = await this.readAllRegistersIndividually();
            if (result != undefined) {
                this.sendToGdb(client, result);
                return;
            }
            this.sendToGdb(client, 'E01');
            return;
        }
        let reply = await this.exchange(body);
        if (reply == undefined) {
            this.sendToGdb(client, 'E01');
            return;
        }
        if (body.indexOf('qSupported') == 0) {
            reply = reply.replace(/PacketSize=[0-9a-fA-F]+/,
                `PacketSize=${TUNNEL_PACKET_SIZE.toString(16)}`);
        }
        // Accumulate target XML to build the register map.
        if (body.indexOf('qXfer:features:read:target.xml:') == 0) {
            this.accumulateTargetXml(reply);
        }
        if (reply == '' && this.isResumePacket(body)) {
            // target is running; poll for the deferred stop reply
            await this.pollForStop(client);
            return;
        }
        this.sendToGdb(client, reply);
    }

    /**
     * Accumulate qXfer target.xml reply fragments and parse registers when
     * the full document is received. Replies are prefixed with 'm' (more)
     * or 'l' (last).
     */
    private accumulateTargetXml(reply: string): void {
        if (this.targetXmlComplete) {
            return;
        }
        if (reply.length == 0) {
            return;
        }
        const prefix = reply[0]; // 'm' = more data, 'l' = last chunk
        this.targetXmlBuffer += reply.substring(1);
        if (prefix == 'l') {
            this.targetXmlComplete = true;
            this.parseRegistersFromXml(this.targetXmlBuffer);
        }
    }

    private parseRegistersFromXml(xml: string): void {
        const regs: RegisterInfo[] = [];
        const regPattern = /<reg\s[^>]*?>/g;
        let match;
        let implicitNum = 0;
        while ((match = regPattern.exec(xml)) != null) {
            const tag = match[0];
            const bitsizeMatch = tag.match(/bitsize="(\d+)"/);
            const regnumMatch = tag.match(/regnum="(\d+)"/);
            const bitsize = bitsizeMatch ? parseInt(bitsizeMatch[1]) : 32;
            const regnum = regnumMatch ? parseInt(regnumMatch[1]) : implicitNum;
            regs.push({ regnum, bitsize });
            implicitNum = regnum + 1;
        }
        // Sort by regnum so the g-packet assembly is in order.
        regs.sort((a, b) => a.regnum - b.regnum);
        this.registers = regs;
    }

    /**
     * Read all registers individually using 'p' packets and assemble the
     * result in g-packet format (concatenated hex values in regnum order,
     * with gaps filled with 'x' bytes).
     */
    private async readAllRegistersIndividually(): Promise<string | undefined> {
        if (this.registers.length == 0) {
            return undefined;
        }
        const maxRegnum = this.registers[this.registers.length - 1].regnum;
        // Build a map of regnum → bitsize for gap-filling.
        const regMap = new Map<number, number>();
        for (const r of this.registers) {
            regMap.set(r.regnum, r.bitsize);
        }
        let result = '';
        for (let i = 0; i <= maxRegnum; i++) {
            const bitsize = regMap.get(i);
            if (bitsize == undefined) {
                // Gap register: fill with zeros (4 bytes assumed)
                result += '00000000';
                continue;
            }
            const reply = await this.exchange(`p${i.toString(16)}`);
            if (reply == undefined || reply[0] == 'E') {
                // If individual read fails, fill with 'xx' (unavailable)
                result += 'x'.repeat(bitsize / 4);
                continue;
            }
            // Pad to expected width in case the stub returns fewer digits.
            const expectedHexChars = bitsize / 4;
            result += reply.padEnd(expectedHexChars, '0');
        }
        return result;
    }

    private isResumePacket(body: string): boolean {
        switch (body[0]) {
            case 'c':
            case 's':
            case 'C':
            case 'S':
                return true;
        }
        if (body.indexOf('vCont;') == 0 && body.length > 6) {
            const action = body[6];
            return action == 'c' || action == 's' || action == 'C' || action == 'S';
        }
        return false;
    }

    private async pollForStop(client: Net.Socket): Promise<void> {
        this.polling = true;
        try {
            while (this.client === client && !client.destroyed) {
                await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL));
                if (this.client !== client || client.destroyed) {
                    return;
                }
                const request = this.interruptRequested ? '\x03' : '';
                this.interruptRequested = false;
                const reply = await this.exchange(request);
                if (reply == undefined) {
                    // exchange timed out (device busy/unreachable); keep polling
                    continue;
                }
                if (reply != '') {
                    this.sendToGdb(client, reply);
                    return;
                }
            }
        }
        finally {
            this.polling = false;
        }
    }

    /**
     * One Taiko exchange: send an 'R' command and wait for the nonce-matched
     * reply. Resolves with the RSP reply body, or undefined on timeout.
     */
    private exchange(data: string): Promise<string | undefined> {
        return new Promise((resolve) => {
            if (this.socket == undefined || this.targetMac == '') {
                resolve(undefined);
                return;
            }
            const nonce = this.makeid(8);
            const timer = setTimeout(() => {
                this.pendingExchanges.delete(nonce);
                resolve(undefined);
            }, EXCHANGE_TIMEOUT);
            this.pendingExchanges.set(nonce, { resolve, timer });
            this.socket.emit('command', {
                mac: this.targetMac,
                command: GDB_TUNNEL_COMMAND,
                data: data,
                nonce: nonce
            });
        });
    }

    private onReply(message: any): void {
        if (message.mac != this.targetMac || message.nonce == undefined) {
            return;
        }
        const pending = this.pendingExchanges.get(message.nonce);
        if (pending == undefined) {
            return;
        }
        this.pendingExchanges.delete(message.nonce);
        clearTimeout(pending.timer);
        pending.resolve(message.data != undefined ? message.data : '');
    }

    private makeid(length: number): string {
        let result = '';
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        return result;
    }
}

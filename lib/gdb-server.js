'use strict';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GdbProxyServer = exports.setGdbLogSink = void 0;
const Net = __importStar(require("net"));
const io = __importStar(require("socket.io-client"));
const tide_proxy_1 = require("./tide-proxy");
const debug_print_listener_1 = require("./debug-print-listener");
const GDB_TUNNEL_COMMAND = 'R';
const RUN_POLL_INTERVAL = 150;
const EXCHANGE_TIMEOUT = 12000;
const TUNNEL_PACKET_SIZE = 0xc8;
let gdbLogSink = (msg) => console.log(msg);
function setGdbLogSink(fn) {
    gdbLogSink = fn;
}
exports.setGdbLogSink = setGdbLogSink;
const glog = (msg) => {
    gdbLogSink(`[gdb-rsp ${new Date().toISOString().substring(11, 23)}] ${msg}`);
};
const gtrunc = (s) => {
    if (s == undefined) {
        return '<undefined>';
    }
    return s.length > 96 ? `${s.substring(0, 96)}...(${s.length} chars)` : s;
};
class GdbProxyServer {
    constructor(socketPort) {
        this.socketPort = socketPort;
        this.targetMac = '';
        this.port = 0;
        this.pendingExchanges = new Map();
        this.chain = Promise.resolve();
        this.polling = false;
        this.interruptRequested = false;
        this.registers = [];
        this.targetXmlBuffer = '';
        this.targetXmlComplete = false;
        this.inPacket = false;
        this.packetBody = '';
        this.checksumChars = '';
        this.inChecksum = false;
    }
    start() {
        if (this.server != undefined) {
            return Promise.resolve(this.port);
        }
        if (this.socket == undefined) {
            this.socket = io.connect(`http://localhost:${this.socketPort}/tide`);
            this.socket.on('connect', () => glog('tunnel socket.io connected'));
            this.socket.on('disconnect', (reason) => glog(`tunnel socket.io DISCONNECTED: ${reason}`));
            this.socket.on(tide_proxy_1.TIBBO_PROXY_MESSAGE.REPLY, (message) => {
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
                this.port = server.address().port;
                glog(`RSP server listening on 127.0.0.1:${this.port}`);
                resolve(this.port);
            });
        });
    }
    setTarget(mac) {
        if (mac != this.targetMac && this.client != undefined) {
            glog(`setTarget ${this.targetMac} -> ${mac}: destroying current GDB connection`);
            this.client.destroy();
            this.client = undefined;
        }
        this.targetMac = mac;
    }
    onConsoleOutput(handler) {
        this.detachConsoleOutput();
        if (this.socket == undefined || this.targetMac == '') {
            return;
        }
        this.socket.emit('set_pdb_storage_address', { mac: this.targetMac, data: 0 });
        this.socket.emit(tide_proxy_1.TIBBO_PROXY_MESSAGE.COMMAND, { mac: this.targetMac, command: tide_proxy_1.PCODE_COMMANDS.RUN, data: '' });
        this.debugPrintListener = new debug_print_listener_1.DebugPrintListener(this.socket, handler, (mac, cmd, data) => {
            this.socket.emit(tide_proxy_1.TIBBO_PROXY_MESSAGE.COMMAND, { mac, command: cmd, data: data || '' });
        }, () => this.pendingExchanges.size == 0);
        this.debugPrintListener.attach(this.targetMac);
    }
    detachConsoleOutput() {
        if (this.debugPrintListener) {
            this.debugPrintListener.detach();
            this.debugPrintListener = undefined;
        }
    }
    dispose() {
        glog(`dispose called:\n${new Error().stack}`);
        if (this.client != undefined) {
            glog('dispose: destroying GDB connection');
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
    onClient(client) {
        glog(`GDB connected from ${client.remoteAddress}:${client.remotePort} (target=${this.targetMac})`);
        if (this.client != undefined) {
            glog('kicking previous GDB connection (a second client connected)');
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
        client.on('data', (data) => {
            this.onClientData(client, data);
        });
        const cleanup = () => {
            if (this.client === client) {
                this.client = undefined;
                this.polling = false;
            }
        };
        client.on('close', (hadError) => {
            glog(`GDB connection closed (hadError=${hadError})`);
            cleanup();
        });
        client.on('error', (err) => {
            glog(`GDB connection error: ${err && err.message}`);
            cleanup();
        });
    }
    onClientData(client, data) {
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
                    }
                    else {
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
                }
                else {
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
                    break;
                case '\x03':
                    this.onInterrupt(client);
                    break;
            }
        }
    }
    checksum(body) {
        let sum = 0;
        for (let i = 0; i < body.length; i++) {
            sum = (sum + body.charCodeAt(i)) & 0xff;
        }
        return sum;
    }
    sendToGdb(client, body) {
        if (client.destroyed) {
            glog(`sendToGdb DROPPED (connection already closed) body=${gtrunc(body)}`);
            return;
        }
        const cksum = this.checksum(body).toString(16).padStart(2, '0');
        client.write(`$${body}#${cksum}`, 'binary');
    }
    onInterrupt(client) {
        if (this.polling) {
            this.interruptRequested = true;
            return;
        }
        this.chain = this.chain.then(() => __awaiter(this, void 0, void 0, function* () {
            const reply = yield this.exchange('\x03');
            this.sendToGdb(client, reply != undefined ? reply : 'S00');
        }));
    }
    enqueuePacket(client, body) {
        this.chain = this.chain.then(() => __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.handlePacket(client, body);
            }
            catch (ex) {
                glog(`handlePacket THREW for '${gtrunc(body)}': ${ex && ex.stack ? ex.stack : ex}`);
                this.sendToGdb(client, 'E01');
            }
        }));
    }
    handlePacket(client, body) {
        return __awaiter(this, void 0, void 0, function* () {
            if (body[0] == 'X') {
                this.sendToGdb(client, '');
                return;
            }
            if (body == 'g' && this.registers.length > 0) {
                const gStarted = Date.now();
                const result = yield this.readAllRegistersIndividually();
                glog(`'g' expanded to ${this.registers.length} per-register reads in ${Date.now() - gStarted}ms (result=${result != undefined ? 'ok' : 'E01'})`);
                if (result != undefined) {
                    this.sendToGdb(client, result);
                    return;
                }
                this.sendToGdb(client, 'E01');
                return;
            }
            let reply = yield this.exchange(body);
            if (reply == undefined) {
                this.sendToGdb(client, 'E01');
                return;
            }
            if (body.indexOf('qSupported') == 0) {
                reply = reply.replace(/PacketSize=[0-9a-fA-F]+/, `PacketSize=${TUNNEL_PACKET_SIZE.toString(16)}`);
            }
            if (body.indexOf('qXfer:features:read:target.xml:') == 0) {
                this.accumulateTargetXml(reply);
            }
            if (reply == '' && this.isResumePacket(body)) {
                yield this.pollForStop(client);
                return;
            }
            this.sendToGdb(client, reply);
        });
    }
    accumulateTargetXml(reply) {
        if (this.targetXmlComplete) {
            return;
        }
        if (reply.length == 0) {
            return;
        }
        const prefix = reply[0];
        this.targetXmlBuffer += reply.substring(1);
        if (prefix == 'l') {
            this.targetXmlComplete = true;
            this.parseRegistersFromXml(this.targetXmlBuffer);
        }
    }
    parseRegistersFromXml(xml) {
        const regs = [];
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
        regs.sort((a, b) => a.regnum - b.regnum);
        this.registers = regs;
    }
    readAllRegistersIndividually() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.registers.length == 0) {
                return undefined;
            }
            const maxRegnum = this.registers[this.registers.length - 1].regnum;
            const regMap = new Map();
            for (const r of this.registers) {
                regMap.set(r.regnum, r.bitsize);
            }
            let result = '';
            for (let i = 0; i <= maxRegnum; i++) {
                const bitsize = regMap.get(i);
                if (bitsize == undefined) {
                    result += '00000000';
                    continue;
                }
                const reply = yield this.exchange(`p${i.toString(16)}`);
                if (reply == undefined || reply[0] == 'E') {
                    result += 'x'.repeat(bitsize / 4);
                    continue;
                }
                const expectedHexChars = bitsize / 4;
                result += reply.padEnd(expectedHexChars, '0');
            }
            return result;
        });
    }
    isResumePacket(body) {
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
    pollForStop(client) {
        return __awaiter(this, void 0, void 0, function* () {
            this.polling = true;
            try {
                while (this.client === client && !client.destroyed) {
                    yield new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL));
                    if (this.client !== client || client.destroyed) {
                        return;
                    }
                    const request = this.interruptRequested ? '\x03' : '';
                    this.interruptRequested = false;
                    const reply = yield this.exchange(request);
                    if (reply == undefined) {
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
        });
    }
    exchange(data) {
        return new Promise((resolve) => {
            if (this.socket == undefined || this.targetMac == '') {
                glog(`exchange refused (socket=${this.socket != undefined ? 'up' : 'down'}, targetMac='${this.targetMac}') data=${gtrunc(data)}`);
                resolve(undefined);
                return;
            }
            const nonce = this.makeid(8);
            const started = Date.now();
            const timer = setTimeout(() => {
                this.pendingExchanges.delete(nonce);
                glog(`exchange TIMEOUT ${Date.now() - started}ms nonce=${nonce} sent=${gtrunc(data)}`);
                resolve(undefined);
            }, EXCHANGE_TIMEOUT);
            this.pendingExchanges.set(nonce, { resolve, timer, started, data });
            this.socket.emit('command', {
                mac: this.targetMac,
                command: GDB_TUNNEL_COMMAND,
                data: data,
                nonce: nonce
            });
        });
    }
    onReply(message) {
        if (message.mac != this.targetMac || message.nonce == undefined) {
            glog(`reply IGNORED (mac=${message.mac} vs target=${this.targetMac}, nonce=${message.nonce}) data=${gtrunc(message.data)}`);
            return;
        }
        const pending = this.pendingExchanges.get(message.nonce);
        if (pending == undefined) {
            glog(`reply for unknown/expired nonce=${message.nonce} data=${gtrunc(message.data)}`);
            return;
        }
        this.pendingExchanges.delete(message.nonce);
        clearTimeout(pending.timer);
        const reply = message.data != undefined ? message.data : '';
        if (pending.data != '' || reply != '') {
            glog(`exchange ok ${Date.now() - pending.started}ms nonce=${message.nonce} sent=${gtrunc(pending.data)} reply=${gtrunc(reply)}`);
        }
        pending.resolve(reply);
    }
    makeid(length) {
        let result = '';
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        return result;
    }
}
exports.GdbProxyServer = GdbProxyServer;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2RiLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9nZGItc2VydmVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLFlBQVksQ0FBQzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUViLHlDQUEyQjtBQUMzQixxREFBdUM7QUFDdkMsNkNBQW1FO0FBQ25FLGlFQUE0RDtBQW9CNUQsTUFBTSxrQkFBa0IsR0FBRyxHQUFHLENBQUM7QUFFL0IsTUFBTSxpQkFBaUIsR0FBRyxHQUFHLENBQUM7QUFFOUIsTUFBTSxnQkFBZ0IsR0FBRyxLQUFLLENBQUM7QUFRL0IsTUFBTSxrQkFBa0IsR0FBRyxJQUFJLENBQUM7QUFRaEMsSUFBSSxVQUFVLEdBQTBCLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ2xFLFNBQWdCLGFBQWEsQ0FBQyxFQUF5QjtJQUNuRCxVQUFVLEdBQUcsRUFBRSxDQUFDO0FBQ3BCLENBQUM7QUFGRCxzQ0FFQztBQUNELE1BQU0sSUFBSSxHQUFHLENBQUMsR0FBVyxFQUFRLEVBQUU7SUFDL0IsVUFBVSxDQUFDLFlBQVksSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxTQUFTLENBQUMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxLQUFLLEdBQUcsRUFBRSxDQUFDLENBQUM7QUFDakYsQ0FBQyxDQUFDO0FBQ0YsTUFBTSxNQUFNLEdBQUcsQ0FBQyxDQUFxQixFQUFVLEVBQUU7SUFDN0MsSUFBSSxDQUFDLElBQUksU0FBUyxFQUFFO1FBQ2hCLE9BQU8sYUFBYSxDQUFDO0tBQ3hCO0lBQ0QsT0FBTyxDQUFDLENBQUMsTUFBTSxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsT0FBTyxDQUFDLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQyxDQUFDLENB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
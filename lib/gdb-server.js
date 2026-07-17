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
        });
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
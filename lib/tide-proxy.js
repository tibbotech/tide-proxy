"use strict";
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
exports.TIBBO_PROXY_MESSAGE = exports.PCODE_COMMANDS = exports.PCODE_STATE = exports.PCODEMachineState = exports.TIDEProxy = void 0;
const dgram = require("dgram");
const perf_hooks_1 = require("perf_hooks");
const socket_io_client_1 = require("socket.io-client");
const winston = require('winston');
const url = require('url');
const io = require("socket.io")({ serveClient: false });
const os = require('os');
const ifaces = os.networkInterfaces();
const { Subject } = require('await-notify');
const RETRY_TIMEOUT = 50;
const PORT = 65535;
const REPLY_OK = "A";
const NOTIFICATION_OK = "J";
const ERROR_SEQUENCE = 'S';
const BLOCK_SIZE = 128;
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.simple(),
    transports: [],
});
if (process.env.NODE_ENV != 'production') {
    logger.add(new winston.transports.Console({ format: winston.format.simple(), }));
}
class TIDEProxy {
    constructor(serverAddress = '', proxyName, port = 3535, targetInterface) {
        this.devices = [];
        this.pendingMessages = [];
        this.interfaces = [];
        this.currentInterface = undefined;
        this.memoryCalls = {};
        this.discoveredDevices = {};
        this.id = new Date().getTime().toString();
        for (const key in ifaces) {
            const iface = ifaces[key];
            for (let i = 0; i < iface.length; i++) {
                const tmp = iface[i];
                if (tmp.family == 'IPv4' && !tmp.internal) {
                    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
                    socket.on('close', () => {
                        logger.info('client disconnected');
                    });
                    socket.on('error', (err) => {
                        console.log(`udp server error:\n${err.stack}`);
                        socket.close();
                    });
                    socket.on('message', (msg, info) => {
                        this.handleMessage(msg, info, int);
                    });
                    socket.on('listening', () => {
                        console.log('listening on ' + tmp.address);
                    });
                    socket.bind({
                        address: tmp.address
                    }, () => {
                        console.log('socket bound for ' + tmp.address);
                        socket.setBroadcast(true);
                    });
                    const int = {
                        socket: socket,
                        netInterface: tmp
                    };
                    this.interfaces.push(int);
                    if (targetInterface && key == targetInterface) {
                        this.currentInterface = int;
                    }
                }
            }
        }
        if (serverAddress != '') {
            this.setServer(serverAddress, proxyName);
        }
        this.server = io.of('/tide');
        this.clients = [];
        this.server.on('connection', (conClient) => {
            this.clients.push(conClient);
            console.log('client connected on socket');
            conClient.on(TIBBO_PROXY_MESSAGE.REFRESH, (message) => {
                this.handleRefresh();
            });
            conClient.on(TIBBO_PROXY_MESSAGE.BUZZ, (message) => {
                this.sendToDevice(message.mac, PCODE_COMMANDS.BUZZ, '');
            });
            conClient.on(TIBBO_PROXY_MESSAGE.REBOOT, (message) => {
                this.sendToDevice(message.mac, PCODE_COMMANDS.REBOOT, '', false);
            });
            conClient.on(TIBBO_PROXY_MESSAGE.APPLICATION_UPLOAD, (message) => {
                this.startApplicationUpload(message.mac, message.data);
            });
            conClient.on(TIBBO_PROXY_MESSAGE.COMMAND, (message) => {
                this.sendToDevice(message.mac, message.command, message.data, true, message.nonce);
            });
            conClient.on(TIBBO_PROXY_MESSAGE.SET_PDB_STORAGE_ADDRESS, this.setPDBAddress.bind(this));
            conClient.on('close', () => {
                console.log('socket closed');
                this.clients.splice(this.clients.indexOf(this.clients), 1);
            });
        });
        io.listen(port);
    }
    setInterface(targetInterface) {
        this.currentInterface = undefined;
        let tmpInterface = ifaces[targetInterface];
        if (tmpInterface) {
            for (let i = 0; i < tmpInterface.length; i++) {
                const tmp = tmpInterface[i];
                if (tmp.family == 'IPv4' && !tmp.internal) {
                    this.currentInterface = this.interfaces[i];
                    return;
                }
            }
        }
    }
    setServer(serverAddress, proxyName) {
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.close();
        }
        const socketURL = url.parse(serverAddress);
        let socketioPath = '/socket.io';
        if (socketURL.path != '/') {
            socketioPath = socketURL.path + socketioPath;
        }
        this.socket = socket_io_client_1.io(socketURL.protocol + '//' + socketURL.host + '/devices', {
            path: socketioPath,
            agent: false,
            rejectUnauthorized: false
        });
        this.socket.on('connect', () => {
            this.emit(TIBBO_PROXY_MESSAGE.REGISTER, proxyName);
            logger.error('connected');
        });
        this.socket.on('disconnect', () => {
            logger.error('disconnected');
        });
        this.socket.on('connect_error', (error) => {
            logger.error('connection error' + error);
        });
        this.socket.on(TIBBO_PROXY_MESSAGE.REFRESH, (message) => {
            this.handleRefresh();
        });
        this.socket.on(TIBBO_PROXY_MESSAGE.BUZZ, (message) => {
            this.sendToDevice(message.mac, PCODE_COMMANDS.BUZZ, '');
        });
        this.socket.on(TIBBO_PROXY_MESSAGE.REBOOT, (message) => {
            this.sendToDevice(message.mac, PCODE_COMMANDS.REBOOT, '', false);
        });
        this.socket.on(TIBBO_PROXY_MESSAGE.APPLICATION_UPLOAD, (message) => {
            this.startApplicationUpload(message.mac, message.data);
        });
        this.socket.on(TIBBO_PROXY_MESSAGE.COMMAND, (message) => {
            this.sendToDevice(message.mac, message.command, message.data, true, message.nonce);
        });
        this.socket.on(TIBBO_PROXY_MESSAGE.SET_PDB_STORAGE_ADDRESS, this.setPDBAddress.bind(this));
    }
    handleRefresh() {
        const msg = Buffer.from(PCODE_COMMANDS.DISCOVER);
        this.discoveredDevices = {};
        this.send(msg);
    }
    setPDBAddress(message) {
        const device = this.getDevice(message.mac);
        device.pdbStorageAddress = Number(message.data);
    }
    handleMessage(msg, info, socket) {
        const message = msg.toString();
        const parts = message.substring(message.indexOf('[') + 1, message.indexOf(']')).split('.');
        if (message.substr(0, 1) == '_') {
            return;
        }
        logger.info(`${new Date().toLocaleTimeString()} recv: ${message}`);
        for (let i = 0; i < parts.length; i++) {
            parts[i] = Number(parts[i]).toString();
        }
        const mac = parts.join('.');
        const ip = info.address.toString();
        const device = this.getDevice(mac);
        if (device.ip == '') {
            device.ip = ip;
        }
        device.deviceInterface = socket;
        const secondPart = message.substring(message.indexOf(']') + 2);
        const messagePart = secondPart.split('|')[0];
        let replyFor = undefined;
        const identifier = secondPart.split('|')[1];
        for (let i = 0; i < device.messageQueue.length; i++) {
            if (device.messageQueue[i].nonce == identifier) {
                replyFor = device.messageQueue.splice(i, 1)[0];
                i--;
            }
        }
        for (let i = 0; i < this.pendingMessages.length; i++) {
            if (this.pendingMessages[i].nonce == identifier) {
                this.pendingMessages.splice(i, 1)[0];
                i--;
            }
        }
        const reply = message.substring(message.indexOf(']') + 1, message.indexOf(']') + 2);
        let fileBlock;
        if (this.discoveredDevices[mac] == undefined) {
            this.discoveredDevices[mac] = mac;
            device.ip = ip;
            device.mac = mac;
            this.sendToDevice(mac, PCODE_COMMANDS.INFO, '');
        }
        if (reply != undefined) {
            const tmpReply = {
                mac: mac,
                data: messagePart,
                reply: message.substr(message.indexOf(']') + 1, 1),
                nonce: identifier
            };
            let replyForCommand = '';
            if (replyFor != undefined) {
                replyForCommand = replyFor.command;
            }
            else {
                if (!identifier && device.fileBlocksTotal > 0) {
                    replyForCommand = PCODE_COMMANDS.UPLOAD;
                }
            }
            tmpReply.replyFor = replyForCommand;
            switch (tmpReply.replyFor) {
                case PCODE_COMMANDS.UPLOAD:
                    break;
                default:
                    this.emit(TIBBO_PROXY_MESSAGE.REPLY, tmpReply);
                    break;
            }
            let stateString = '';
            if (replyForCommand == PCODE_COMMANDS.GET_MEMORY) {
                if (device.pdbStorageAddress != undefined) {
                    const address = tmpReply.data.substring(13, 17).toLowerCase();
                    const value = tmpReply.data.split(' ')[1];
                    if (this.memoryCalls[address] != undefined) {
                        if (value != undefined) {
                            this.memoryCalls[address].message = value.split(',');
                            this.memoryCalls[address].notify();
                        }
                    }
                }
            }
            switch (replyForCommand) {
                case PCODE_COMMANDS.INFO:
                    {
                        const parts = messagePart.split('/');
                        device.tios = parts[0];
                        device.app = parts[2];
                        this.sendToDevice(mac, PCODE_COMMANDS.STATE, '');
                    }
                    break;
                case PCODE_COMMANDS.PAUSE:
                    device.lastRunCommand = undefined;
                    break;
                case PCODE_COMMANDS.RUN:
                case PCODE_COMMANDS.STEP:
                case PCODE_COMMANDS.SET_POINTER:
                    stateString = messagePart;
                    if (replyForCommand == PCODE_COMMANDS.RUN || replyForCommand == PCODE_COMMANDS.STEP) {
                        device.lastRunCommand = replyFor;
                    }
                    break;
                case PCODE_COMMANDS.STATE:
                    {
                        const replyParts = messagePart.split('/');
                        const pc = replyParts[0];
                        let pcode_state = PCODE_STATE.STOPPED;
                        if (pc[1] == 'R') {
                            pcode_state = PCODE_STATE.RUNNING;
                        }
                        else if (pc[2] == 'B') {
                            pcode_state = PCODE_STATE.PAUSED;
                        }
                        device.pcode = pcode_state;
                        this.emit(TIBBO_PROXY_MESSAGE.DEVICE, {
                            ip: device.ip,
                            mac: device.mac,
                            tios: device.tios,
                            app: device.app,
                            pcode: device.pcode
                        });
                        stateString = messagePart;
                    }
                    break;
                case PCODE_COMMANDS.UPLOAD:
                    if (reply == REPLY_OK) {
                        const fileIndex = 0xff00 & msg[msg.length - 2] << 8 | 0x00ff & msg[msg.length - 1];
                        for (let i = 0; i < device.messageQueue.length; i++) {
                            if (device.messageQueue[i].command == PCODE_COMMANDS.UPLOAD) {
                                const data = Buffer.from(device.messageQueue[i].data, 'binary');
                                const tmpFileIndex = 0xff00 & data[0] << 8 | 0x00ff & data[1];
                                if (tmpFileIndex !== fileIndex) {
                                    continue;
                                }
                                for (let j = 0; j < this.pendingMessages.length; j++) {
                                    if (this.pendingMessages[j].nonce == device.messageQueue[i].nonce) {
                                        this.pendingMessages.splice(j, 1);
                                        j--;
                                    }
                                }
                                replyFor = device.messageQueue.splice(i, 1)[0];
                                i--;
                            }
                        }
                        if (replyFor === undefined) {
                            break;
                        }
                        const oldProgress = Math.round(device.fileIndex / device.fileBlocksTotal * 100);
                        device.fileIndex += device.blockSize;
                        const newProgress = Math.round(device.fileIndex / device.fileBlocksTotal * 100);
                        if (device.file != null && device.fileIndex * BLOCK_SIZE < device.file.length) {
                            this.sendBlock(mac, device.fileIndex);
                            if (oldProgress !== newProgress) {
                                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD, {
                                    'data': device.fileIndex / device.fileBlocksTotal,
                                    'mac': mac
                                });
                            }
                        }
                        else {
                            device.fileIndex = 0;
                            device.file = undefined;
                            device.fileBlocksTotal = 0;
                            this.sendToDevice(mac, PCODE_COMMANDS.APPUPLOADFINISH, '');
                            this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                                'nonce': identifier,
                                'mac': mac
                            });
                        }
                    }
                    else {
                        this.sendBlock(mac, device.fileIndex);
                    }
                    break;
                case PCODE_COMMANDS.RESET_PROGRAMMING:
                    if (reply == REPLY_OK) {
                        device.blockSize = 1;
                        if (device.file != null) {
                            this.sendBlock(mac, 0);
                        }
                    }
                    break;
                default:
                    break;
            }
            if (reply == NOTIFICATION_OK) {
                stateString = messagePart;
            }
            if (stateString != '') {
                const deviceState = stateString.substring(0, 3);
                this.emit(TIBBO_PROXY_MESSAGE.STATE, {
                    'mac': mac,
                    'data': messagePart
                });
                if (replyFor !== undefined || reply === NOTIFICATION_OK) {
                    switch (deviceState) {
                        case PCODEMachineState.DEBUG_PRINT_AND_CONTINUE:
                            this.handleDebugPrint(device, deviceState);
                            break;
                        case PCODEMachineState.DEBUG_PRINT_AND_STOP:
                            if (device.state != PCODEMachineState.DEBUG_PRINT_AND_STOP) {
                                this.handleDebugPrint(device, deviceState);
                            }
                            break;
                    }
                }
                device.state = deviceState;
            }
        }
    }
    handleDebugPrint(device, deviceState) {
        return __awaiter(this, void 0, void 0, function* () {
            if (device.printing) {
                return;
            }
            device.printing = true;
            const address = device.pdbStorageAddress;
            if (address != undefined && device.lastRunCommand != undefined) {
                const start = perf_hooks_1.performance.now();
                const val = yield this.getVariable(address, device.mac);
                const end = perf_hooks_1.performance.now();
                console.log(`getVariable ${val} took ${end - start}ms`);
                this.emit(TIBBO_PROXY_MESSAGE.DEBUG_PRINT, {
                    data: JSON.stringify({
                        data: val,
                        state: deviceState
                    }),
                    mac: device.mac
                });
                if (deviceState == PCODEMachineState.DEBUG_PRINT_AND_CONTINUE) {
                    if (device.lastRunCommand != undefined) {
                        this.sendToDevice(device.lastRunCommand.mac, device.lastRunCommand.command, device.lastRunCommand.data);
                    }
                }
                else {
                    this.sendToDevice(device.mac, PCODE_COMMANDS.STATE, '');
                }
            }
            device.printing = false;
        });
    }
    startApplicationUpload(mac, fileString) {
        let device = this.getDevice(mac);
        device.fileIndex = 0;
        const bytes = Buffer.from(fileString, 'binary');
        device.file = bytes;
        for (let i = 0; i < this.pendingMessages.length; i++) {
            for (let j = 0; j < device.messageQueue.length; j++) {
                if (this.pendingMessages[i].nonce == device.messageQueue[j].nonce) {
                    this.pendingMessages.splice(i);
                    i--;
                    break;
                }
            }
        }
        device.messageQueue = [];
        this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING, '');
    }
    sendBlock(mac, blockIndex) {
        const device = this.getDevice(mac);
        if (!device.file) {
            return;
        }
        const remainder = device.file.length % BLOCK_SIZE;
        if (remainder == 0) {
            device.fileBlocksTotal = device.file.length / BLOCK_SIZE;
        }
        else {
            device.fileBlocksTotal = (device.file.length - remainder) / BLOCK_SIZE + 1;
        }
        device.fileIndex = blockIndex;
        for (let i = 0; i < device.blockSize; i++) {
            let currentBlock = blockIndex + i;
            let fileBlock = device.file.slice((device.fileIndex + i) * BLOCK_SIZE, (device.fileIndex + i) * BLOCK_SIZE + BLOCK_SIZE);
            const buf = Buffer.from([(0xff00 & currentBlock) >> 8, (0x00ff & currentBlock)]);
            fileBlock = Buffer.concat([buf, fileBlock]);
            if (fileBlock.length < BLOCK_SIZE) {
                const filler = Buffer.alloc(BLOCK_SIZE - fileBlock.length);
                fileBlock = Buffer.concat([fileBlock, filler]);
            }
            this.sendToDevice(mac, PCODE_COMMANDS.UPLOAD, Buffer.concat([fileBlock]).toString('binary'), true);
        }
    }
    sendToDevice(mac, command, data, reply = true, nonce = undefined) {
        let pnum = nonce;
        try {
            if (pnum == undefined) {
                pnum = this.makeid(8);
            }
            const device = this.getDevice(mac);
            const parts = mac.split('.');
            for (let i = 0; i < parts.length; i++) {
                parts[i] = parts[i].padStart(3, '0');
            }
            mac = parts.join('.');
            const message = `_[${mac}]${command}${data}`;
            if (reply) {
                this.pendingMessages.push({
                    deviceInterface: device.deviceInterface,
                    message: message,
                    nonce: pnum,
                    tries: 0,
                    timestamp: new Date().getTime(),
                    timeout: RETRY_TIMEOUT,
                });
                device.messageQueue.push({
                    mac: mac,
                    command: command,
                    data: data,
                    nonce: pnum,
                    timestamp: new Date().getTime(),
                });
            }
            const newMessage = Buffer.concat([Buffer.from(`${message}|${pnum}`, 'binary')]);
            this.send(newMessage, device.deviceInterface, device.ip === '1.0.0.1' ? undefined : device.ip);
            if (this.timer == undefined) {
                this.timer = setInterval(this.checkMessageQueue.bind(this), 10);
            }
        }
        catch (ex) {
            logger.error(ex);
        }
    }
    checkMessageQueue() {
        const currentDate = new Date().getTime();
        for (let i = 0; i < this.pendingMessages.length; i++) {
            if (currentDate - this.pendingMessages[i].timestamp > this.pendingMessages[i].timeout) {
                if (this.pendingMessages[i].timeout < 512) {
                    this.pendingMessages[i].timeout *= 2;
                }
                if (this.pendingMessages[i].tries > 10) {
                    logger.info('discarding ' + this.pendingMessages[i].message);
                    this.pendingMessages.splice(i, 1);
                    i--;
                    continue;
                }
                this.pendingMessages[i].tries++;
                this.pendingMessages[i].timestamp = currentDate;
                const message = this.pendingMessages[i].message;
                const pnum = this.pendingMessages[i].nonce;
                const newMessage = Buffer.concat([Buffer.from(`${message}|${pnum}`, 'binary')]);
                logger.info('timeout ' + this.pendingMessages[i].message);
                this.send(newMessage, this.pendingMessages[i].deviceInterface);
            }
        }
    }
    makeid(length) {
        let result = '';
        const characters = '0123456789abcde';
        const charactersLength = characters.length;
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    }
    send(message, netInterface, targetIP) {
        logger.info(`${new Date().toLocaleTimeString()} sent: ${message}`);
        let targetInterface = this.currentInterface;
        if (netInterface != undefined) {
            targetInterface = netInterface;
        }
        if (targetInterface != undefined) {
            const broadcastAddress = this.getBroadcastAddress(targetInterface.netInterface.address, targetInterface.netInterface.netmask);
            if (targetIP === undefined) {
                targetIP = broadcastAddress;
            }
            targetInterface.socket.send(message, 0, message.length, PORT, targetIP, (err, bytes) => {
                if (err) {
                    logger.error('error sending ' + err.toString());
                }
            });
        }
        else {
            for (let i = 0; i < this.interfaces.length; i++) {
                try {
                    const tmp = this.interfaces[i];
                    const broadcastAddress = this.getBroadcastAddress(tmp.netInterface.address, tmp.netInterface.netmask);
                    if (targetIP === undefined) {
                        targetIP = broadcastAddress;
                    }
                    tmp.socket.send(message, 0, message.length, PORT, targetIP, (err, bytes) => {
                        if (err) {
                            logger.error('error sending ' + err.toString());
                        }
                    });
                }
                catch (ex) {
                }
            }
        }
    }
    getBroadcastAddress(address, netmask) {
        const addressBytes = address.split(".").map(Number);
        const netmaskBytes = netmask.split(".").map(Number);
        const subnetBytes = netmaskBytes.map((_, index) => addressBytes[index] & netmaskBytes[index]);
        const broadcastBytes = netmaskBytes.map((_, index) => subnetBytes[index] | (~netmaskBytes[index] + 256));
        return broadcastBytes.map(String).join(".");
    }
    getVariable(address, mac) {
        return __awaiter(this, void 0, void 0, function* () {
            const COMMAND_WAIT_TIME = 3000;
            const READ_BLOCK_SIZE = 16;
            const TRIES = 3;
            for (let t = 0; t < TRIES; t++) {
                try {
                    let outputString = '';
                    let tmpAddress = address.toString(16).padStart(4, '0');
                    this.memoryCalls[tmpAddress] = new Subject();
                    this.sendToDevice(mac, PCODE_COMMANDS.GET_MEMORY, tmpAddress + ',02', true);
                    yield this.memoryCalls[tmpAddress].wait(COMMAND_WAIT_TIME);
                    if (!this.memoryCalls[tmpAddress].message) {
                        throw new Error('timeout for getting string length');
                    }
                    const stringSize = parseInt(this.memoryCalls[tmpAddress].message[0], 16);
                    const startAddress = address + 2;
                    let blocks = Math.floor(stringSize / READ_BLOCK_SIZE);
                    if (stringSize % READ_BLOCK_SIZE != 0) {
                        blocks++;
                    }
                    const blockRequests = [...Array(blocks).keys()];
                    yield Promise.allSettled(blockRequests.map((block) => __awaiter(this, void 0, void 0, function* () {
                        let count = READ_BLOCK_SIZE;
                        const blockIndex = (block * READ_BLOCK_SIZE);
                        if (blockIndex + count > stringSize) {
                            count = stringSize - blockIndex;
                        }
                        const strAddress = (startAddress + block * READ_BLOCK_SIZE).toString(16).padStart(4, '0');
                        this.memoryCalls[strAddress] = new Subject();
                        console.log(`started getting block ${block}`);
                        this.sendToDevice(mac, PCODE_COMMANDS.GET_MEMORY, strAddress + ',' + count.toString(16).padStart(2, '0'), true);
                        yield this.memoryCalls[strAddress].wait(COMMAND_WAIT_TIME);
                        console.log(`finished getting block ${block}`);
                    })));
                    for (let i = 0; i < blocks; i++) {
                        const block = i;
                        let count = READ_BLOCK_SIZE;
                        const blockIndex = (block * READ_BLOCK_SIZE);
                        if (blockIndex + count > stringSize) {
                            count = stringSize - blockIndex;
                        }
                        const strAddress = (startAddress + block * READ_BLOCK_SIZE).toString(16).padStart(4, '0');
                        if (!this.memoryCalls[strAddress].message) {
                            throw new Error('timeout for getting string value at ' + blockIndex);
                        }
                        for (let i = 0; i < this.memoryCalls[strAddress].message.length; i++) {
                            const charCode = parseInt(this.memoryCalls[strAddress].message[i], 16);
                            outputString += String.fromCharCode(charCode);
                        }
                        delete this.memoryCalls[strAddress];
                    }
                    return outputString;
                }
                catch (ex) {
                    logger.error(ex);
                    console.log(ex);
                }
            }
            return '';
        });
    }
    getDevice(mac) {
        const parts = mac.split('.');
        for (let i = 0; i < parts.length; i++) {
            parts[i] = Number(parts[i]).toString();
        }
        mac = parts.join('.');
        for (let i = 0; i < this.devices.length; i++) {
            if (this.devices[i].mac == mac) {
                return this.devices[i];
            }
        }
        const device = {
            ip: '',
            mac: mac,
            messageQueue: [],
            tios: '',
            app: '',
            fileIndex: 0,
            fileBlocksTotal: 0,
            pcode: -1,
            blockSize: 1,
            state: PCODEMachineState.STOPPED,
        };
        this.devices.push(device);
        return device;
    }
    emit(channel, content) {
        if (this.socket !== undefined) {
            this.socket.emit(channel, content);
        }
        this.server.emit(channel, content);
    }
    close() {
        return __awaiter(this, void 0, void 0, function* () {
            this.socket.close();
            this.socket.removeAllListeners();
        });
    }
}
exports.TIDEProxy = TIDEProxy;
var PCODEMachineState;
(function (PCODEMachineState) {
    PCODEMachineState["STOPPED"] = "***";
    PCODEMachineState["RUN"] = "*R*";
    PCODEMachineState["PAUSED"] = "**B";
    PCODEMachineState["DEBUG_PRINT_AND_STOP"] = "**P";
    PCODEMachineState["DEBUG_PRINT_AND_CONTINUE"] = "*P*";
})(PCODEMachineState = exports.PCODEMachineState || (exports.PCODEMachineState = {}));
var PCODE_STATE;
(function (PCODE_STATE) {
    PCODE_STATE[PCODE_STATE["STOPPED"] = 0] = "STOPPED";
    PCODE_STATE[PCODE_STATE["PAUSED"] = 1] = "PAUSED";
    PCODE_STATE[PCODE_STATE["RUNNING"] = 2] = "RUNNING";
})(PCODE_STATE = exports.PCODE_STATE || (exports.PCODE_STATE = {}));
var PCODE_COMMANDS;
(function (PCODE_COMMANDS) {
    PCODE_COMMANDS["STATE"] = "PC";
    PCODE_COMMANDS["RUN"] = "PR";
    PCODE_COMMANDS["PAUSE"] = "PB";
    PCODE_COMMANDS["BREAKPOINT"] = "CB";
    PCODE_COMMANDS["GET_MEMORY"] = "GM";
    PCODE_COMMANDS["GET_PROPERTY"] = "GP";
    PCODE_COMMANDS["SET_PROPERTY"] = "SR";
    PCODE_COMMANDS["SET_MEMORY"] = "SM";
    PCODE_COMMANDS["STEP"] = "PO";
    PCODE_COMMANDS["SET_POINTER"] = "SP";
    PCODE_COMMANDS["DISCOVER"] = "_?";
    PCODE_COMMANDS["INFO"] = "X";
    PCODE_COMMANDS["RESET_PROGRAMMING"] = "Q";
    PCODE_COMMANDS["UPLOAD"] = "D";
    PCODE_COMMANDS["APPUPLOADFINISH"] = "T";
    PCODE_COMMANDS["BUZZ"] = "B";
    PCODE_COMMANDS["REBOOT"] = "E";
})(PCODE_COMMANDS = exports.PCODE_COMMANDS || (exports.PCODE_COMMANDS = {}));
var TIBBO_PROXY_MESSAGE;
(function (TIBBO_PROXY_MESSAGE) {
    TIBBO_PROXY_MESSAGE["REFRESH"] = "refresh";
    TIBBO_PROXY_MESSAGE["DEVICE"] = "device";
    TIBBO_PROXY_MESSAGE["BUZZ"] = "buzz";
    TIBBO_PROXY_MESSAGE["REBOOT"] = "reboot";
    TIBBO_PROXY_MESSAGE["UPLOAD"] = "upload";
    TIBBO_PROXY_MESSAGE["REGISTER"] = "register";
    TIBBO_PROXY_MESSAGE["APPLICATION_UPLOAD"] = "application";
    TIBBO_PROXY_MESSAGE["UPLOAD_COMPLETE"] = "upload_complete";
    TIBBO_PROXY_MESSAGE["STATE"] = "state";
    TIBBO_PROXY_MESSAGE["COMMAND"] = "command";
    TIBBO_PROXY_MESSAGE["REPLY"] = "reply";
    TIBBO_PROXY_MESSAGE["SET_PDB_STORAGE_ADDRESS"] = "set_pdb_storage_address";
    TIBBO_PROXY_MESSAGE["DEBUG_PRINT"] = "debug_print";
})(TIBBO_PROXY_MESSAGE = exports.TIBBO_PROXY_MESSAGE || (exports.TIBBO_PROXY_MESSAGE = {}));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGlkZS1wcm94eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy90aWRlLXByb3h5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7OztBQUFBLCtCQUErQjtBQUMvQiwyQ0FBeUM7QUFFekMsdURBQXdEO0FBQ3hELE1BQU0sT0FBTyxHQUFHLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUNuQyxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDM0IsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7QUFDeEQsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3pCLE1BQU0sTUFBTSxHQUFHLEVBQUUsQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO0FBQ3RDLE1BQU0sRUFBRSxPQUFPLEVBQUUsR0FBRyxPQUFPLENBQUMsY0FBYyxDQUFDLENBQUM7QUFFNUMsTUFBTSxhQUFhLEdBQUcsRUFBRSxDQUFDO0FBQ3pCLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQztBQUduQixNQUFNLFFBQVEsR0FBRyxHQUFHLENBQUM7QUFDckIsTUFBTSxlQUFlLEdBQUcsR0FBRyxDQUFDO0FBQzVCLE1BQU0sY0FBYyxHQUFHLEdBQUcsQ0FBQztBQUUzQixNQUFNLFVBQVUsR0FBRyxHQUFHLENBQUM7QUFnQnZCLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxZQUFZLENBQUM7SUFDaEMsS0FBSyxFQUFFLE1BQU07SUFDYixNQUFNLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxNQUFNLEVBQUU7SUFDL0IsVUFBVSxFQUFFLEVBS1g7Q0FDSixDQUFDLENBQUM7QUFFSCxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxJQUFJLFlBQVksRUFBRTtJQUN0QyxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksT0FBTyxD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
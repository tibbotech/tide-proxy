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
const axios_1 = require("axios");
const winston = require('winston');
const url = require('url');
const io = require("socket.io")({ serveClient: false, cors: { origin: "*" }, maxHttpBufferSize: 1e10 });
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
    name: 'console.info',
    level: 'info',
    format: winston.format.simple(),
    transports: [
        new winston.transports.Console({
            silent: process.env.TIDE_PROXY_VERBOSE ? false : true,
        }),
    ]
});
class TIDEProxy {
    constructor(serverAddress = '', proxyName, port = 3535, targetInterface) {
        this.devices = [];
        this.pendingMessages = [];
        this.interfaces = [];
        this.currentInterface = undefined;
        this.memoryCalls = {};
        this.discoveredDevices = {};
        this.id = new Date().getTime().toString();
        this.listenPort = port;
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
                        logger.error(`udp server error:\n${err.stack}`);
                        socket.close();
                    });
                    socket.on('message', (msg, info) => {
                        this.handleMessage(msg, info, int);
                    });
                    socket.on('listening', () => {
                        logger.info('listening on ' + tmp.address);
                    });
                    socket.bind({
                        address: tmp.address
                    }, () => {
                        logger.info('socket bound for ' + tmp.address);
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
            logger.info('client connected on socket');
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
            conClient.on(TIBBO_PROXY_MESSAGE.HTTP, (message) => {
                this.handleHTTPProxy(message);
            });
            conClient.on(TIBBO_PROXY_MESSAGE.SET_PDB_STORAGE_ADDRESS, this.setPDBAddress.bind(this));
            conClient.on('close', () => {
                logger.info('socket closed');
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
        this.socket.on(TIBBO_PROXY_MESSAGE.HTTP, (message) => {
            this.handleHTTPProxy(message);
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
                        device.appVersion = parts[1];
                        this.sendToDevice(mac, PCODE_COMMANDS.STATE, '');
                    }
                    break;
                case PCODE_COMMANDS.PAUSE:
                    device.lastRunCommand = undefined;
                    device.fileIndex = 0;
                    device.file = undefined;
                    device.messageQueue = [];
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
                            pcode: device.pcode,
                            appVersion: device.appVersion,
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
                            return;
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
                logger.info(`getVariable ${val} took ${end - start}ms`);
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
        if (!mac) {
            return;
        }
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
            const broadcastAddress = '255.255.255.255';
            targetInterface.socket.send(message, 0, message.length, PORT, broadcastAddress, (err, bytes) => {
                if (err) {
                    logger.error('error sending ' + err.toString());
                }
            });
        }
        else {
            for (let i = 0; i < this.interfaces.length; i++) {
                try {
                    const tmp = this.interfaces[i];
                    const broadcastAddress = '255.255.255.255';
                    tmp.socket.send(message, 0, message.length, PORT, broadcastAddress, (err, bytes) => {
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
                        logger.info(`started getting block ${block}`);
                        this.sendToDevice(mac, PCODE_COMMANDS.GET_MEMORY, strAddress + ',' + count.toString(16).padStart(2, '0'), true);
                        yield this.memoryCalls[strAddress].wait(COMMAND_WAIT_TIME);
                        logger.info(`finished getting block ${block}`);
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
                    logger.error(ex);
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
            appVersion: '',
            fileIndex: 0,
            fileBlocksTotal: 0,
            pcode: -1,
            blockSize: 1,
            state: PCODEMachineState.STOPPED,
        };
        this.devices.push(device);
        return device;
    }
    handleHTTPProxy(message) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const response = yield axios_1.default({
                    method: message.method,
                    url: message.url,
                    headers: message.headers,
                    data: message.data
                });
                this.emit(TIBBO_PROXY_MESSAGE.HTTP_RESPONSE, {
                    nonce: message.nonce,
                    status: response.status,
                    url: message.url,
                    data: response.data
                });
            }
            catch (error) {
                if (error.response) {
                    this.emit(TIBBO_PROXY_MESSAGE.HTTP_RESPONSE, {
                        nonce: message.nonce,
                        status: error.response.status,
                        url: message.url,
                        data: error.response.data
                    });
                }
                else {
                    logger.error(error);
                }
            }
        });
    }
    emit(channel, content) {
        if (this.socket !== undefined) {
            this.socket.emit(channel, content);
        }
        this.server.emit(channel, content);
    }
    close() {
        if (this.socket) {
            this.socket.close();
            this.socket.removeAllListeners();
        }
    }
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            this.close();
            yield new Promise((resolve) => {
                io.removeAllListeners();
                this.server.removeAllListeners();
                io.close(() => {
                    resolve();
                });
            });
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
    PCODE_COMMANDS["REBOOT"] = "EC";
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
    TIBBO_PROXY_MESSAGE["HTTP"] = "http";
    TIBBO_PROXY_MESSAGE["HTTP_RESPONSE"] = "http_response";
})(TIBBO_PROXY_MESSAGE = exports.TIBBO_PROXY_MESSAGE || (exports.TIBBO_PROXY_MESSAGE = {}));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGlkZS1wcm94eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy90aWRlLXByb3h5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7OztBQUFBLCtCQUErQjtBQUMvQiwyQ0FBeUM7QUFFekMsdURBQXdEO0FBQ3hELGlDQUEwQjtBQUMxQixNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDbkMsTUFBTSxHQUFHLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQzNCLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FBQyxXQUFXLENBQUMsQ0FBQyxFQUFFLFdBQVcsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxFQUFFLGlCQUFpQixFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7QUFDeEcsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3pCLE1BQU0sTUFBTSxHQUFHLEVBQUUsQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO0FBQ3RDLE1BQU0sRUFBRSxPQUFPLEVBQUUsR0FBRyxPQUFPLENBQUMsY0FBYyxDQUFDLENBQUM7QUFFNUMsTUFBTSxhQUFhLEdBQUcsRUFBRSxDQUFDO0FBQ3pCLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQztBQUduQixNQUFNLFFBQVEsR0FBRyxHQUFHLENBQUM7QUFDckIsTUFBTSxlQUFlLEdBQUcsR0FBRyxDQUFDO0FBQzVCLE1BQU0sY0FBYyxHQUFHLEdBQUcsQ0FBQztBQUUzQixNQUFNLFVBQVUsR0FBRyxHQUFHLENBQUM7QUFnQnZCLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxZQUFZLENBQUM7SUFDaEMsSUFBSSxFQUFFLGNBQWM7SUFDcEIsS0FBSyxFQUFFLE1BQU07SUFDYixNQUFNLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxNQUFNLEVBQUU7SUFDL0IsVUFBVSxFQUFFO1FBQ1IsSUFBSSxP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
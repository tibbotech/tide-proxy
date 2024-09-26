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
const serialport_1 = require("serialport");
const MicropythonSerial = require("./serial");
const SerialPort_1 = require("./SerialPort");
const socket_io_client_1 = require("socket.io-client");
const axios_1 = require("axios");
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const url = require('url');
const io = require("socket.io")({ serveClient: false, cors: { origin: "*" }, maxHttpBufferSize: 1e10 });
const os = require('os');
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
        const ifaces = os.networkInterfaces();
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
                this.startApplicationUpload(message.mac, message.data, message.deviceDefinition, message.method, message.files, message.baudRate);
            });
            conClient.on(TIBBO_PROXY_MESSAGE.COMMAND, (message) => {
                this.sendToDevice(message.mac, message.command, message.data, true, message.nonce);
            });
            conClient.on(TIBBO_PROXY_MESSAGE.HTTP, (message) => {
                this.handleHTTPProxy(message);
            });
            conClient.on(TIBBO_PROXY_MESSAGE.SET_PDB_STORAGE_ADDRESS, this.setPDBAddress.bind(this));
            conClient.on(TIBBO_PROXY_MESSAGE.ATTACH_SERIAL, (port, baudRate, reset) => {
                this.attachSerial(port, baudRate, reset);
            });
            conClient.on(TIBBO_PROXY_MESSAGE.DETACH_SERIAL, (port) => {
                this.detachSerial(port);
            });
            conClient.on('close', () => {
                logger.info('socket closed');
                this.clients.splice(this.clients.indexOf(this.clients), 1);
            });
        });
        io.listen(port);
    }
    setInterface(targetInterface) {
        this.currentInterface = undefined;
        const ifaces = os.networkInterfaces();
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
        this.getSerialPorts();
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
            return;
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
                    const start = tmpReply.data.indexOf(':') - 4;
                    const address = tmpReply.data.substring(start, start + 4).toLowerCase();
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
                        device.type = 'tios';
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
                    if (replyForCommand == PCODE_COMMANDS.RUN
                        || replyForCommand == PCODE_COMMANDS.STEP) {
                        device.lastRunCommand = replyFor;
                    }
                    break;
                case PCODE_COMMANDS.STATE:
                    {
                        if (replyFor !== undefined) {
                            device.lastPoll = new Date().getTime();
                        }
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
                            type: device.type,
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
                            this.emit(TIBBO_PROXY_MESSAGE.UPLOAD, {
                                'data': 1,
                                'mac': mac
                            });
                            logger.info(`finished upload to ${mac}`);
                            this.sendToDevice(mac, PCODE_COMMANDS.APPUPLOADFINISH, '');
                        }
                    }
                    else {
                        this.sendBlock(mac, device.fileIndex);
                    }
                    break;
                case PCODE_COMMANDS.APPUPLOADFINISH:
                    let count = 0;
                    logger.info(`${mac}, resetting...`);
                    const deviceStatusTimer = setInterval(() => {
                        var _a;
                        this.sendToDevice(mac, PCODE_COMMANDS.INFO, '');
                        const device = this.getDevice(mac);
                        if (device.appVersion != '' && device.file) {
                            if (((_a = device.file) === null || _a === void 0 ? void 0 : _a.toString('binary').indexOf(device.appVersion)) >= 0) {
                                device.fileIndex = 0;
                                device.file = undefined;
                                device.fileBlocksTotal = 0;
                                clearInterval(deviceStatusTimer);
                                logger.info(`${mac}, upload complete`);
                                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                                    'nonce': identifier,
                                    'mac': mac
                                });
                                return;
                            }
                        }
                        count++;
                        if (count > 10) {
                            clearInterval(deviceStatusTimer);
                            if (device.file) {
                                console.log('retrying upload');
                                this.startApplicationUpload(mac, device.file.toString('binary'));
                            }
                        }
                    }, 1000);
                    break;
                case PCODE_COMMANDS.RESET_PROGRAMMING:
                    logger.info(`response ${mac} for reset_programming ${reply}`);
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
                            this.handleDebugPrint(device, stateString);
                            break;
                        case PCODEMachineState.DEBUG_PRINT_AND_STOP:
                            if (device.state != PCODEMachineState.DEBUG_PRINT_AND_STOP) {
                                this.handleDebugPrint(device, stateString);
                            }
                            break;
                    }
                }
                device.state = deviceState;
            }
        }
    }
    handleDebugPrint(device, state) {
        return __awaiter(this, void 0, void 0, function* () {
            if (device.printing) {
                return;
            }
            const currentTimestamp = new Date().getTime();
            if (device.lastPoll === undefined || currentTimestamp - device.lastPoll > 5000) {
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
                        state
                    }),
                    mac: device.mac
                });
                const deviceState = state.substring(0, 3);
                if (deviceState == PCODEMachineState.DEBUG_PRINT_AND_CONTINUE) {
                    if (device.lastRunCommand != undefined) {
                        if (device.lastRunCommand.command == PCODE_COMMANDS.RUN) {
                            device.lastRunCommand.data = '+' + device.breakpoints;
                        }
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
    startApplicationUpload(mac, fileString, deviceDefinition, method, files, baudRate = 115200) {
        if (!mac && !deviceDefinition) {
            return;
        }
        if (method === 'micropython' && files) {
            this.startUploadMicropython(mac, files, baudRate);
            return;
        }
        const bytes = Buffer.from(fileString, 'binary');
        if (deviceDefinition) {
            if (deviceDefinition.uploadMethods.find((method) => method.name === 'jlink')) {
                const jlinkMethod = deviceDefinition.uploadMethods.find((method) => method.name === 'jlink');
                let jlinkDevice = '';
                let speed = '';
                let flashAddress = deviceDefinition.flashAddress || '0x0';
                const fileBase = this.makeid(8);
                let scriptPath = '';
                let filePath = '';
                try {
                    for (let i = 0; i < jlinkMethod.options.length; i++) {
                        let option = jlinkMethod.options[i];
                        if (option.indexOf('"') === 0) {
                            option = option.substring(1, option.length - 1);
                        }
                        if (option.indexOf('--device=') === 0) {
                            jlinkDevice = option.split('=')[1];
                        }
                        if (option.indexOf('--speed=') === 0) {
                            speed = option.split('=')[1];
                        }
                    }
                    let fileName = `${fileBase}.bin`;
                    filePath = path.join(__dirname, fileName);
                    scriptPath = path.join(__dirname, `${fileBase}.jlink`);
                    fs.writeFileSync(filePath, bytes);
                    fs.writeFileSync(scriptPath, `loadbin ${filePath} ${flashAddress}\nexit`);
                    const cleanup = () => {
                        if (scriptPath && fs.existsSync(scriptPath)) {
                            fs.unlinkSync(scriptPath);
                        }
                        if (filePath && fs.existsSync(filePath)) {
                            fs.unlinkSync(filePath);
                        }
                    };
                    const ccmd = `JLinkExe -device ${jlinkDevice} -if SWD -speed ${speed} -autoconnect 1 -CommanderScript ${scriptPath}`;
                    const exec = cp.spawn(ccmd, [], { env: Object.assign(Object.assign({}, process.env), { NODE_OPTIONS: '' }), timeout: 60000, shell: true });
                    if (!exec.pid) {
                        return;
                    }
                    exec.on('error', () => {
                        cleanup();
                        this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                            mac: jlinkDevice,
                        });
                    });
                    exec.on('exit', () => {
                        cleanup();
                        this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                            mac: jlinkDevice,
                        });
                    });
                }
                catch (ex) {
                }
            }
        }
        else {
            logger.info('starting application upload for ' + mac);
            let device = this.getDevice(mac);
            device.fileIndex = 0;
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
    }
    startUploadMicropython(mac, files, baudRate) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.detachSerial(mac);
                const attach = yield this.attachSerial(mac, baudRate);
                if (!attach) {
                    this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                        'error': true,
                        'nonce': '',
                        'mac': mac
                    });
                    return;
                }
                yield MicropythonSerial.enterRawMode(true);
                for (let i = 0; i < files.length; i++) {
                    this.emit(TIBBO_PROXY_MESSAGE.UPLOAD, {
                        'data': i / files.length,
                        'mac': mac
                    });
                    yield MicropythonSerial.writeFileToDevice(files[i]);
                }
                yield MicropythonSerial.exitRawMode();
                yield this.detachSerial(mac);
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    'error': false,
                    'nonce': '',
                    'mac': mac
                });
            }
            catch (ex) {
                logger.error(ex);
            }
        });
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
            if (command === PCODE_COMMANDS.BREAKPOINT || command === PCODE_COMMANDS.RUN) {
                device.breakpoints = data;
                if (command === PCODE_COMMANDS.RUN && data.indexOf('+') === 0) {
                    device.breakpoints = data.substring(1);
                }
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
            type: 'tios',
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
                const response = yield axios_1.default(message.url, {
                    method: message.method,
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
    getDevices() {
        return this.devices;
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
    getSerialPorts() {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            const ports = yield serialport_1.SerialPort.list();
            for (let i = 0; i < ports.length; i++) {
                const { path, manufacturer, serialNumber, pnpId, locationId, productId, vendorId, } = ports[i];
                const device = {
                    ip: '',
                    mac: path,
                    messageQueue: [],
                    tios: '',
                    app: '',
                    appVersion: '',
                    fileIndex: 0,
                    fileBlocksTotal: 0,
                    type: 'serial',
                    pcode: -1,
                    blockSize: 1,
                    state: PCODEMachineState.STOPPED,
                    serial_attached: false,
                };
                if (((_a = SerialPort_1.default.port) === null || _a === void 0 ? void 0 : _a.path) === path
                    && SerialPort_1.default.port.isOpen) {
                    device.serial_attached = true;
                }
                this.emit(TIBBO_PROXY_MESSAGE.DEVICE, {
                    ip: device.ip,
                    mac: device.mac,
                    tios: device.tios,
                    app: device.app,
                    pcode: device.pcode,
                    appVersion: device.appVersion,
                    type: device.type,
                });
                this.devices.push(device);
            }
        });
    }
    attachSerial(port, baudRate = 115200, reset = false) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                for (let i = 0; i < this.devices.length; i++) {
                    if (this.devices[i].mac == port) {
                        yield SerialPort_1.default.connect(port, baudRate, reset);
                        this.devices[i].serial_attached = true;
                        return true;
                    }
                }
                return false;
            }
            catch (ex) {
                logger.error('error attaching serial');
            }
        });
    }
    detachSerial(port) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                for (let i = 0; i < this.devices.length; i++) {
                    if (this.devices[i].mac == port ||
                        (this.devices[i].serial_attached && port === '')) {
                        yield SerialPort_1.default.disconnect(this.devices[i].mac);
                        this.devices[i].serial_attached = false;
                    }
                }
            }
            catch (ex) {
                logger.error('error detaching serial');
            }
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
    TIBBO_PROXY_MESSAGE["ATTACH_SERIAL"] = "attach_serial";
    TIBBO_PROXY_MESSAGE["DETACH_SERIAL"] = "detach_serial";
})(TIBBO_PROXY_MESSAGE = exports.TIBBO_PROXY_MESSAGE || (exports.TIBBO_PROXY_MESSAGE = {}));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGlkZS1wcm94eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy90aWRlLXByb3h5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7OztBQUFBLCtCQUErQjtBQUMvQiwyQ0FBeUM7QUFDekMsMkNBQXVDO0FBQ3ZDLDhDQUE4QztBQUM5Qyw2Q0FBd0M7QUFHeEMsdURBQXdEO0FBQ3hELGlDQUFzQztBQUN0QyxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsZUFBZSxDQUFDLENBQUM7QUFDcEMsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3pCLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUM3QixNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDbkMsTUFBTSxHQUFHLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQzNCLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FBQyxXQUFXLENBQUMsQ0FBQyxFQUFFLFdBQVcsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxFQUFFLGlCQUFpQixFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7QUFDeEcsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3pCLE1BQU0sRUFBRSxPQUFPLEVBQUUsR0FBRyxPQUFPLENBQUMsY0FBYyxDQUFDLENBQUM7QUFFNUMsTUFBTSxhQUFhLEdBQUcsRUFBRSxDQUFDO0FBQ3pCLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQztBQUduQixNQUFNLFFBQVEsR0FBRyxHQUFHLENBQUM7QUFDckIsTUFBTSxlQUFlLEdBQUcsR0FBRyxDQUFDO0FBQzVCLE1BQU0sY0FBYyxHQUFHLEdBQUcsQ0FBQztBQUUzQixNQUFNLFVBQVUsR0FBRyxHQUFHLENBQUM7QUFnQnZCLE1BQU0sTUFBTSxHQUFHLE9BQU8s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
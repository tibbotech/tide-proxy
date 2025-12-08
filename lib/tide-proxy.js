"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIBBO_PROXY_MESSAGE = exports.PCODE_COMMANDS = exports.PCODE_STATE = exports.PCODEMachineState = exports.TIDEProxy = void 0;
const dgram = __importStar(require("dgram"));
const perf_hooks_1 = require("perf_hooks");
const serialport_1 = require("serialport");
const MicropythonSerial_1 = require("./MicropythonSerial");
const node_1 = require("./ESP32Serial/node");
const NodeSerialPort_1 = __importDefault(require("./NodeSerialPort"));
const socket_io_client_1 = require("socket.io-client");
const axios_1 = __importDefault(require("axios"));
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const url = require('url');
const io = require("socket.io")({ serveClient: false, cors: { origin: "*" }, maxHttpBufferSize: 1e10 });
const os = require('os');
const http = require('http');
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
const PROJECT_OUTPUT_FOLDER = path.join(__dirname, 'project_output');
class TIDEProxy {
    constructor(serverAddress = '', proxyName, port = 3535, targetInterface) {
        this.devices = [];
        this.pendingMessages = [];
        this.interfaces = [];
        this.currentInterface = undefined;
        this.memoryCalls = {};
        this.discoveredDevices = {};
        this.serialDevices = {};
        this.adks = [];
        this.id = new Date().getTime().toString();
        this.listenPort = port;
        this.initInterfaces(targetInterface);
        if (serverAddress != '') {
            this.setServer(serverAddress, proxyName);
        }
        this.server = io.of('/tide');
        this.clients = [];
        this.server.on('connection', (conClient) => {
            this.clients.push(conClient);
            logger.info('client connected on socket');
            this.registerListeners(conClient);
            conClient.on('close', () => {
                logger.info('socket closed');
                this.clients.splice(this.clients.indexOf(this.clients), 1);
            });
        });
        io.listen(port);
    }
    initInterfaces(targetInterface = '') {
        const ifaces = os.networkInterfaces();
        this.clearPendingOperations();
        const oldInterfaces = [...this.interfaces];
        this.interfaces = [];
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
        socket.on('close', () => {
            logger.info('Socket closed for ');
        });
        socket.on('error', (err) => {
            logger.error(`UDP server error on `);
            socket.close();
        });
        socket.on('message', (msg, info) => {
            this.handleMessage(msg, info);
        });
        socket.on('listening', () => {
            logger.info('Listening on ');
        });
        socket.bind({}, () => {
            logger.info('Socket bound for ');
            socket.setBroadcast(true);
        });
        for (const key in ifaces) {
            const iface = ifaces[key];
            for (let i = 0; i < iface.length; i++) {
                const tmp = iface[i];
                if (tmp.family == 'IPv4' && !tmp.internal) {
                    try {
                        const int = {
                            socket: socket,
                            netInterface: tmp
                        };
                        this.interfaces.push(int);
                        if (targetInterface && key == targetInterface) {
                            this.currentInterface = int;
                        }
                    }
                    catch (err) {
                        logger.error(`Failed to create interface for ${tmp.address}:`, err.message);
                    }
                }
            }
        }
        this.cleanupOldInterfaces(oldInterfaces);
    }
    clearPendingOperations() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.pendingMessages = [];
    }
    cleanupOldInterfaces(oldInterfaces) {
        setTimeout(() => {
            oldInterfaces.forEach((oldInterface, index) => {
                try {
                    if (oldInterface.socket) {
                        oldInterface.socket.removeAllListeners();
                        oldInterface.socket.close();
                    }
                }
                catch (err) {
                    logger.error(`Error closing old socket ${index}:`, err.message);
                }
            });
        }, 100);
    }
    setInterface(targetInterface) {
        this.devices = [];
        this.discoveredDevices = {};
        if (!targetInterface) {
            this.currentInterface = undefined;
            return;
        }
        this.initInterfaces(targetInterface);
    }
    registerListeners(socket) {
        socket.on('disconnect', () => {
            logger.error('disconnected');
        });
        socket.on('connect_error', (error) => {
            logger.error('connection error' + error);
        });
        socket.on(TIBBO_PROXY_MESSAGE.REFRESH, (message) => {
            this.handleRefresh();
        });
        socket.on(TIBBO_PROXY_MESSAGE.BUZZ, (message) => {
            this.sendToDevice(message.mac, PCODE_COMMANDS.BUZZ, '');
        });
        socket.on(TIBBO_PROXY_MESSAGE.REBOOT, (message) => {
            this.stopApplicationUpload(message.mac);
            this.sendToDevice(message.mac, PCODE_COMMANDS.REBOOT, '', false);
        });
        socket.on(TIBBO_PROXY_MESSAGE.APPLICATION_UPLOAD, (message) => {
            this.startApplicationUpload(message.mac, message.data, message.deviceDefinition, message.method, message.files, message.baudRate);
        });
        socket.on(TIBBO_PROXY_MESSAGE.COMMAND, (message) => {
            this.sendToDevice(message.mac, message.command, message.data, true, message.nonce);
        });
        socket.on(TIBBO_PROXY_MESSAGE.HTTP, (message) => {
            this.handleHTTPProxy(message);
        });
        socket.on(TIBBO_PROXY_MESSAGE.SET_PDB_STORAGE_ADDRESS, this.setPDBAddress.bind(this));
        socket.on(TIBBO_PROXY_MESSAGE.ATTACH_SERIAL, (message) => {
            const { port, baudRate, reset } = message;
            this.attachSerial(port, baudRate, reset);
        });
        socket.on(TIBBO_PROXY_MESSAGE.DETACH_SERIAL, (message) => {
            const { port } = message;
            this.detachSerial(port);
        });
        socket.on(TIBBO_PROXY_MESSAGE.GPIO_SET, (message) => __awaiter(this, void 0, void 0, function* () {
            const { address, pin, value } = message;
            const adk = this.adks.find((adk) => adk.address === address);
            if (adk) {
                try {
                    console.log(`sending to ${adk.ip} pin ${pin} value ${value}`);
                    const postData = JSON.stringify({
                        tibboIoPin_post: pin,
                        value_post: value,
                    });
                    const re = http.request({
                        hostname: adk.ip,
                        port: 18080,
                        path: '/gpio',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': postData.length
                        }
                    });
                    re.write(postData);
                    re.end();
                }
                catch (ex) {
                    console.log(ex);
                }
            }
        }));
        socket.on(TIBBO_PROXY_MESSAGE.WIEGAND_SEND, (message) => __awaiter(this, void 0, void 0, function* () {
            const { address, value } = message;
            const adk = this.adks.find((adk) => adk.address === address);
            if (adk) {
                try {
                    console.log(`sending to ${adk.ip} card value ${value}`);
                    const postData = JSON.stringify({
                        wiegandData_post: value,
                    });
                    const re = http.request({
                        hostname: adk.ip,
                        port: 18080,
                        path: '/wiegand',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': postData.length
                        }
                    });
                    re.write(postData);
                    re.end();
                }
                catch (ex) {
                    console.log(ex);
                }
            }
        }));
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
        this.registerListeners(this.socket);
    }
    setADKS(adks) {
        this.adks = adks;
    }
    handleRefresh() {
        const msg = Buffer.from(PCODE_COMMANDS.DISCOVER);
        this.discoveredDevices = {};
        this.send(msg);
        this.getSerialPorts();
    }
    setPDBAddress(message) {
        if (message.mac) {
            const device = this.getDevice(message.mac);
            device.pdbStorageAddress = Number(message.data);
        }
    }
    handleMessage(msg, info) {
        var _a;
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
            const adk = this.adks.find((adk) => adk.address === mac);
            if (adk) {
                device.streamURL = adk.streamURL;
            }
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
                if (!identifier && device.fileBlocksTotal > 0 && device.file) {
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
                    this.stopApplicationUpload(mac);
                    this.clearDeviceMessageQueue(mac);
                    break;
                case PCODE_COMMANDS.RUN:
                case PCODE_COMMANDS.STEP:
                case PCODE_COMMANDS.SET_POINTER:
                    stateString = messagePart;
                    if (replyForCommand == PCODE_COMMANDS.RUN
                        || replyForCommand == PCODE_COMMANDS.STEP) {
                        device.lastRunCommand = replyFor;
                        if (device.file) {
                            this.stopApplicationUpload(mac);
                        }
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
                            streamURL: device.streamURL,
                        });
                        stateString = messagePart;
                    }
                    break;
                case PCODE_COMMANDS.UPLOAD:
                    {
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
                        if (reply !== REPLY_OK) {
                            console.log(`upload block ${device.fileIndex} failed for ${mac}`);
                            this.clearDeviceMessageQueue(mac);
                            this.sendBlock(mac, device.fileIndex);
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
                            this.clearDeviceMessageQueue(mac);
                            if (((_a = device.file) === null || _a === void 0 ? void 0 : _a.toString('binary').indexOf('TBIN')) == 0) {
                                this.sendToDevice(mac, PCODE_COMMANDS.APPUPLOADFINISH, '', true);
                            }
                            else {
                                this.sendToDevice(mac, 'N', '', true);
                                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                                    'nonce': identifier,
                                    'mac': mac
                                });
                            }
                        }
                    }
                    break;
                case 'N':
                    this.sendToDevice(mac, PCODE_COMMANDS.REBOOT, '', false);
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
                                this.stopApplicationUpload(mac);
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
                                console.log(`retrying upload for ${mac}`);
                                this.clearDeviceMessageQueue(mac);
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
    removeDeviceMessage(mac, nonce) {
        const device = this.getDevice(mac);
        for (let i = 0; i < device.messageQueue.length; i++) {
            if (device.messageQueue[i].nonce == nonce) {
                device.messageQueue.splice(i, 1);
                for (let j = 0; j < this.pendingMessages.length; j++) {
                    if (this.pendingMessages[j].nonce == nonce) {
                        this.pendingMessages.splice(j, 1);
                        j--;
                    }
                }
                break;
            }
        }
    }
    clearDeviceMessageQueue(mac) {
        const device = this.getDevice(mac);
        for (let i = 0; i < device.messageQueue.length; i++) {
            const nonce = device.messageQueue[i].nonce;
            if (nonce) {
                this.removeDeviceMessage(mac, nonce);
            }
        }
        device.messageQueue = [];
    }
    stopApplicationUpload(address) {
        const device = this.getDevice(address);
        if (device && device.file) {
            device.file = undefined;
            device.fileIndex = 0;
            device.fileBlocksTotal = 0;
        }
    }
    startApplicationUpload(mac, fileString, deviceDefinition, method, files, baudRate = 115200) {
        if (!mac && !deviceDefinition) {
            return;
        }
        fileString = fileString || '';
        const bytes = Buffer.from(fileString, 'binary');
        if (deviceDefinition && method) {
            if (method === 'micropython' && files) {
                this.startUploadMicropython(mac, files, baudRate);
                return;
            }
            else if (method === 'esp32') {
                this.uploadESP32(mac, bytes, deviceDefinition, baudRate);
                return;
            }
            else if (method === 'bossac') {
                this.uploadBossac(mac, bytes, deviceDefinition);
                return;
            }
            else if (method === 'openocd') {
                this.uploadOpenOCD(mac, bytes, deviceDefinition);
                return;
            }
            else if (method === 'jlink') {
                this.uploadJLink(mac, bytes, deviceDefinition);
                return;
            }
            else if (method === 'teensy') {
                this.uploadTeensy(mac, bytes, deviceDefinition);
                return;
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
            this.clearDeviceMessageQueue(mac);
            this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING, '', true);
        }
    }
    uploadESP32(mac, bytes, deviceDefinition, baudRate) {
        const filesArray = [];
        let flashAddress = 0x10000;
        if (deviceDefinition.flashAddress !== undefined) {
            if (deviceDefinition.flashAddress.startsWith('0x')) {
                flashAddress = parseInt(deviceDefinition.flashAddress, 16);
            }
            else {
                flashAddress = Number(deviceDefinition.flashAddress);
            }
        }
        filesArray.push({
            data: bytes,
            address: flashAddress,
        });
        this.startUploadEsp32(mac, filesArray, baudRate);
    }
    uploadBossac(mac, bytes, deviceDefinition) {
        const fileBase = this.makeid(8);
        try {
            let bossacPath = 'bossac';
            if (process.platform === 'win32') {
                bossacPath = 'bossac.exe';
            }
            const bossac = cp.spawnSync(bossacPath, ['--version']);
            if (bossac.error) {
                this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                    data: `${bossacPath} not found`,
                    format: 'markdown',
                    mac: mac,
                });
                return this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                    method: 'bossac',
                    code: 'not_found',
                    mac,
                });
            }
            fs.mkdirSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase), { recursive: true });
            fs.writeFileSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase, `zephyr.bin`), bytes);
            const cleanup = () => {
                if (fileBase && fs.existsSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase))) {
                    fs.rmdirSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase), { recursive: true });
                }
            };
            let ccmd = ``;
            ccmd = `${bossacPath} -p ${mac} -R -e -w -v -b ${path.join(PROJECT_OUTPUT_FOLDER, fileBase, `zephyr.bin`)} -o ${deviceDefinition.partitions[0].size}`;
            const exec = cp.spawn(ccmd, [], { env: Object.assign(Object.assign({}, process.env), { NODE_OPTIONS: '' }), timeout: 60000, shell: true });
            if (!exec.pid) {
                return;
            }
            let outputData = '';
            exec.stdout.on('data', (data) => {
                try {
                    let progress = 0;
                    const match = data.toString().match(/\(([^)]+)\)/);
                    if (match) {
                        progress = match[1].split('/')[0] / match[1].split('/')[1].replace('pages', '').trim();
                        this.emit(TIBBO_PROXY_MESSAGE.UPLOAD, {
                            'data': progress,
                            'mac': mac
                        });
                    }
                }
                catch (ex) {
                }
            });
            exec.on('error', () => {
                cleanup();
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    method: 'bossac',
                    mac: '',
                });
            });
            exec.stderr.on('data', (data) => {
                outputData += data.toString();
            });
            exec.on('exit', (code) => {
                cleanup();
                if (code !== 0) {
                    this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                        data: outputData,
                        mac: mac,
                    });
                    return this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                        method: 'bossac',
                        code: 'error',
                        mac,
                    });
                }
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    method: 'bossac',
                    mac,
                });
            });
        }
        catch (ex) {
            this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                data: ex.toString(),
                mac: mac,
            });
            this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                method: 'bossac',
                mac,
            });
        }
    }
    uploadOpenOCD(mac, bytes, deviceDefinition) {
        const openocdMethod = deviceDefinition.uploadMethods.find((method) => method.name === 'openocd');
        let jlinkDevice = deviceDefinition.id;
        const fileBase = this.makeid(8);
        let scriptPath = '';
        let filePath = '';
        try {
            let openocdPath = 'openocd';
            if (process.platform === 'win32') {
                openocdPath = 'openocd.exe';
            }
            const openocd = cp.spawnSync(openocdPath, ['--version']);
            if (openocd.error) {
                this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                    data: `${openocdPath} not found`,
                    format: 'markdown',
                    mac: mac,
                });
                return this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                    method: 'openocd',
                    code: 'not_found',
                    mac,
                });
            }
            fs.mkdirSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase), { recursive: true });
            scriptPath = path.join(PROJECT_OUTPUT_FOLDER, fileBase, `openocd.cfg`);
            let openocdOptions = '';
            if (openocdMethod.options.length > 0) {
                openocdOptions = openocdMethod.options[0];
            }
            fs.writeFileSync(scriptPath, openocdOptions);
            fs.writeFileSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase, `zephyr.elf`), bytes);
            const cleanup = () => {
                if (fileBase && fs.existsSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase))) {
                    fs.rmdirSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase), { recursive: true });
                }
            };
            let cmdOutput = '';
            const ccmd = `${openocdPath} -f ${scriptPath} -c 'program ${path.join(PROJECT_OUTPUT_FOLDER, fileBase, 'zephyr.elf')} verify reset exit'`;
            console.log(ccmd);
            const exec = cp.spawn(ccmd, [], { env: Object.assign(Object.assign({}, process.env), { NODE_OPTIONS: '' }), timeout: 60000, shell: true });
            if (!exec.pid) {
                return;
            }
            exec.on('error', () => {
                cleanup();
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    method: 'openocd',
                    mac: jlinkDevice,
                });
            });
            exec.stderr.on('data', (data) => {
                cmdOutput += data.toString();
                console.log(data.toString());
            });
            exec.stdout.on('data', (data) => {
                cmdOutput += data.toString();
                console.log(data.toString());
            });
            exec.on('exit', (code) => {
                cleanup();
                if (code !== 0) {
                    this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                        data: `OpenOCD exited with code ${code} \n${cmdOutput}`,
                        mac: mac,
                    });
                    return this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                        method: 'openocd',
                        code: 'error',
                        mac,
                    });
                }
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    method: 'openocd',
                    mac: jlinkDevice,
                });
            });
        }
        catch (ex) {
            this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                data: ex.toString(),
                mac,
            });
            this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                method: 'openocd',
                mac,
            });
        }
    }
    uploadJLink(mac, bytes, deviceDefinition) {
        const jlinkMethod = deviceDefinition.uploadMethods.find((method) => method.name === 'jlink');
        let jlinkDevice = '';
        let speed = '';
        let flashAddress = deviceDefinition.flashAddress || '0x0';
        const fileBase = this.makeid(8);
        let scriptPath = '';
        let filePath = '';
        try {
            let jlinkPath = 'JLinkExe';
            if (process.platform === 'win32') {
                jlinkPath = 'JLinkExe.exe';
            }
            const jlink = cp.spawnSync(jlinkPath, ['--version']);
            if (jlink.error) {
                this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                    data: `${jlinkPath} not found`,
                    format: 'markdown',
                    mac: mac,
                });
                return this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                    method: 'jlink',
                    code: 'not_found',
                    mac,
                });
            }
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
            filePath = path.join(PROJECT_OUTPUT_FOLDER, fileName);
            scriptPath = path.join(PROJECT_OUTPUT_FOLDER, `${fileBase}.jlink`);
            fs.writeFileSync(filePath, bytes);
            fs.writeFileSync(scriptPath, `loadbin ${filePath} ${flashAddress}\nR\nG\nExit`);
            const cleanup = () => {
                if (scriptPath && fs.existsSync(scriptPath)) {
                    fs.unlinkSync(scriptPath);
                }
                if (filePath && fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            };
            const ccmd = `${jlinkPath} -device ${jlinkDevice} -if SWD -speed ${speed} -autoconnect 1 -CommanderScript ${scriptPath}`;
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
            exec.stderr.on('data', (data) => {
                console.log(data.toString());
            });
            exec.stdout.on('data', (data) => {
                console.log(data.toString());
            });
            exec.on('exit', () => {
                cleanup();
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    method: 'jlink',
                    mac: jlinkDevice,
                });
            });
        }
        catch (ex) {
            console.log(ex);
        }
    }
    uploadTeensy(mac, bytes, deviceDefinition) {
        const teensyMethod = deviceDefinition.uploadMethods.find((method) => method.name === 'teensy');
        let teensyDevice = '';
        const fileBase = this.makeid(8);
        let filePath = '';
        try {
            for (let i = 0; i < teensyMethod.options.length; i++) {
                let option = teensyMethod.options[i];
                if (option.indexOf('"') === 0) {
                    option = option.substring(1, option.length - 1);
                }
                if (option.indexOf('--mcu=') === 0) {
                    teensyDevice = option.split('=')[1];
                    break;
                }
            }
            let fileName = `${fileBase}.hex`;
            filePath = path.join(PROJECT_OUTPUT_FOLDER, fileName);
            fs.writeFileSync(filePath, bytes);
            const cleanup = () => {
                if (filePath && fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            };
            const ccmd = `teensy_loader_cli --mcu=${teensyDevice} -w -v ${filePath}`;
            const exec = cp.spawn(ccmd, [], { env: Object.assign(Object.assign({}, process.env), { NODE_OPTIONS: '' }), timeout: 60000, shell: true });
            if (!exec.pid) {
                return;
            }
            exec.on('error', () => {
                cleanup();
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    mac,
                });
            });
            exec.stderr.on('data', (data) => {
                console.log(data.toString());
            });
            exec.stdout.on('data', (data) => {
                console.log(data.toString());
            });
            exec.on('exit', () => {
                cleanup();
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    method: 'teensy',
                    mac,
                });
            });
        }
        catch (ex) {
            console.log(ex);
        }
    }
    startUploadMicropython(mac, files, baudRate) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.getSerialPorts();
                yield this.detachSerial(mac);
                const attach = yield this.attachSerial(mac, baudRate);
                if (!attach) {
                    throw new Error('Failed to attach serial');
                }
                const serialPort = this.serialDevices[mac];
                const micropythonSerial = new MicropythonSerial_1.MicropythonSerial(serialPort);
                yield micropythonSerial.enterRawMode(true);
                for (let i = 0; i < files.length; i++) {
                    this.emit(TIBBO_PROXY_MESSAGE.UPLOAD, {
                        'data': i / files.length,
                        'mac': mac
                    });
                    this.emit(TIBBO_PROXY_MESSAGE.DEBUG_PRINT, {
                        data: JSON.stringify({
                            data: `Uploading ${files[i].name}...`,
                            state: '',
                        }),
                        mac: mac,
                    });
                    yield micropythonSerial.writeFileToDevice(files[i]);
                }
                yield micropythonSerial.exitRawMode();
                yield this.detachSerial(mac);
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    'error': false,
                    'nonce': '',
                    'mac': mac
                });
            }
            catch (ex) {
                console.log(ex);
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                    'nonce': '',
                    'mac': mac
                });
                logger.error(ex);
            }
        });
    }
    startUploadEsp32(mac, files, baudRate) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.getSerialPorts();
                yield this.detachSerial(mac);
                yield this.attachSerial(mac, baudRate);
                const serialPort = this.serialDevices[mac];
                if (!serialPort) {
                    throw new Error('Failed to attach serial');
                }
                const esp32Serial = new node_1.NodeESP32Serial(serialPort);
                esp32Serial.on('progress', (progress) => {
                    this.emit(TIBBO_PROXY_MESSAGE.UPLOAD, {
                        method: 'esp32',
                        'data': progress,
                        'mac': mac
                    });
                });
                yield esp32Serial.writeFilesToDevice(files);
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    'error': false,
                    'nonce': '',
                    'mac': mac
                });
            }
            catch (ex) {
                console.log(ex);
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                    method: 'esp32',
                    mac,
                });
                this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                    data: ex.message,
                    mac: mac,
                });
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
        for (let i = 0; i < this.devices.length; i++) {
            if (mac === this.devices[i].mac
                && this.devices[i].type !== undefined
                && this.devices[i].type !== 'tios') {
                return;
            }
        }
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
                    timeout: RETRY_TIMEOUT + this.pendingMessages.length * 10,
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
        let i = 0;
        while (i < this.pendingMessages.length) {
            const pendingMessage = this.pendingMessages[i];
            const elapsed = currentDate - pendingMessage.timestamp;
            if (elapsed > pendingMessage.timeout) {
                if (pendingMessage.tries > 10) {
                    logger.warn(`Discarding message after ${pendingMessage.tries} attempts: ${pendingMessage.message}`);
                    this.pendingMessages.splice(i, 1);
                    continue;
                }
                if (!this.isValidInterface(pendingMessage.deviceInterface)) {
                    logger.warn(`Interface no longer valid, discarding message: ${pendingMessage.message}`);
                    this.pendingMessages.splice(i, 1);
                    continue;
                }
                if (pendingMessage.timeout < 1024) {
                    pendingMessage.timeout *= 2;
                }
                pendingMessage.tries++;
                pendingMessage.timestamp = currentDate;
                try {
                    const message = pendingMessage.message;
                    const pnum = pendingMessage.nonce;
                    const newMessage = Buffer.from(`${message}|${pnum}`, 'binary');
                    logger.info(`Retrying message (attempt ${pendingMessage.tries}): ${pendingMessage.message}`);
                    this.send(newMessage, pendingMessage.deviceInterface);
                }
                catch (err) {
                    logger.error(`Error retrying message: ${err.message}`);
                    this.pendingMessages.splice(i, 1);
                    continue;
                }
            }
            i++;
        }
    }
    isValidInterface(deviceInterface) {
        if (!deviceInterface || !deviceInterface.socket) {
            return false;
        }
        return this.interfaces.some(int => int === deviceInterface) &&
            this.isSocketActive(deviceInterface.socket);
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
    getBroadcastAddress(ipAddress, netmask) {
        try {
            const ip = ipAddress.split('.').map(Number);
            const mask = netmask.split('.').map(Number);
            const broadcast = ip.map((octet, i) => octet | (~mask[i] & 255));
            return broadcast.join('.');
        }
        catch (ex) {
            logger.error('Error calculating broadcast address:', ex);
            return '255.255.255.255';
        }
    }
    isSocketActive(socket) {
        try {
            return socket && typeof socket.send === 'function';
        }
        catch (err) {
            return false;
        }
    }
    sendToSocket(socket, message, address, port) {
        return new Promise((resolve, reject) => {
            try {
                if (!this.isSocketActive(socket)) {
                    reject(new Error('Socket is not active'));
                    return;
                }
                const messageArray = new Uint8Array(message);
                socket.send(messageArray, 0, messageArray.length, port, address, (err) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve();
                    }
                });
            }
            catch (err) {
                reject(err);
            }
        });
    }
    send(message, netInterface, targetIP) {
        logger.info(`${new Date().toLocaleTimeString()} sent: ${message}`);
        let targetInterface = this.currentInterface;
        if (netInterface != undefined) {
            targetInterface = netInterface;
        }
        if (targetInterface != undefined) {
            this.sendToSingleInterface(message, targetInterface);
        }
        else {
            this.sendToAllInterfaces(message);
        }
    }
    sendToSingleInterface(message, targetInterface) {
        if (!this.isSocketActive(targetInterface.socket)) {
            logger.error('Target interface socket is not active');
            return;
        }
        try {
            const broadcastAddress = this.getBroadcastAddress(targetInterface.netInterface.address, targetInterface.netInterface.netmask);
            this.sendToSocket(targetInterface.socket, message, broadcastAddress, PORT)
                .catch(err => {
                logger.error('Error sending to specific interface:', err.message);
            });
        }
        catch (err) {
            logger.error('Error preparing message for specific interface:', err.message);
        }
    }
    sendToAllInterfaces(message) {
        const interfaceSnapshot = [...this.interfaces];
        interfaceSnapshot.forEach((interfaceItem, index) => {
            if (!this.isSocketActive(interfaceItem.socket)) {
                logger.warn(`Interface ${index} socket is not active, skipping`);
                return;
            }
            try {
                const broadcastAddress = this.getBroadcastAddress(interfaceItem.netInterface.address, interfaceItem.netInterface.netmask);
                this.sendToSocket(interfaceItem.socket, message, broadcastAddress, PORT)
                    .catch(err => {
                    logger.error(`Error sending to interface ${index}:`, err.message);
                });
            }
            catch (err) {
                logger.error(`Error preparing message for interface ${index}:`, err.message);
            }
        });
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
        logger.info('Closing TIDEProxy...');
        this.clearPendingOperations();
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.close();
            this.socket = undefined;
        }
        this.cleanupOldInterfaces([...this.interfaces]);
        this.interfaces = [];
        this.currentInterface = undefined;
        this.devices = [];
        this.discoveredDevices = {};
        logger.info('TIDEProxy closed successfully');
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
        return __awaiter(this, void 0, void 0, function* () {
            const ports = yield serialport_1.SerialPort.list();
            for (let i = 0; i < ports.length; i++) {
                let found = false;
                for (let j = 0; j < this.devices.length; j++) {
                    if (this.devices[j].mac == ports[i].path) {
                        found = true;
                        break;
                    }
                }
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
                };
                this.emit(TIBBO_PROXY_MESSAGE.DEVICE, {
                    ip: device.ip,
                    mac: device.mac,
                    tios: device.tios,
                    app: device.app,
                    pcode: device.pcode,
                    appVersion: device.appVersion,
                    type: device.type,
                });
                if (!found) {
                    this.devices.push(device);
                }
            }
        });
    }
    attachSerial(port, baudRate = 115200, reset = false) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                for (let i = 0; i < this.devices.length; i++) {
                    if (this.devices[i].mac == port) {
                        const serialPort = new NodeSerialPort_1.default(port);
                        serialPort.on('data', (data) => {
                            this.emit(TIBBO_PROXY_MESSAGE.DEBUG_PRINT, {
                                data: JSON.stringify({
                                    data: new TextDecoder().decode(data),
                                    state: '',
                                }),
                                mac: port,
                            });
                        });
                        serialPort.on('error', (error) => {
                            this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                                data: error.message,
                                mac: port,
                            });
                        });
                        serialPort.on('close', (error) => {
                            this.emit(TIBBO_PROXY_MESSAGE.DETACH_SERIAL, {
                                mac: port,
                                address: port,
                            });
                            this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                                data: error.message,
                                mac: port,
                            });
                        });
                        const connected = yield serialPort.connect(baudRate);
                        if (!connected) {
                            return false;
                        }
                        if (reset) {
                            yield serialPort.write('\x03');
                            yield serialPort.write('\x04');
                        }
                        this.serialDevices[port] = serialPort;
                        return true;
                    }
                }
                return false;
            }
            catch (ex) {
                logger.error('error attaching serial');
                return false;
            }
        });
    }
    detachSerial(port) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                for (let i = 0; i < this.devices.length; i++) {
                    if (this.devices[i].mac == port) {
                        yield this.serialDevices[port].disconnect();
                        delete this.serialDevices[port];
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
    TIBBO_PROXY_MESSAGE["GPIO_SET"] = "gpio_set";
    TIBBO_PROXY_MESSAGE["WIEGAND_SEND"] = "wiegand_send";
    TIBBO_PROXY_MESSAGE["UPLOAD_ERROR"] = "upload_error";
    TIBBO_PROXY_MESSAGE["MESSAGE"] = "message";
})(TIBBO_PROXY_MESSAGE = exports.TIBBO_PROXY_MESSAGE || (exports.TIBBO_PROXY_MESSAGE = {}));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGlkZS1wcm94eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy90aWRlLXByb3h5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBK0I7QUFDL0IsMkNBQXlDO0FBQ3pDLDJDQUF1QztBQUN2QywyREFBd0Q7QUFDeEQsNkNBQW9FO0FBQ3BFLHNFQUE0QztBQUc1Qyx1REFBd0Q7QUFDeEQsa0RBQXNDO0FBQ3RDLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FBQyxlQUFlLENBQUMsQ0FBQztBQUNwQyxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekIsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQzdCLE1BQU0sT0FBTyxHQUFHLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUNuQyxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDM0IsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEVBQUUsaUJBQWlCLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztBQUN4RyxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekIsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQzdCLE1BQU0sRUFBRSxPQUFPLEVBQUUsR0FBRyxPQUFPLENBQUMsY0FBYyxDQUFDLENBQUM7QUFFNUMsTUFBTSxhQUFhLEdBQUcsRUFBRSxDQUFDO0FBQ3pCLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQztBQUduQixNQUFNLFFBQVEsR0FBRyxHQUFHLENBQUM7QUFDckIsTUFBTSxlQUFlLEdBQUcsR0FBRyxDQUFDO0FBQzVCLE1B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
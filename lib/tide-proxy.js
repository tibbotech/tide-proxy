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
const MAX_UPLOAD_RETRIES = 5;
const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_FILE_SIZE = 65535 * BLOCK_SIZE;
const UPLOAD_STALL_TIMEOUT_MS = 9000;
const UPLOAD_BLOCK_TIMEOUT = 200;
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
const PROJECT_OUTPUT_FOLDER = process.env.TIDE_PROXY_OUTPUT_DIR
    || path.join(os.tmpdir(), 'tide-proxy', 'project_output');
function openocdFirmwareExtension(buf) {
    if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
        return 'elf';
    }
    let i = 0;
    while (i < buf.length) {
        const b = buf[i];
        if (b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a) {
            i++;
            continue;
        }
        if (i + 2 < buf.length && buf[i] === 0xef && buf[i + 1] === 0xbb && buf[i + 2] === 0xbf) {
            i += 3;
            continue;
        }
        break;
    }
    if (i < buf.length && buf[i] === 0x3a) {
        return 'hex';
    }
    return 'elf';
}
function resolveAtPlatformsPackageRoot() {
    return path.join(process.cwd(), 'platforms');
}
class TIDEProxy {
    constructor(serverAddressOrOptions = '', proxyName, port = 3535, targetInterface, options) {
        this.devices = [];
        this.pendingMessages = [];
        this.interfaces = [];
        this.currentInterface = undefined;
        this.memoryCalls = {};
        this.discoveredDevices = {};
        this.serialDevices = {};
        this.adks = [];
        this.lastInterfaceState = '';
        let serverAddress;
        let actualProxyName;
        let actualPort;
        let actualTargetInterface;
        let toolPaths;
        if (typeof serverAddressOrOptions === 'object') {
            serverAddress = serverAddressOrOptions.serverAddress || '';
            actualProxyName = serverAddressOrOptions.proxyName || '';
            actualPort = serverAddressOrOptions.port || 3535;
            actualTargetInterface = serverAddressOrOptions.targetInterface;
            toolPaths = serverAddressOrOptions.toolPaths || {};
        }
        else {
            serverAddress = serverAddressOrOptions;
            actualProxyName = proxyName || '';
            actualPort = port;
            actualTargetInterface = targetInterface;
            toolPaths = (options === null || options === void 0 ? void 0 : options.toolPaths) || {};
        }
        const isWindows = process.platform === 'win32';
        this.toolPaths = {
            openocd: toolPaths.openocd || (isWindows ? 'openocd.exe' : 'openocd'),
            bossac: toolPaths.bossac || (isWindows ? 'bossac.exe' : 'bossac'),
            jlink: toolPaths.jlink || (isWindows ? 'JLinkExe.exe' : 'JLinkExe'),
        };
        this.id = new Date().getTime().toString();
        this.listenPort = actualPort;
        this.initInterfaces(actualTargetInterface);
        this.startNetworkWatcher(actualTargetInterface);
        if (serverAddress != '') {
            this.setServer(serverAddress, actualProxyName);
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
        io.listen(actualPort);
    }
    initInterfaces(targetInterface = '') {
        const ifaces = os.networkInterfaces();
        this.clearPendingOperations();
        const oldInterfaces = [...this.interfaces];
        this.interfaces = [];
        for (const key in ifaces) {
            const iface = ifaces[key];
            for (let i = 0; i < iface.length; i++) {
                const tmp = iface[i];
                if (tmp.family == 'IPv4' && !tmp.internal) {
                    try {
                        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
                        socket.on('close', () => {
                            logger.info('Socket closed for ' + tmp.address);
                        });
                        socket.on('error', (err) => {
                            logger.error(`UDP server error on ${tmp.address}:\n${err.stack}`);
                            socket.close();
                        });
                        socket.on('message', (msg, info) => {
                            this.handleMessage(msg, info, int);
                        });
                        socket.on('listening', () => {
                            logger.info('Listening on ' + tmp.address);
                        });
                        const int = {
                            socket: socket,
                            netInterface: tmp
                        };
                        socket.bind({
                            address: tmp.address
                        }, () => {
                            logger.info('Socket bound for ' + tmp.address);
                            socket.setBroadcast(true);
                        });
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
    getInterfaceState() {
        const ifaces = os.networkInterfaces();
        const state = [];
        for (const key in ifaces) {
            const iface = ifaces[key];
            for (let i = 0; i < iface.length; i++) {
                const tmp = iface[i];
                if (tmp.family == 'IPv4' && !tmp.internal) {
                    state.push(`${key}:${tmp.address}:${tmp.netmask}`);
                }
            }
        }
        return state.sort().join('|');
    }
    startNetworkWatcher(targetInterface) {
        this.lastInterfaceState = this.getInterfaceState();
        this.networkWatcherTimer = setInterval(() => {
            const currentState = this.getInterfaceState();
            if (currentState !== this.lastInterfaceState) {
                logger.info('Network interface change detected, reinitializing interfaces...');
                this.lastInterfaceState = currentState;
                this.initInterfaces(targetInterface);
            }
        }, 5000);
    }
    stopNetworkWatcher() {
        if (this.networkWatcherTimer) {
            clearInterval(this.networkWatcherTimer);
            this.networkWatcherTimer = undefined;
        }
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
        socket.on(TIBBO_PROXY_MESSAGE.POLL_DEVICE, (message) => {
            const { mac } = message;
            if (mac) {
                const device = this.getDevice(mac);
                if (device) {
                    device.lastPoll = new Date().getTime();
                    this.sendToDevice(mac, PCODE_COMMANDS.STATE, '');
                }
            }
        });
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
    handleMessage(msg, info, socket) {
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
                        device.uploadRetries = 0;
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
                case PCODE_COMMANDS.APPUPLOADFINISH: {
                    let verifyCount = 0;
                    logger.info(`${mac}, resetting...`);
                    const verifyDevice = this.getDevice(mac);
                    if (verifyDevice.uploadWatchdog) {
                        clearInterval(verifyDevice.uploadWatchdog);
                        verifyDevice.uploadWatchdog = undefined;
                    }
                    if (verifyDevice.verificationTimer) {
                        clearInterval(verifyDevice.verificationTimer);
                    }
                    verifyDevice.uploadAttempts = (verifyDevice.uploadAttempts || 0) + 1;
                    verifyDevice.verificationTimer = setInterval(() => {
                        var _a;
                        this.sendToDevice(mac, PCODE_COMMANDS.INFO, '');
                        const dev = this.getDevice(mac);
                        if (dev.appVersion != '' && dev.file) {
                            if (((_a = dev.file) === null || _a === void 0 ? void 0 : _a.toString('binary').indexOf(dev.appVersion)) >= 0) {
                                logger.info(`${mac}, upload complete`);
                                this.stopApplicationUpload(mac);
                                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                                    'nonce': identifier,
                                    'mac': mac
                                });
                                return;
                            }
                        }
                        verifyCount++;
                        if (verifyCount > 10) {
                            if (dev.verificationTimer) {
                                clearInterval(dev.verificationTimer);
                                dev.verificationTimer = undefined;
                            }
                            if (dev.file && (dev.uploadAttempts || 0) < MAX_UPLOAD_ATTEMPTS) {
                                logger.warn(`Retrying upload for ${mac} (attempt ${dev.uploadAttempts}/${MAX_UPLOAD_ATTEMPTS})`);
                                this.clearDeviceMessageQueue(mac);
                                this.startApplicationUpload(mac, dev.file.toString('binary'), dev.deviceDefinition);
                            }
                            else {
                                logger.error(`Upload verification failed for ${mac} after ${dev.uploadAttempts} attempts`);
                                this.stopApplicationUpload(mac);
                                this.clearDeviceMessageQueue(mac);
                                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                                    mac: mac,
                                    method: 'tios',
                                    code: 'verification_failed',
                                });
                                this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                                    data: `Upload verification failed for ${mac} after ${dev.uploadAttempts} attempts`,
                                    mac: mac,
                                });
                            }
                        }
                    }, 1000);
                    break;
                }
                case PCODE_COMMANDS.RESET_PROGRAMMING:
                case PCODE_COMMANDS.RESET_PROGRAMMING_FIRMWARE:
                    if (device.resetProgrammingToken) {
                        device.resetProgrammingToken.message = reply;
                        device.resetProgrammingToken.notify();
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
        if (device) {
            if (device.uploadWatchdog) {
                clearInterval(device.uploadWatchdog);
                device.uploadWatchdog = undefined;
            }
            if (device.verificationTimer) {
                clearInterval(device.verificationTimer);
                device.verificationTimer = undefined;
            }
            device.uploadRetries = 0;
            if (device.file) {
                device.file = undefined;
                device.fileIndex = 0;
                device.fileBlocksTotal = 0;
            }
        }
    }
    resolveTiosFirmwarePath(deviceDefinition) {
        if (!deviceDefinition) {
            return undefined;
        }
        if (typeof deviceDefinition.tiosFirmwarePath === 'string'
            && fs.existsSync(deviceDefinition.tiosFirmwarePath)) {
            return deviceDefinition.tiosFirmwarePath;
        }
        const root = deviceDefinition.platformsDir
            || process.env.TIDE_PLATFORMS_DIR
            || resolveAtPlatformsPackageRoot();
        const platform = deviceDefinition.platform || deviceDefinition.id;
        if (!root || !platform) {
            return undefined;
        }
        const firmwareDir = path.join(root, 'Platforms', platform, 'firmware');
        if (fs.existsSync(firmwareDir) && fs.statSync(firmwareDir).isDirectory()) {
            const explicit = deviceDefinition.tiosFirmware || deviceDefinition.firmwareFile;
            if (explicit) {
                const exact = path.join(firmwareDir, explicit);
                if (fs.existsSync(exact) && fs.statSync(exact).isFile()) {
                    return exact;
                }
            }
            let entries;
            try {
                entries = fs.readdirSync(firmwareDir);
            }
            catch (_a) {
                return undefined;
            }
            const bins = entries.filter((f) => f.toLowerCase().endsWith('.bin'));
            if (bins.length === 1) {
                return path.join(firmwareDir, bins[0]);
            }
            if (bins.length > 1) {
                const byLower = new Map(bins.map((b) => [b.toLowerCase(), b]));
                for (const preferred of ['firmware.bin', 'tios.bin']) {
                    const hit = byLower.get(preferred);
                    if (hit) {
                        return path.join(firmwareDir, hit);
                    }
                }
                bins.sort((a, b) => a.localeCompare(b));
                return path.join(firmwareDir, bins[0]);
            }
        }
        const legacyName = deviceDefinition.tiosFirmware || deviceDefinition.firmwareFile || 'firmware.bin';
        const legacy = path.join(root, platform, 'firmware', legacyName);
        if (fs.existsSync(legacy)) {
            return legacy;
        }
        return undefined;
    }
    startApplicationUpload(mac, fileString, deviceDefinition, method, files, baudRate = 115200) {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            if (!mac && !deviceDefinition) {
                return;
            }
            fileString = fileString || '';
            const bytes = Buffer.from(fileString, 'binary');
            if (method) {
                const dev = this.getDevice(mac);
                dev.uploadAttempts = 0;
            }
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
                this.stopApplicationUpload(mac);
                this.clearDeviceMessageQueue(mac);
                device.fileIndex = 0;
                device.uploadRetries = 0;
                device.deviceDefinition = deviceDefinition;
                device.file = bytes;
                let isTpcFile = false;
                if (((_a = device.file) === null || _a === void 0 ? void 0 : _a.toString('binary').indexOf('TBIN')) == 0) {
                    isTpcFile = true;
                }
                if (device.file.length > MAX_FILE_SIZE) {
                    this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                        data: `File too large (${device.file.length} bytes). Maximum supported size is ${MAX_FILE_SIZE} bytes.`,
                        mac,
                    });
                    this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                        mac,
                        method: 'tios',
                        code: 'file_too_large',
                    });
                    device.file = undefined;
                    return;
                }
                device.resetProgrammingToken = new Subject();
                this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING, '', true);
                yield device.resetProgrammingToken.wait(5000);
                if (!device.resetProgrammingToken.message
                    || device.resetProgrammingToken.message === 'F'
                    || (device.tios.indexOf('TiOS-32 Loader') >= 0 && isTpcFile)) {
                    const firmwarePath = this.resolveTiosFirmwarePath(deviceDefinition);
                    if (!deviceDefinition || !firmwarePath) {
                        this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                            data: 'Device did not enter programming mode. Provide deviceDefinition with a resolvable TIOS firmware path (tiosFirmwarePath), install @platforms (Platforms/<id>/firmware/*.bin), or set platformsDir / TIDE_PLATFORMS_DIR.',
                            mac,
                        });
                        this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                            mac,
                            method: 'tios',
                            code: 'no_programming_mode',
                        });
                        device.file = undefined;
                        return;
                    }
                    let firmwareBytes;
                    try {
                        firmwareBytes = fs.readFileSync(firmwarePath);
                    }
                    catch (e) {
                        this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                            data: `Could not read TIOS firmware: ${firmwarePath}: ${(_b = e === null || e === void 0 ? void 0 : e.message) !== null && _b !== void 0 ? _b : e}`,
                            mac,
                        });
                        this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                            mac,
                            method: 'tios',
                            code: 'firmware_read_error',
                        });
                        device.file = undefined;
                        return;
                    }
                    device.file = Buffer.concat([firmwareBytes, bytes]);
                    device.fileIndex = 0;
                    if (device.file.length > MAX_FILE_SIZE) {
                        this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                            data: `Combined firmware + app too large (${device.file.length} bytes). Maximum supported size is ${MAX_FILE_SIZE} bytes.`,
                            mac,
                        });
                        this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                            mac,
                            method: 'tios',
                            code: 'file_too_large',
                        });
                        device.file = undefined;
                        return;
                    }
                    device.resetProgrammingToken = new Subject();
                    this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING_FIRMWARE, '', true);
                    yield device.resetProgrammingToken.wait(5000);
                    if (!device.resetProgrammingToken.message || device.resetProgrammingToken.message === 'F') {
                        this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                            data: `Device ${mac} did not acknowledge firmware programming mode (QF).`,
                            mac,
                        });
                        this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                            mac,
                            method: 'tios',
                            code: 'qf_failed',
                        });
                        device.file = undefined;
                        device.resetProgrammingToken = undefined;
                        return;
                    }
                }
                device.resetProgrammingToken = undefined;
                let lastFileIndex = -1;
                let stallCount = 0;
                device.uploadWatchdog = setInterval(() => {
                    const dev = this.getDevice(mac);
                    if (!dev.file || dev.fileBlocksTotal === 0) {
                        if (dev.uploadWatchdog) {
                            clearInterval(dev.uploadWatchdog);
                            dev.uploadWatchdog = undefined;
                        }
                        return;
                    }
                    if (dev.fileIndex === lastFileIndex) {
                        stallCount++;
                    }
                    else {
                        stallCount = 0;
                        lastFileIndex = dev.fileIndex;
                    }
                    if (stallCount >= 3) {
                        logger.error(`Upload stalled for ${mac} at block ${dev.fileIndex} for ${stallCount * (UPLOAD_STALL_TIMEOUT_MS / 3)}ms`);
                        this.stopApplicationUpload(mac);
                        this.clearDeviceMessageQueue(mac);
                        this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                            mac: mac,
                            method: 'tios',
                        });
                        this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                            data: `Upload failed: device ${mac} stopped responding`,
                            mac: mac,
                        });
                    }
                }, UPLOAD_STALL_TIMEOUT_MS / 3);
                for (let i = 0; i < this.pendingMessages.length; i++) {
                    for (let j = 0; j < device.messageQueue.length; j++) {
                        if (this.pendingMessages[i].nonce == device.messageQueue[j].nonce) {
                            this.pendingMessages.splice(i, 1);
                            i--;
                            break;
                        }
                    }
                }
                device.blockSize = 1;
                if (device.file != null) {
                    this.sendBlock(mac, 0);
                }
            }
        });
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
        const bossacPath = this.toolPaths.bossac;
        try {
            const bossac = cp.spawnSync(bossacPath, ['--version'], { shell: true });
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
        const openocdPath = this.toolPaths.openocd;
        try {
            const openocd = cp.spawnSync(openocdPath, ['--version'], { shell: true });
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
            const uploadFileName = `${fileBase}.${openocdFirmwareExtension(bytes)}`;
            fs.writeFileSync(scriptPath, openocdOptions);
            fs.writeFileSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase, uploadFileName), bytes);
            const cleanup = () => {
                if (fileBase && fs.existsSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase))) {
                    fs.rmdirSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase), { recursive: true });
                }
            };
            let cmdOutput = '';
            const ccmd = `${openocdPath} -f ${scriptPath} -c 'program ${path.join(PROJECT_OUTPUT_FOLDER, fileBase, uploadFileName)} verify reset exit'`;
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
        const jlinkPath = this.toolPaths.jlink;
        try {
            const jlink = cp.spawnSync(jlinkPath, ['--version'], { shell: true });
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
            const isHexFile = openocdFirmwareExtension(bytes) === 'hex';
            if (isHexFile) {
                fileName = `${fileBase}.hex`;
            }
            filePath = path.join(PROJECT_OUTPUT_FOLDER, fileName);
            scriptPath = path.join(PROJECT_OUTPUT_FOLDER, `${fileBase}.jlink`);
            fs.writeFileSync(filePath, bytes);
            if (isHexFile) {
                fs.writeFileSync(scriptPath, `loadfile ${filePath}\nR\nG\nExit`);
            }
            else {
                fs.writeFileSync(scriptPath, `loadbin ${filePath} ${flashAddress}\nR\nG\nExit`);
            }
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
                yield this.detachSerial(mac);
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
            const fullBlockSize = BLOCK_SIZE + 2;
            if (fileBlock.length < fullBlockSize) {
                const filler = Buffer.alloc(fullBlockSize - fileBlock.length);
                fileBlock = Buffer.concat([fileBlock, filler]);
            }
            this.sendToDevice(mac, PCODE_COMMANDS.UPLOAD, Buffer.concat([fileBlock]).toString('binary'), true);
            this.sendToDevice(mac, PCODE_COMMANDS.UPLOAD, Buffer.concat([fileBlock]).toString('binary'), true);
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
                    timeout: command === PCODE_COMMANDS.UPLOAD
                        ? UPLOAD_BLOCK_TIMEOUT
                        : RETRY_TIMEOUT + this.pendingMessages.length * 10,
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
                    this.handleUploadMessageTimeout(pendingMessage);
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
    handleUploadMessageTimeout(pendingMessage) {
        const macMatch = pendingMessage.message.match(/\[([^\]]+)\]/);
        if (!macMatch)
            return;
        const mac = macMatch[1];
        const device = this.getDevice(mac);
        if (!device.file)
            return;
        const commandStart = pendingMessage.message.indexOf(']') + 1;
        const msgAfterBracket = pendingMessage.message.substring(commandStart);
        const isUploadBlock = msgAfterBracket.startsWith(PCODE_COMMANDS.UPLOAD);
        const isResetProgramming = msgAfterBracket.startsWith(PCODE_COMMANDS.RESET_PROGRAMMING);
        const isAppUploadFinish = msgAfterBracket.startsWith(PCODE_COMMANDS.APPUPLOADFINISH);
        if (!isUploadBlock && !isResetProgramming && !isAppUploadFinish)
            return;
        for (let i = 0; i < device.messageQueue.length; i++) {
            if (device.messageQueue[i].nonce === pendingMessage.nonce) {
                device.messageQueue.splice(i, 1);
                break;
            }
        }
        device.uploadRetries = (device.uploadRetries || 0) + 1;
        if (device.uploadRetries > MAX_UPLOAD_RETRIES) {
            logger.error(`Upload failed for ${mac} after ${device.uploadRetries} block-level retries`);
            this.stopApplicationUpload(mac);
            this.clearDeviceMessageQueue(mac);
            this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                mac: mac,
                method: 'tios',
            });
            this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                data: `Upload failed: device ${mac} not responding`,
                mac: mac,
            });
            return;
        }
        logger.info(`Upload message timed out for ${mac}, retrying (attempt ${device.uploadRetries}/${MAX_UPLOAD_RETRIES})`);
        this.clearDeviceMessageQueue(mac);
        if (isResetProgramming) {
            this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING, '', true);
        }
        else if (isAppUploadFinish) {
            this.sendToDevice(mac, PCODE_COMMANDS.APPUPLOADFINISH, '', true);
        }
        else {
            this.sendBlock(mac, device.fileIndex);
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
            let outputString = '';
            for (let t = 0; t < TRIES; t++) {
                try {
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
            return outputString;
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
        this.stopNetworkWatcher();
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
    PCODE_COMMANDS["RESET_PROGRAMMING_FIRMWARE"] = "QF";
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
    TIBBO_PROXY_MESSAGE["POLL_DEVICE"] = "poll_device";
})(TIBBO_PROXY_MESSAGE = exports.TIBBO_PROXY_MESSAGE || (exports.TIBBO_PROXY_MESSAGE = {}));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGlkZS1wcm94eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy90aWRlLXByb3h5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBK0I7QUFDL0IsMkNBQXlDO0FBQ3pDLDJDQUF1QztBQUN2QywyREFBd0Q7QUFDeEQsNkNBQW9FO0FBQ3BFLHNFQUE0QztBQUc1Qyx1REFBd0Q7QUFDeEQsa0RBQXNDO0FBQ3RDLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FBQyxlQUFlLENBQUMsQ0FBQztBQUNwQyxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekIsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQzdCLE1BQU0sT0FBTyxHQUFHLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUNuQyxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDM0IsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEVBQUUsaUJBQWlCLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztBQUN4RyxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekIsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQzdCLE1BQU0sRUFBRSxPQUFPLEVBQUUsR0FBRyxPQUFPLENBQUMsY0FBYyxDQUFDLENBQUM7QUFFNUMsTUFBTSxhQUFhLEdBQUcsRUFBRSxDQUFDO0FBQ3pCLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQztBQUduQixNQUFNLFFBQVEsR0FBRyxHQUFHLENBQUM7QUFDckIsTUFBTSxlQUFlLEdBQUcsR0FBRyxDQUFDO0FBQzVCLE1B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
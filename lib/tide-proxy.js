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
                        if (device.infoToken) {
                            device.infoToken.message = true;
                            device.infoToken.notify();
                        }
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
        const nonces = new Set();
        for (const msg of device.messageQueue) {
            if (msg.nonce) {
                nonces.add(msg.nonce);
            }
        }
        for (let j = this.pendingMessages.length - 1; j >= 0; j--) {
            if (nonces.has(this.pendingMessages[j].nonce)) {
                this.pendingMessages.splice(j, 1);
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
                const deviceInfo = yield this.getDeviceInfo(mac);
                if (deviceInfo.tios.indexOf('TiOS-32 Loader') >= 0) {
                    device.resetProgrammingToken = new Subject();
                    device.resetProgrammingToken.message = 'A';
                }
                else {
                    device.resetProgrammingToken = new Subject();
                    this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING, '', true);
                    yield device.resetProgrammingToken.wait(5000);
                }
                if (!device.resetProgrammingToken
                    || !device.resetProgrammingToken.message
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
                    if (!device.resetProgrammingToken
                        || !device.resetProgrammingToken.message
                        || device.resetProgrammingToken.message === 'F') {
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
    getDeviceInfo(mac) {
        return __awaiter(this, void 0, void 0, function* () {
            const device = this.getDevice(mac);
            device.infoToken = new Subject();
            this.sendToDevice(mac, PCODE_COMMANDS.INFO, '', true);
            yield device.infoToken.wait(5000);
            device.infoToken = undefined;
            return device;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGlkZS1wcm94eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy90aWRlLXByb3h5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBK0I7QUFDL0IsMkNBQXlDO0FBQ3pDLDJDQUF1QztBQUN2QywyREFBd0Q7QUFDeEQsNkNBQW9FO0FBQ3BFLHNFQUE0QztBQUc1Qyx1REFBd0Q7QUFDeEQsa0RBQXNDO0FBQ3RDLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FBQyxlQUFlLENBQUMsQ0FBQztBQUNwQyxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekIsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQzdCLE1BQU0sT0FBTyxHQUFHLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUNuQyxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDM0IsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLEVBQUUsaUJBQWlCLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztBQUN4RyxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekIsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQzdCLE1BQU0sRUFBRSxPQUFPLEVBQUUsR0FBRyxPQUFPLENBQUMsY0FBYyxDQUFDLENBQUM7QUFFNUMsTUFBTSxhQUFhLEdBQUcsRUFBRSxDQUFDO0FBQ3pCLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQztBQUduQixNQUFNLFFBQVEsR0FBRyxHQUFHLENBQUM7QUFDckIsTUFBTSxlQUFlLEdBQUcsR0FBRyxDQUFDO0FBQzVCLE1BQU0sY0FBYyxHQUFHLEdBQUcsQ0FBQztBQUUzQixNQUFNLFVBQVUsR0FBRyxHQUFHLENBQUM7QUFDdkIsTUFBTSxrQkFBa0IsR0FBRyxDQUFDLENBQUM7QUFDN0IsTUFBTSxtQkFBbUIsR0FBRyxDQUFDLENBQUM7QUFDOUIsTUFBTSxhQUFhLEdBQUcsS0FBSyxHQUFHLFVBQVUsQ0FBQztBQUN6QyxNQUFNLHVCQUF1QixHQUFHLElBQUksQ0FBQztBQUNyQyxNQUFNLG9CQUFvQixHQUFHLEdBQUcsQ0FBQztBQThCakMsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFDLFlBQVksQ0FBQztJQUNoQyxJQUFJLEVBQUUsY0FBYztJQUNwQixLQUFLLEVBQUUsTUFBTTtJQUNiLE1BQU0sRUFBRSxPQUFPLENBQUMsTUFBTSxDQUFDLE1BQU0sRUFBRTtJQUMvQixVQUFVLEVBQUU7UUFDUixJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDO1lBQzNCLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFrQixDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUk7U0FDeEQsQ0FBQztLQUVMO0NBQ0osQ0FBQyxDQUFDO0FBRUgsTUFBTSxxQkFBcUIsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLHFCQUFxQjtPQUN4RCxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxNQUFNLEVBQUUsRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztBQUU5RCxTQUFTLHdCQUF3QixDQUFDLEdBQVc7SUFDekMsSUFBSSxHQUFHLENBQUMsTUFBTSxJQUFJLENBQUMsSUFBSSxHQUFHLENBQUMsQ0FBQyxDQUFDLEtBQUssSUFBSSxJQUFJLEdBQUcsQ0FBQyxDQUFDLENBQUMsS0FBSyxJQUFJLElBQUksR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFLLElBQUksSUFBSSxHQUFHLENBQUMsQ0FBQyxDQUFDLEtBQUssSUFBSSxFQUFFO1FBQzdGLE9BQU8sS0FBSyxDQUFDO0tBQ2hCO0lBQ0QsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ1YsT0FBTyxDQUFDLEdBQUcsR0FBRyxDQUFDLE1BQU0sRUFBRTtRQUNuQixNQUFNLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDakIsSUFBSSxDQUFDLEtBQUssSUFBSSxJQUFJLENBQUMsS0FBSyxJQUFJLElBQUksQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLEtBQUssSUFBSSxFQUFFO1lBQ3RELENBQUMsRUFBRSxDQUFDO1lBQ0osU0FBUztTQUNaO1FBQ0QsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxNQUFNLElBQUksR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFLLElBQUksSUFBSSxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLElBQUksSUFBSSxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLElBQUksRUFBRTtZQUNyRixDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ1AsU0FBUztTQUNaO1FBQ0QsTUFBTTtLQUNUO0lBQ0QsSUFBSSxDQUFDLEdBQUcsR0FBRyxDQUFDLE1BQU0sSUFBSSxHQUFHLENBQUMsQ0FBQyxDQUFDLEtBQUssSUFBSSxFQUFFO1FBQ25DLE9BQU8sS0FBSyxDQUFDO0tBQ2hCO0lBQ0QsT0FBTyxLQUFLLENBQUM7QUFDakIsQ0FBQztBQUdELFNBQVMsNkJBQTZCO0lBQ2xDLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLEVBQUUsV0FBVyxDQUFDLENBQUM7QUFDakQsQ0FBQztBQUVELE1BQWEsU0FBUztJQXFCbEIsWUFDSSx5QkFBb0QsRUFBRSxFQUN0RCxTQUFrQixFQUNsQixPQUFlLElBQUksRUFDbkIsZUFBd0IsRUFDeEIsT0FBMEI7UUF6QjlCLFlBQU8sR0FBdUIsRUFBRSxDQUFDO1FBQ2pDLG9CQUFlLEdBQXNCLEVBQUUsQ0FBQztRQUV4QyxlQUFVLEdBQThCLEVBQUUsQ0FBQztRQUMzQyxxQkFBZ0IsR0FBbUMsU0FBUyxDQUFDO1FBRzdELGdCQUFXLEdBQTJCLEVBQUUsQ0FBQztRQUN6QyxzQkFBaUIsR0FBOEIsRUFBRSxDQUFDO1FBSWxELGtCQUFhLEdBQW9DLEVBQUUsQ0FBQztRQUNwRCxTQUFJLEdBQVUsRUFBRSxDQUFDO1FBRWpCLHVCQUFrQixHQUFXLEVBQUUsQ0FBQztRQWE1QixJQUFJLGFBQXFCLENBQUM7UUFDMUIsSUFBSSxlQUF1QixDQUFDO1FBQzVCLElBQUksVUFBa0IsQ0FBQztRQUN2QixJQUFJLHFCQUF5QyxDQUFDO1FBQzlDLElBQUksU0FBNkIsQ0FBQztRQUVsQyxJQUFJLE9BQU8sc0JBQXNCLEtBQUssUUFBUSxFQUFFO1lBRTVDLGFBQWEsR0FBRyxzQkFBc0IsQ0FBQyxhQUFhLElBQUksRUFBRSxDQUFDO1lBQzNELGVBQWUsR0FBRyxzQkFBc0IsQ0FBQyxTQUFTLElBQUksRUFBRSxDQUFDO1lBQ3pELFVBQVUsR0FBRyxzQkFBc0IsQ0FBQyxJQUFJLElBQUksSUFBSSxDQUFDO1lBQ2pELHFCQUFxQixHQUFHLHNCQUFzQixDQUFDLGVBQWUsQ0FBQztZQUMvRCxTQUFTLEdBQUcsc0JBQXNCLENBQUMsU0FBUyxJQUFJLEVBQUUsQ0FBQztTQUN0RDthQUFNO1lBRUgsYUFBYSxHQUFHLHNCQUFzQixDQUFDO1lBQ3ZDLGVBQWUsR0FBRyxTQUFTLElBQUksRUFBRSxDQUFDO1lBQ2xDLFVBQVUsR0FBRyxJQUFJLENBQUM7WUFDbEIscUJBQXFCLEdBQUcsZUFBZSxDQUFDO1lBQ3hDLFNBQVMsR0FBRyxDQUFBLE9BQU8sYUFBUCxPQUFPLHVCQUFQLE9BQU8sQ0FBRSxTQUFTLEtBQUksRUFBRSxDQUFDO1NBQ3hDO1FBR0QsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLFFBQVEsS0FBSyxPQUFPLENBQUM7UUFDL0MsSUFBSSxDQUFDLFNBQVMsR0FBRztZQUNiLE9BQU8sRUFBRSxTQUFTLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztZQUNyRSxNQUFNLEVBQUUsU0FBUyxDQUFDLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7WUFDakUsS0FBSyxFQUFFLFNBQVMsQ0FBQyxLQUFLLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDO1NBQ3RFLENBQUM7UUFFRixJQUFJLENBQUMsRUFBRSxHQUFHLElBQUksSUFBSSxFQUFFLENBQUMsT0FBTyxFQUFFLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDMUMsSUFBSSxDQUFDLFVBQVUsR0FBRyxVQUFVLENBQUM7UUFDN0IsSUFBSSxDQUFDLGNBQWMsQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO1FBQzNDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO1FBRWhELElBQUksYUFBYSxJQUFJLEVBQUUsRUFBRTtZQUNyQixJQUFJLENBQUMsU0FBUyxDQUFDLGFBQWEsRUFBRSxlQUFlLENBQUMsQ0FBQztTQUNsRDtRQUNELElBQUksQ0FBQyxNQUFNLEdBQUcsRUFBRSxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUM3QixJQUFJLENBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNsQixJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxZQUFZLEVBQUUsQ0FBQyxTQUFjLEVBQUUsRUFBRTtZQUM1QyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztZQUM3QixNQUFNLENBQUMsSUFBSSxDQUFDLDRCQUE0QixDQUFDLENBQUM7WUFDMUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLFNBQVMsQ0FBQyxDQUFDO1lBQ2xDLFNBQVMsQ0FBQyxFQUFFLENBQUMsT0FBTyxFQUFFLEdBQUcsRUFBRTtnQkFDdkIsTUFBTSxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQztnQkFDN0IsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO1lBQy9ELENBQUMsQ0FBQyxDQUFDO1FBQ1AsQ0FBQyxDQUFDLENBQUM7UUFFSCxFQUFFLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQzFCLENBQUM7SUFFRCxjQUFjLENBQUMsa0JBQXVCLEVBQUU7UUFDcEMsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDLGlCQUFpQixFQUFFLENBQUM7UUFHdEMsSUFBSSxDQUFDLHNCQUFzQixFQUFFLENBQUM7UUFHOUIsTUFBTSxhQUFhLEdBQUcsQ0FBQyxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUMzQyxJQUFJLENBQUMsVUFBVSxHQUFHLEVBQUUsQ0FBQztRQUdyQixLQUFLLE1BQU0sR0FBRyxJQUFJLE1BQU0sRUFBRTtZQUN0QixNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDMUIsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUU7Z0JBQ25DLE1BQU0sR0FBRyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDckIsSUFBSSxHQUFHLENBQUMsTUFBTSxJQUFJLE1BQU0sSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUU7b0JBQ3ZDLElBQUk7d0JBQ0EsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLFlBQVksQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7d0JBRXJFLE1BQU0sQ0FBQyxFQUFFLENBQUMsT0FBTyxFQUFFLEdBQUcsRUFBRTs0QkFDcEIsTUFBTSxDQUFDLElBQUksQ0FBQyxvQkFBb0IsR0FBRyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7d0JBQ3BELENBQUMsQ0FBQyxDQUFDO3dCQUVILE1BQU0sQ0FBQyxFQUFFLENBQUMsT0FBTyxFQUFFLENBQUMsR0FBRyxFQUFFLEVBQUU7NEJBQ3ZCLE1BQU0sQ0FBQyxLQUFLLENBQUMsdUJBQXVCLEdBQUcsQ0FBQyxPQUFPLE1BQU0sR0FBRyxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUM7NEJBQ2xFLE1BQU0sQ0FBQyxLQUFLLEVBQUUsQ0FBQzt3QkFDbkIsQ0FBQyxDQUFDLENBQUM7d0JBRUgsTUFBTSxDQUFDLEVBQUUsQ0FBQyxTQUFTLEVBQUUsQ0FBQyxHQUFXLEVBQUUsSUFBSSxFQUFFLEVBQUU7NEJBQ3ZDLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxHQUFHLENBQUMsQ0FBQzt3QkFDdkMsQ0FBQyxDQUFDLENBQUM7d0JBRUgsTUFBTSxDQUFDLEVBQUUsQ0FBQyxXQUFXLEVBQUUsR0FBRyxFQUFFOzRCQUN4QixNQUFNLENBQUMsSUFBSSxDQUFDLGVBQWUsR0FBRyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7d0JBQy9DLENBQUMsQ0FBQyxDQUFDO3dCQUVILE1BQU0sR0FBRyxHQUF1Qjs0QkFDNUIsTUFBTSxFQUFFLE1BQU07NEJBQ2QsWUFBWSxFQUFFLEdBQUc7eUJBQ3BCLENBQUM7d0JBR0YsTUFBTSxDQUFDLElBQUksQ0FBQzs0QkFDUixPQUFPLEVBQUUsR0FBRyxDQUFDLE9BQU87eUJBQ3ZCLEVBQUUsR0FBRyxFQUFFOzRCQUNKLE1BQU0sQ0FBQyxJQUFJLENBQUMsbUJBQW1CLEdBQUcsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDOzRCQUMvQyxNQUFNLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDO3dCQUM5QixDQUFDLENBQUMsQ0FBQzt3QkFFSCxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQzt3QkFFMUIsSUFBSSxlQUFlLElBQUksR0FBRyxJQUFJLGVBQWUsRUFBRTs0QkFDM0MsSUFBSSxDQUFDLGdCQUFnQixHQUFHLEdBQUcsQ0FBQzt5QkFDL0I7cUJBQ0o7b0JBQUMsT0FBTyxHQUFRLEVBQUU7d0JBQ2YsTUFBTSxDQUFDLEtBQUssQ0FBQyxrQ0FBa0MsR0FBRyxDQUFDLE9BQU8sR0FBRyxFQUFFLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztxQkFDL0U7aUJBQ0o7YUFDSjtTQUNKO1FBR0QsSUFBSSxDQUFDLG9CQUFvQixDQUFDLGFBQWEsQ0FBQyxDQUFDO0lBQzdDLENBQUM7SUFFTyxzQkFBc0I7UUFFMUIsSUFBSSxJQUFJLENBQUMsS0FBSyxFQUFFO1lBQ1osYUFBYSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUMxQixJQUFJLENBQUMsS0FBSyxHQUFHLFNBQVMsQ0FBQztTQUMxQjtRQUdELElBQUksQ0FBQyxlQUFlLEdBQUcsRUFBRSxDQUFDO0lBQzlCLENBQUM7SUFFTyxvQkFBb0IsQ0FBQyxhQUFtQztRQUU1RCxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQ1osYUFBYSxDQUFDLE9BQU8sQ0FBQyxDQUFDLFlBQVksRUFBRSxLQUFLLEVBQUUsRUFBRTtnQkFDMUMsSUFBSTtvQkFDQSxJQUFJLFlBQVksQ0FBQyxNQUFNLEVBQUU7d0JBQ3JCLFlBQVksQ0FBQyxNQUFNLENBQUMsa0JBQWtCLEVBQUUsQ0FBQzt3QkFDekMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxLQUFLLEVBQUUsQ0FBQztxQkFDL0I7aUJBQ0o7Z0JBQUMsT0FBTyxHQUFRLEVBQUU7b0JBQ2YsTUFBTSxDQUFDLEtBQUssQ0FBQyw0QkFBNEIsS0FBSyxHQUFHLEVBQUUsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO2lCQUNuRTtZQUNMLENBQUMsQ0FBQyxDQUFDO1FBQ1AsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBQ1osQ0FBQztJQUVPLGlCQUFpQjtRQUNyQixNQUFNLE1BQU0sR0FBRyxFQUFFLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztRQUN0QyxNQUFNLEtBQUssR0FBYSxFQUFFLENBQUM7UUFDM0IsS0FBSyxNQUFNLEdBQUcsSUFBSSxNQUFNLEVBQUU7WUFDdEIsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQzFCLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO2dCQUNuQyxNQUFNLEdBQUcsR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQ3JCLElBQUksR0FBRyxDQUFDLE1BQU0sSUFBSSxNQUFNLElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxFQUFFO29CQUN2QyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxPQUFPLElBQUksR0FBRyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7aUJBQ3REO2FBQ0o7U0FDSjtRQUNELE9BQU8sS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNsQyxDQUFDO0lBRU8sbUJBQW1CLENBQUMsZUFBd0I7UUFFaEQsSUFBSSxDQUFDLGtCQUFrQixHQUFHLElBQUksQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO1FBR25ELElBQUksQ0FBQyxtQkFBbUIsR0FBRyxXQUFXLENBQUMsR0FBRyxFQUFFO1lBQ3hDLE1BQU0sWUFBWSxHQUFHLElBQUksQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO1lBQzlDLElBQUksWUFBWSxLQUFLLElBQUksQ0FBQyxrQkFBa0IsRUFBRTtnQkFDMUMsTUFBTSxDQUFDLElBQUksQ0FBQyxpRUFBaUUsQ0FBQyxDQUFDO2dCQUMvRSxJQUFJLENBQUMsa0JBQWtCLEdBQUcsWUFBWSxDQUFDO2dCQUN2QyxJQUFJLENBQUMsY0FBYyxDQUFDLGVBQWUsQ0FBQyxDQUFDO2FBQ3hDO1FBQ0wsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ2IsQ0FBQztJQUVPLGtCQUFrQjtRQUN0QixJQUFJLElBQUksQ0FBQyxtQkFBbUIsRUFBRTtZQUMxQixhQUFhLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLENBQUM7WUFDeEMsSUFBSSxDQUFDLG1CQUFtQixHQUFHLFNBQVMsQ0FBQztTQUN4QztJQUNMLENBQUM7SUFFRCxZQUFZLENBQUMsZUFBdUI7UUFFaEMsSUFBSSxDQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7UUFDbEIsSUFBSSxDQUFDLGlCQUFpQixHQUFHLEVBQUUsQ0FBQztRQUc1QixJQUFJLENBQUMsZUFBZSxFQUFFO1lBQ2xCLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxTQUFTLENBQUM7WUFDbEMsT0FBTztTQUNWO1FBR0QsSUFBSSxDQUFDLGNBQWMsQ0FBQyxlQUFlLENBQUMsQ0FBQztJQW1CekMsQ0FBQztJQUVELGlCQUFpQixDQUFDLE1BQVc7UUFDekIsTUFBTSxDQUFDLEVBQUUsQ0FBQyxZQUFZLEVBQUUsR0FBRyxFQUFFO1lBQ3pCLE1BQU0sQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDakMsQ0FBQyxDQUFDLENBQUM7UUFDSCxNQUFNLENBQUMsRUFBRSxDQUFDLGVBQWUsRUFBRSxDQUFDLEtBQVUsRUFBRSxFQUFFO1lBQ3RDLE1BQU0sQ0FBQyxLQUFLLENBQUMsa0JBQWtCLEdBQUcsS0FBSyxDQUFDLENBQUM7UUFDN0MsQ0FBQyxDQUFDLENBQUM7UUFFSCxNQUFNLENBQUMsRUFBRSxDQUFDLG1CQUFtQixDQUFDLE9BQU8sRUFBRSxDQUFDLE9BQXFCLEVBQUUsRUFBRTtZQUM3RCxJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7UUFDekIsQ0FBQyxDQUFDLENBQUM7UUFFSCxNQUFNLENBQUMsRUFBRSxDQUFDLG1CQUFtQixDQUFDLElBQUksRUFBRSxDQUFDLE9BQXFCLEVBQUUsRUFBRTtZQUMxRCxJQUFJLENBQUMsWUFBWSxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsY0FBYyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQztRQUM1RCxDQUFDLENBQUMsQ0FBQztRQUNILE1BQU0sQ0FBQyxFQUFFLENBQUMsbUJBQW1CLENBQUMsTUFBTSxFQUFFLENBQUMsT0FBcUIsRUFBRSxFQUFFO1lBQzVELElBQUksQ0FBQyxxQkFBcUIsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDeEMsSUFBSSxDQUFDLFlBQVksQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLGNBQWMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3JFLENBQUMsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxDQUFDLEVBQUUsQ0FBQyxtQkFBbUIsQ0FBQyxrQkFBa0IsRUFBRSxDQUFDLE9BQVksRUFBRSxFQUFFO1lBQy9ELElBQUksQ0FBQyxzQkFBc0IsQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLGdCQUFnQixFQUFFLE9BQU8sQ0FBQyxNQUFNLEVBQUUsT0FBTyxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDdEksQ0FBQyxDQUFDLENBQUM7UUFDSCxNQUFNLENBQUMsRUFBRSxDQUFDLG1CQUFtQixDQUFDLE9BQU8sRUFBRSxDQUFDLE9BQXFCLEVBQUUsRUFBRTtZQUM3RCxJQUFJLENBQUMsWUFBWSxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsT0FBTyxDQUFDLE9BQU8sRUFBRSxPQUFPLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkYsQ0FBQyxDQUFDLENBQUM7UUFDSCxNQUFNLENBQUMsRUFBRSxDQUFDLG1CQUFtQixDQUFDLElBQUksRUFBRSxDQUFDLE9BQW9CLEVBQUUsRUFBRTtZQUN6RCxJQUFJLENBQUMsZUFBZSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ2xDLENBQUMsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxDQUFDLEVBQUUsQ0FBQyxtQkFBbUIsQ0FBQyx1QkFBdUIsRUFBRSxJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO1FBQ3RGLE1BQU0sQ0FBQyxFQUFFLENBQUMsbUJBQW1CLENBQUMsYUFBYSxFQUFFLENBQUMsT0FBWSxFQUFFLEVBQUU7WUFDMUQsTUFBTSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsS0FBSyxFQUFFLEdBQUcsT0FBTyxDQUFDO1lBQzFDLElBQUksQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUM3QyxDQUFDLENBQUMsQ0FBQztRQUNILE1BQU0sQ0FBQyxFQUFFLENBQUMsbUJBQW1CLENBQUMsYUFBYSxFQUFFLENBQUMsT0FBWSxFQUFFLEVBQUU7WUFDMUQsTUFBTSxFQUFFLElBQUksRUFBRSxHQUFHLE9BQU8sQ0FBQztZQUN6QixJQUFJLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzVCLENBQUMsQ0FBQyxDQUFDO1FBRUgsTUFBTSxDQUFDLEVBQUUsQ0FBQyxtQkFBbUIsQ0FBQyxRQUFRLEVBQUUsQ0FBTyxPQUFZLEVBQUUsRUFBRTtZQUMzRCxNQUFNLEVBQUUsT0FBTyxFQUFFLEdBQUcsRUFBRSxLQUFLLEVBQUUsR0FBRyxPQUFPLENBQUM7WUFDeEMsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFRLEVBQUUsRUFBRSxDQUFDLEdBQUcsQ0FBQyxPQUFPLEtBQUssT0FBTyxDQUFDLENBQUM7WUFDbEUsSUFBSSxHQUFHLEVBQUU7Z0JBQ0wsSUFBSTtvQkFDQSxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWMsR0FBRyxDQUFDLEVBQUUsUUFBUSxHQUFHLFVBQVUsS0FBSyxFQUFFLENBQUMsQ0FBQztvQkFDOUQsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQzt3QkFDNUIsZUFBZSxFQUFFLEdBQUc7d0JBQ3BCLFVBQVUsRUFBRSxLQUFLO3FCQUNwQixDQUFDLENBQUM7b0JBQ0gsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQzt3QkFDcEIsUUFBUSxFQUFFLEdBQUcsQ0FBQyxFQUFFO3dCQUNoQixJQUFJLEVBQUUsS0FBSzt3QkFDWCxJQUFJLEVBQUUsT0FBTzt3QkFDYixNQUFNLEVBQUUsTUFBTTt3QkFDZCxPQUFPLEVBQUU7NEJBQ0wsY0FBYyxFQUFFLGtCQUFrQjs0QkFDbEMsZ0JBQWdCLEVBQUUsUUFBUSxDQUFDLE1BQU07eUJBQ3BDO3FCQUNKLENBQUMsQ0FBQztvQkFDSCxFQUFFLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDO29CQUNuQixFQUFFLENBQUMsR0FBRyxFQUFFLENBQUM7aUJBQ1o7Z0JBQUMsT0FBTyxFQUFFLEVBQUU7b0JBQ1QsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQztpQkFDbkI7YUFDSjtRQUNMLENBQUMsQ0FBQSxDQUFDLENBQUM7UUFFSCxNQUFNLENBQUMsRUFBRSxDQUFDLG1CQUFtQixDQUFDLFlBQVksRUFBRSxDQUFPLE9BQVksRUFBRSxFQUFFO1lBQy9ELE1BQU0sRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLEdBQUcsT0FBTyxDQUFDO1lBQ25DLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBUSxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsT0FBTyxLQUFLLE9BQU8sQ0FBQyxDQUFDO1lBQ2xFLElBQUksR0FBRyxFQUFFO2dCQUNMLElBQUk7b0JBQ0EsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFjLEdBQUcsQ0FBQyxFQUFFLGVBQWUsS0FBSyxFQUFFLENBQUMsQ0FBQztvQkFDeEQsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQzt3QkFDNUIsZ0JBQWdCLEVBQUUsS0FBSztxQkFDMUIsQ0FBQyxDQUFDO29CQUNILE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUM7d0JBQ3BCLFFBQVEsRUFBRSxHQUFHLENBQUMsRUFBRTt3QkFDaEIsSUFBSSxFQUFFLEtBQUs7d0JBQ1gsSUFBSSxFQUFFLFVBQVU7d0JBQ2hCLE1BQU0sRUFBRSxNQUFNO3dCQUNkLE9BQU8sRUFBRTs0QkFDTCxjQUFjLEVBQUUsa0JBQWtCOzRCQUNsQyxnQkFBZ0IsRUFBRSxRQUFRLENBQUMsTUFBTTt5QkFDcEM7cUJBQ0osQ0FBQyxDQUFDO29CQUNILEVBQUUsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUM7b0JBQ25CLEVBQUUsQ0FBQyxHQUFHLEVBQUUsQ0FBQztpQkFDWjtnQkFBQyxPQUFPLEVBQUUsRUFBRTtvQkFDVCxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO2lCQUNuQjthQUNKO1FBQ0wsQ0FBQyxDQUFBLENBQUMsQ0FBQztRQUVILE1BQU0sQ0FBQyxFQUFFLENBQUMsbUJBQW1CLENBQUMsV0FBVyxFQUFFLENBQUMsT0FBWSxFQUFFLEVBQUU7WUFDeEQsTUFBTSxFQUFFLEdBQUcsRUFBRSxHQUFHLE9BQU8sQ0FBQztZQUN4QixJQUFJLEdBQUcsRUFBRTtnQkFDTCxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNuQyxJQUFJLE1BQU0sRUFBRTtvQkFDUixNQUFNLENBQUMsUUFBUSxHQUFHLElBQUksSUFBSSxFQUFFLENBQUMsT0FBTyxFQUFFLENBQUM7b0JBQ3ZDLElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxFQUFFLGNBQWMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7aUJBQ3BEO2FBQ0o7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNQLENBQUM7SUFFRCxTQUFTLENBQUMsYUFBcUIsRUFBRSxTQUFpQjtRQUM5QyxJQUFJLElBQUksQ0FBQyxNQUFNLEVBQUU7WUFDYixJQUFJLENBQUMsTUFBTSxDQUFDLGtCQUFrQixFQUFFLENBQUM7WUFDakMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLEVBQUUsQ0FBQztTQUN2QjtRQUNELE1BQU0sU0FBUyxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDM0MsSUFBSSxZQUFZLEdBQUcsWUFBWSxDQUFDO1FBQ2hDLElBQUksU0FBUyxDQUFDLElBQUksSUFBSSxHQUFHLEVBQUU7WUFDdkIsWUFBWSxHQUFHLFNBQVMsQ0FBQyxJQUFJLEdBQUcsWUFBWSxDQUFDO1NBQ2hEO1FBQ0QsSUFBSSxDQUFDLE1BQU0sR0FBRyxxQkFBYyxDQUFDLFNBQVMsQ0FBQyxRQUFRLEdBQUcsSUFBSSxHQUFHLFNBQVMsQ0FBQyxJQUFJLEdBQUcsVUFBVSxFQUFFO1lBQ2xGLElBQUksRUFBRSxZQUFZO1lBQ2xCLEtBQUssRUFBRSxLQUFLO1lBQ1osa0JBQWtCLEVBQUUsS0FBSztTQUM1QixDQUFDLENBQUM7UUFDSCxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxTQUFTLEVBQUUsR0FBRyxFQUFFO1lBQzNCLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsUUFBUSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1lBQ25ELE1BQU0sQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDOUIsQ0FBQyxDQUFDLENBQUM7UUFDSCxJQUFJLENBQUMsaUJBQWlCLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3hDLENBQUM7SUFFRCxPQUFPLENBQUMsSUFBVztRQUNmLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO0lBQ3JCLENBQUM7SUFFRCxhQUFhO1FBQ1QsTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxjQUFjLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDakQsSUFBSSxDQUFDLGlCQUFpQixHQUFHLEVBQUUsQ0FBQztRQUM1QixJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ2YsSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO0lBQzFCLENBQUM7SUFFRCxhQUFhLENBQUMsT0FBcUI7UUFDL0IsSUFBSSxPQUFPLENBQUMsR0FBRyxFQUFFO1lBQ2IsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDM0MsTUFBTSxDQUFDLGlCQUFpQixHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7U0FDbkQ7SUFDTCxDQUFDO0lBRUQsYUFBYSxDQUFDLEdBQVcsRUFBRSxJQUFTLEVBQUUsTUFBMEI7O1FBQzVELE1BQU0sT0FBTyxHQUFHLEdBQUcsQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUMvQixNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDM0YsSUFBSSxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsSUFBSSxHQUFHLEVBQUU7WUFDN0IsT0FBTztTQUNWO1FBQ0QsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLElBQUksSUFBSSxFQUFFLENBQUMsa0JBQWtCLEVBQUUsVUFBVSxPQUFPLEVBQUUsQ0FBQyxDQUFDO1FBQ25FLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO1lBQ25DLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxFQUFFLENBQUM7U0FDMUM7UUFFRCxNQUFNLEdBQUcsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzVCLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDbkMsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNuQyxJQUFJLE1BQU0sQ0FBQyxFQUFFLElBQUksRUFBRSxFQUFFO1lBQ2pCLE1BQU0sQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDO1NBQ2xCO1FBQ0QsTUFBTSxDQUFDLGVBQWUsR0FBRyxNQUFNLENBQUM7UUFFaEMsTUFBTSxVQUFVLEdBQUcsT0FBTyxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBQy9ELE1BQU0sV0FBVyxHQUFHLFVBQVUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDN0MsSUFBSSxRQUFRLEdBQTZCLFNBQVMsQ0FBQztRQUVuRCxNQUFNLFVBQVUsR0FBRyxVQUFVLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzVDLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxNQUFNLENBQUMsWUFBWSxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtZQUNqRCxJQUFJLE1BQU0sQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxJQUFJLFVBQVUsRUFBRTtnQkFDNUMsUUFBUSxHQUFHLE1BQU0sQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDL0MsQ0FBQyxFQUFFLENBQUM7YUFDUDtTQUNKO1FBT0QsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQyxlQUFlLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO1lBQ2xELElBQUksSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLElBQUksVUFBVSxFQUFFO2dCQUM3QyxJQUFJLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQ3JDLENBQUMsRUFBRSxDQUFDO2FBQ1A7U0FDSjtRQUNELE1BQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsT0FBTyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztRQUNwRixJQUFJLFNBQVMsQ0FBQztRQUVkLElBQUksSUFBSSxDQUFDLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxJQUFJLFNBQVMsRUFBRTtZQUMxQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsR0FBRyxDQUFDLEdBQUcsR0FBRyxDQUFDO1lBQ2xDLE1BQU0sQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDO1lBQ2YsTUFBTSxDQUFDLEdBQUcsR0FBRyxHQUFHLENBQUM7WUFDakIsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFRLEVBQUUsRUFBRSxDQUFDLEdBQUcsQ0FBQyxPQUFPLEtBQUssR0FBRyxDQUFDLENBQUM7WUFDOUQsSUFBSSxHQUFHLEVBQUU7Z0JBQ0wsTUFBTSxDQUFDLFNBQVMsR0FBRyxHQUFHLENBQUMsU0FBUyxDQUFDO2FBQ3BDO1lBQ0QsSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLEVBQUUsY0FBYyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQztZQUNoRCxPQUFPO1NBQ1Y7UUFFRCxJQUFJLEtBQUssSUFBSSxTQUFTLEVBQUU7WUFDcEIsTUFBTSxRQUFRLEdBQWU7Z0JBQ3pCLEdBQUcsRUFBRSxHQUFHO2dCQUNSLElBQUksRUFBRSxXQUFXO2dCQUNqQixLQUFLLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7Z0JBQ2xELEtBQUssRUFBRSxVQUFVO2FBQ3BCLENBQUE7WUFDRCxJQUFJLGVBQWUsR0FBRyxFQUFFLENBQUM7WUFDekIsSUFBSSxRQUFRLElBQUksU0FBUyxFQUFFO2dCQUN2QixlQUFlLEdBQUcsUUFBUSxDQUFDLE9BQU8sQ0FBQzthQUN0QztpQkFDSTtnQkFDRCxJQUFJLENBQUMsVUFBVSxJQUFJLE1BQU0sQ0FBQyxlQUFlLEdBQUcsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxJQUFJLEVBQUU7b0JBQzFELGVBQWUsR0FBRyxjQUFjLENBQUMsTUFBTSxDQUFDO2lCQUMzQzthQUNKO1lBQ0QsUUFBUSxDQUFDLFFBQVEsR0FBRyxlQUFlLENBQUM7WUFDcEMsUUFBUSxRQUFRLENBQUMsUUFBUSxFQUFFO2dCQUN2QixLQUFLLGNBQWMsQ0FBQyxNQUFNO29CQUV0QixNQUFNO2dCQUNWO29CQUNJLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsS0FBSyxFQUFFLFFBQVEsQ0FBQyxDQUFDO29CQUMvQyxNQUFNO2FBQ2I7WUFDRCxJQUFJLFdBQVcsR0FBRyxFQUFFLENBQUM7WUFFckIsSUFBSSxlQUFlLElBQUksY0FBYyxDQUFDLFVBQVUsRUFBRTtnQkFDOUMsSUFBSSxNQUFNLENBQUMsaUJBQWlCLElBQUksU0FBUyxFQUFFO29CQUN2QyxNQUFNLEtBQUssR0FBRyxRQUFRLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7b0JBQzdDLE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssRUFBRSxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsV0FBVyxFQUFFLENBQUM7b0JBQ3hFLE1BQU0sS0FBSyxHQUFHLFFBQVEsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO29CQUMxQyxJQUFJLElBQUksQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLElBQUksU0FBUyxFQUFFO3dCQUN4QyxJQUFJLEtBQUssSUFBSSxTQUFTLEVBQUU7NEJBQ3BCLElBQUksQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLENBQUMsT0FBTyxHQUFHLEtBQUssQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7NEJBQ3JELElBQUksQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUM7eUJBQ3RDO3FCQUNKO2lCQUNKO2FBQ0o7WUFFRCxRQUFRLGVBQWUsRUFBRTtnQkFDckIsS0FBSyxjQUFjLENBQUMsSUFBSTtvQkFDcEI7d0JBQ0ksTUFBTSxLQUFLLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQzt3QkFDckMsTUFBTSxDQUFDLElBQUksR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7d0JBQ3ZCLE1BQU0sQ0FBQyxHQUFHLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUN0QixNQUFNLENBQUMsVUFBVSxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQzt3QkFDN0IsTUFBTSxDQUFDLElBQUksR0FBRyxNQUFNLENBQUM7d0JBQ3JCLElBQUksTUFBTSxDQUFDLFNBQVMsRUFBRTs0QkFDbEIsTUFBTSxDQUFDLFNBQVMsQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDOzRCQUNoQyxNQUFNLENBQUMsU0FBUyxDQUFDLE1BQU0sRUFBRSxDQUFDO3lCQUM3Qjt3QkFDRCxJQUFJLENBQUMsWUFBWSxDQUFDLEdBQUcsRUFBRSxjQUFjLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO3FCQUNwRDtvQkFDRCxNQUFNO2dCQUNWLEtBQUssY0FBYyxDQUFDLEtBQUs7b0JBQ3JCLE1BQU0sQ0FBQyxjQUFjLEdBQUcsU0FBUyxDQUFDO29CQUNsQyxJQUFJLENBQUMscUJBQXFCLENBQUMsR0FBRyxDQUFDLENBQUM7b0JBQ2hDLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxHQUFHLENBQUMsQ0FBQztvQkFDbEMsTUFBTTtnQkFDVixLQUFLLGNBQWMsQ0FBQyxHQUFHLENBQUM7Z0JBQ3hCLEtBQUssY0FBYyxDQUFDLElBQUksQ0FBQztnQkFDekIsS0FBSyxjQUFjLENBQUMsV0FBVztvQkFDM0IsV0FBVyxHQUFHLFdBQVcsQ0FBQztvQkFDMUIsSUFBSSxlQUFlLElBQUksY0FBYyxDQUFDLEdBQUc7MkJBQ2xDLGVBQWUsSUFBSSxjQUFjLENBQUMsSUFBSSxFQUMzQzt3QkFDRSxNQUFNLENBQUMsY0FBYyxHQUFHLFFBQVEsQ0FBQzt3QkFDakMsSUFBSSxNQUFNLENBQUMsSUFBSSxFQUFFOzRCQUNiLElBQUksQ0FBQyxxQkFBcUIsQ0FBQyxHQUFHLENBQUMsQ0FBQzt5QkFDbkM7cUJBQ0o7b0JBQ0QsTUFBTTtnQkFDVixLQUFLLGNBQWMsQ0FBQyxLQUFLO29CQUNyQjt3QkFDSSxJQUFJLFFBQVEsS0FBSyxTQUFTLEVBQUU7NEJBQ3hCLE1BQU0sQ0FBQyxRQUFRLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQyxPQUFPLEVBQUUsQ0FBQzt5QkFDMUM7d0JBQ0QsTUFBTSxVQUFVLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQzt3QkFDMUMsTUFBTSxFQUFFLEdBQUcsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUN6QixJQUFJLFdBQVcsR0FBRyxXQUFXLENBQUMsT0FBTyxDQUFDO3dCQUN0QyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxHQUFHLEVBQUU7NEJBQ2QsV0FBVyxHQUFHLFdBQVcsQ0FBQyxPQUFPLENBQUM7eUJBQ3JDOzZCQUNJLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEdBQUcsRUFBRTs0QkFDbkIsV0FBVyxHQUFHLFdBQVcsQ0FBQyxNQUFNLENBQUM7eUJBQ3BDO3dCQU1ELE1BQU0sQ0FBQyxLQUFLLEdBQUcsV0FBVyxDQUFDO3dCQUMzQixJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLE1BQU0sRUFBRTs0QkFDbEMsRUFBRSxFQUFFLE1BQU0sQ0FBQyxFQUFFOzRCQUNiLEdBQUcsRUFBRSxNQUFNLENBQUMsR0FBRzs0QkFDZixJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUk7NEJBQ2pCLEdBQUcsRUFBRSxNQUFNLENBQUMsR0FBRzs0QkFDZixLQUFLLEVBQUUsTUFBTSxDQUFDLEtBQUs7NEJBQ25CLFVBQVUsRUFBRSxNQUFNLENBQUMsVUFBVTs0QkFDN0IsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJOzRCQUNqQixTQUFTLEVBQUUsTUFBTSxDQUFDLFNBQVM7eUJBQzlCLENBQUMsQ0FBQzt3QkFFSCxXQUFXLEdBQUcsV0FBVyxDQUFDO3FCQUM3QjtvQkFDRCxNQUFNO2dCQUNWLEtBQUssY0FBYyxDQUFDLE1BQU07b0JBQUU7d0JBQ3hCLE1BQU0sU0FBUyxHQUFHLE1BQU0sR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsTUFBTSxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO3dCQUNuRixLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsTUFBTSxDQUFDLFlBQVksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUU7NEJBQ2pELElBQUksTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksY0FBYyxDQUFDLE1BQU0sRUFBRTtnQ0FDekQsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQztnQ0FDaEUsTUFBTSxZQUFZLEdBQUcsTUFBTSxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsTUFBTSxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztnQ0FDOUQsSUFBSSxZQUFZLEtBQUssU0FBUyxFQUFFO29DQUM1QixTQUFTO2lDQUNaO2dDQUNELEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxJQUFJLENBQUMsZUFBZSxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtvQ0FDbEQsSUFBSSxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssSUFBSSxNQUFNLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssRUFBRTt3Q0FDL0QsSUFBSSxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO3dDQUNsQyxDQUFDLEVBQUUsQ0FBQztxQ0FDUDtpQ0FDSjtnQ0FDRCxRQUFRLEdBQUcsTUFBTSxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dDQUMvQyxDQUFDLEVBQUUsQ0FBQzs2QkFDUDt5QkFDSjt3QkFDRCxJQUFJLFFBQVEsS0FBSyxTQUFTLEVBQUU7NEJBQ3hCLE9BQU87eUJBQ1Y7d0JBQ0QsSUFBSSxLQUFLLEtBQUssUUFBUSxFQUFFOzRCQUNwQixPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixNQUFNLENBQUMsU0FBUyxlQUFlLEdBQUcsRUFBRSxDQUFDLENBQUM7NEJBQ2xFLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxHQUFHLENBQUMsQ0FBQzs0QkFDbEMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUUsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDOzRCQUN0QyxPQUFPO3lCQUNWO3dCQUNELE1BQU0sQ0FBQyxhQUFhLEdBQUcsQ0FBQyxDQUFDO3dCQUN6QixNQUFNLFdBQVcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxTQUFTLEdBQUcsTUFBTSxDQUFDLGVBQWUsR0FBRyxHQUFHLENBQUMsQ0FBQzt3QkFDaEYsTUFBTSxDQUFDLFNBQVMsSUFBSSxNQUFNLENBQUMsU0FBUyxDQUFDO3dCQUNyQyxNQUFNLFdBQVcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxTQUFTLEdBQUcsTUFBTSxDQUFDLGVBQWUsR0FBRyxHQUFHLENBQUMsQ0FBQzt3QkFDaEYsSUFBSSxNQUFNLENBQUMsSUFBSSxJQUFJLElBQUksSUFBSSxNQUFNLENBQUMsU0FBUyxHQUFHLFVBQVUsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRTs0QkFDM0UsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUUsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDOzRCQUN0QyxJQUFJLFdBQVcsS0FBSyxXQUFXLEVBQUU7Z0NBRTdCLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsTUFBTSxFQUFFO29DQUNsQyxNQUFNLEVBQUUsTUFBTSxDQUFDLFNBQVMsR0FBRyxNQUFNLENBQUMsZUFBZTtvQ0FDakQsS0FBSyxFQUFFLEdBQUc7aUNBQ2IsQ0FBQyxDQUFDOzZCQUNOO3lCQUNKOzZCQUNJOzRCQUNELElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsTUFBTSxFQUFFO2dDQUNsQyxNQUFNLEVBQUUsQ0FBQztnQ0FDVCxLQUFLLEVBQUUsR0FBRzs2QkFDYixDQUFDLENBQUM7NEJBQ0gsTUFBTSxDQUFDLElBQUksQ0FBQyxzQkFBc0IsR0FBRyxFQUFFLENBQUMsQ0FBQzs0QkFDekMsSUFBSSxDQUFDLHVCQUF1QixDQUFDLEdBQUcsQ0FBQyxDQUFDOzRCQUVsQyxJQUFJLENBQUEsTUFBQSxNQUFNLENBQUMsSUFBSSwwQ0FBRSxRQUFRLENBQUMsUUFBUSxFQUFFLE9BQU8sQ0FBQyxNQUFNLENBQUMsS0FBSSxDQUFDLEVBQUU7Z0NBQ3RELElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxFQUFFLGNBQWMsQ0FBQyxlQUFlLEVBQUUsRUFBRSxFQUFFLElBQUksQ0FBQyxDQUFDOzZCQUNwRTtpQ0FBTTtnQ0FFSCxJQUFJLENBQUMsWUFBWSxDQUFDLEdBQUcsRUFBRSxHQUFHLEVBQUUsRUFBRSxFQUFFLElBQUksQ0FBQyxDQUFDO2dDQUN0QyxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLGVBQWUsRUFBRTtvQ0FDM0MsT0FBTyxFQUFFLFVBQVU7b0NBQ25CLEtBQUssRUFBRSxHQUFHO2lDQUNiLENBQUMsQ0FBQzs2QkFDTjt5QkFDSjtxQkFDSjtvQkFDRyxNQUFNO2dCQUNWLEtBQUssR0FBRztvQkFDSixJQUFJLENBQUMsWUFBWSxDQUFDLEdBQUcsRUFBRSxjQUFjLENBQUMsTUFBTSxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztvQkFDekQsTUFBTTtnQkFDVixLQUFLLGNBQWMsQ0FBQyxlQUFlLENBQUMsQ0FBQztvQkFDakMsSUFBSSxXQUFXLEdBQUcsQ0FBQyxDQUFDO29CQUNwQixNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsR0FBRyxnQkFBZ0IsQ0FBQyxDQUFDO29CQUNwQyxNQUFNLFlBQVksR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDO29CQUd6QyxJQUFJLFlBQVksQ0FBQyxjQUFjLEVBQUU7d0JBQzdCLGFBQWEsQ0FBQyxZQUFZLENBQUMsY0FBYyxDQUFDLENBQUM7d0JBQzNDLFlBQVksQ0FBQyxjQUFjLEdBQUcsU0FBUyxDQUFDO3FCQUMzQztvQkFHRCxJQUFJLFlBQVksQ0FBQyxpQkFBaUIsRUFBRTt3QkFDaEMsYUFBYSxDQUFDLFlBQVksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO3FCQUNqRDtvQkFFRCxZQUFZLENBQUMsY0FBYyxHQUFHLENBQUMsWUFBWSxDQUFDLGNBQWMsSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7b0JBRXJFLFlBQVksQ0FBQyxpQkFBaUIsR0FBRyxXQUFXLENBQUMsR0FBRyxFQUFFOzt3QkFDOUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLEVBQUUsY0FBYyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQzt3QkFDaEQsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQzt3QkFDaEMsSUFBSSxHQUFHLENBQUMsVUFBVSxJQUFJLEVBQUUsSUFBSSxHQUFHLENBQUMsSUFBSSxFQUFFOzRCQUNsQyxJQUFJLENBQUEsTUFBQSxHQUFHLENBQUMsSUFBSSwwQ0FBRSxRQUFRLENBQUMsUUFBUSxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLEtBQUksQ0FBQyxFQUFFO2dDQUMzRCxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsR0FBRyxtQkFBbUIsQ0FBQyxDQUFDO2dDQUN2QyxJQUFJLENBQUMscUJBQXFCLENBQUMsR0FBRyxDQUFDLENBQUM7Z0NBQ2hDLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsZUFBZSxFQUFFO29DQUMzQyxPQUFPLEVBQUUsVUFBVTtvQ0FDbkIsS0FBSyxFQUFFLEdBQUc7aUNBQ2IsQ0FBQyxDQUFDO2dDQUNILE9BQU87NkJBQ1Y7eUJBQ0o7d0JBQ0QsV0FBVyxFQUFFLENBQUM7d0JBQ2QsSUFBSSxXQUFXLEdBQUcsRUFBRSxFQUFFOzRCQUNsQixJQUFJLEdBQUcsQ0FBQyxpQkFBaUIsRUFBRTtnQ0FDdkIsYUFBYSxDQUFDLEdBQUcsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO2dDQUNyQyxHQUFHLENBQUMsaUJBQWlCLEdBQUcsU0FBUyxDQUFDOzZCQUNyQzs0QkFDRCxJQUFJLEdBQUcsQ0FBQyxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsY0FBYyxJQUFJLENBQUMsQ0FBQyxHQUFHLG1CQUFtQixFQUFFO2dDQUM3RCxNQUFNLENBQUMsSUFBSSxDQUFDLHVCQUF1QixHQUFHLGFBQWEsR0FBRyxDQUFDLGNBQWMsSUFBSSxtQkFBbUIsR0FBRyxDQUFDLENBQUM7Z0NBQ2pHLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxHQUFHLENBQUMsQ0FBQztnQ0FDbEMsSUFBSSxDQUFDLHNCQUFzQixDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsRUFBRSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsQ0FBQzs2QkFDdkY7aUNBQU07Z0NBQ0gsTUFBTSxDQUFDLEtBQUssQ0FBQyxrQ0FBa0MsR0FBRyxVQUFVLEdBQUcsQ0FBQyxjQUFjLFdBQVcsQ0FBQyxDQUFDO2dDQUMzRixJQUFJLENBQUMscUJBQXFCLENBQUMsR0FBRyxDQUFDLENBQUM7Z0NBQ2hDLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxHQUFHLENBQUMsQ0FBQztnQ0FDbEMsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxZQUFZLEVBQUU7b0NBQ3hDLEdBQUcsRUFBRSxHQUFHO29DQUNSLE1BQU0sRUFBRSxNQUFNO29DQUNkLElBQUksRUFBRSxxQkFBcUI7aUNBQzlCLENBQUMsQ0FBQztnQ0FDSCxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLE9BQU8sRUFBRTtvQ0FDbkMsSUFBSSxFQUFFLGtDQUFrQyxHQUFHLFVBQVUsR0FBRyxDQUFDLGNBQWMsV0FBVztvQ0FDbEYsR0FBRyxFQUFFLEdBQUc7aUNBQ1gsQ0FBQyxDQUFDOzZCQUNOO3lCQUNKO29CQUNMLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQztvQkFDVCxNQUFNO2lCQUNUO2dCQUNELEtBQUssY0FBYyxDQUFDLGlCQUFpQixDQUFDO2dCQUN0QyxLQUFLLGNBQWMsQ0FBQywwQkFBMEI7b0JBQzFDLElBQUksTUFBTSxDQUFDLHFCQUFxQixFQUFFO3dCQUM5QixNQUFNLENBQUMscUJBQXFCLENBQUMsT0FBTyxHQUFHLEtBQUssQ0FBQzt3QkFDN0MsTUFBTSxDQUFDLHFCQUFxQixDQUFDLE1BQU0sRUFBRSxDQUFDO3FCQUN6QztvQkFDRCxNQUFNO2dCQUNWO29CQUVJLE1BQU07YUFDYjtZQUVELElBQUksS0FBSyxJQUFJLGVBQWUsRUFBRTtnQkFDMUIsV0FBVyxHQUFHLFdBQVcsQ0FBQzthQUM3QjtZQUNELElBQUksV0FBVyxJQUFJLEVBQUUsRUFBRTtnQkFDbkIsTUFBTSxXQUFXLEdBQXlDLFdBQVcsQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO2dCQUN0RixJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLEtBQUssRUFBRTtvQkFDakMsS0FBSyxFQUFFLEdBQUc7b0JBQ1YsTUFBTSxFQUFFLFdBQVc7aUJBQ3RCLENBQUMsQ0FBQztnQkFDSCxJQUFJLFFBQVEsS0FBSyxTQUFTLElBQUksS0FBSyxLQUFLLGVBQWUsRUFBRTtvQkFDckQsUUFBUSxXQUFXLEVBQUU7d0JBQ2pCLEtBQUssaUJBQWlCLENBQUMsd0JBQXdCOzRCQUMzQyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsTUFBTSxFQUFFLFdBQVcsQ0FBQyxDQUFDOzRCQUMzQyxNQUFNO3dCQUNWLEtBQUssaUJBQWlCLENBQUMsb0JBQW9COzRCQUN2QyxJQUFJLE1BQU0sQ0FBQyxLQUFLLElBQUksaUJBQWlCLENBQUMsb0JBQW9CLEVBQUU7Z0NBQ3hELElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxNQUFNLEVBQUUsV0FBVyxDQUFDLENBQUM7NkJBQzlDOzRCQUNELE1BQU07cUJBQ2I7aUJBQ0o7Z0JBRUQsTUFBTSxDQUFDLEtBQUssR0FBRyxXQUFXLENBQUM7YUFDOUI7U0FDSjtJQUNMLENBQUM7SUFFSyxnQkFBZ0IsQ0FBQyxNQUFtQixFQUFFLEtBQWE7O1lBQ3JELElBQUksTUFBTSxDQUFDLFFBQVEsRUFBRTtnQkFDakIsT0FBTzthQUNWO1lBQ0QsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDLE9BQU8sRUFBRSxDQUFDO1lBQzlDLElBQUksTUFBTSxDQUFDLFFBQVEsS0FBSyxTQUFTLElBQUksZ0JBQWdCLEdBQUcsTUFBTSxDQUFDLFFBQVEsR0FBRyxJQUFJLEVBQUU7Z0JBRTVFLE9BQU87YUFDVjtZQUNELE1BQU0sQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDO1lBQ3ZCLE1BQU0sT0FBTyxHQUFHLE1BQU0sQ0FBQyxpQkFBaUIsQ0FBQztZQUN6QyxJQUFJLE9BQU8sSUFBSSxTQUFTLElBQUksTUFBTSxDQUFDLGNBQWMsSUFBSSxTQUFTLEVBQUU7Z0JBQzVELE1BQU0sS0FBSyxHQUFHLHdCQUFXLENBQUMsR0FBRyxFQUFFLENBQUM7Z0JBQ2hDLE1BQU0sR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxPQUFPLEVBQUUsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUN4RCxNQUFNLEdBQUcsR0FBRyx3QkFBVyxDQUFDLEdBQUcsRUFBRSxDQUFDO2dCQUM5QixNQUFNLENBQUMsSUFBSSxDQUFDLGVBQWUsR0FBRyxTQUFTLEdBQUcsR0FBRyxLQUFLLElBQUksQ0FBQyxDQUFDO2dCQUN4RCxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLFdBQVcsRUFBRTtvQkFDdkMsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7d0JBQ2pCLElBQUksRUFBRSxHQUFHO3dCQUNULEtBQUs7cUJBQ1IsQ0FBQztvQkFDRixHQUFHLEVBQUUsTUFBTSxDQUFDLEdBQUc7aUJBQ2xCLENBQUMsQ0FBQztnQkFDSCxNQUFNLFdBQVcsR0FBeUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUE7Z0JBQy9FLElBQUksV0FBVyxJQUFJLGlCQUFpQixDQUFDLHdCQUF3QixFQUFFO29CQUMzRCxJQUFJLE1BQU0sQ0FBQyxjQUFjLElBQUksU0FBUyxFQUFFO3dCQUNwQyxJQUFJLE1BQU0sQ0FBQyxjQUFjLENBQUMsT0FBTyxJQUFJLGNBQWMsQ0FBQyxHQUFHLEVBQUU7NEJBQ3JELE1BQU0sQ0FBQyxjQUFjLENBQUMsSUFBSSxHQUFHLEdBQUcsR0FBRyxNQUFNLENBQUMsV0FBVyxDQUFDO3lCQUN6RDt3QkFDRCxJQUFJLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxjQUFjLENBQUMsR0FBRyxFQUFFLE1BQU0sQ0FBQyxjQUFjLENBQUMsT0FBTyxFQUFFLE1BQU0sQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLENBQUM7cUJBQzNHO2lCQUNKO3FCQUFNO29CQUNILElBQUksQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLEdBQUcsRUFBRSxjQUFjLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO2lCQUMzRDthQUNKO1lBRUQsTUFBTSxDQUFDLFFBQVEsR0FBRyxLQUFLLENBQUM7UUFDNUIsQ0FBQztLQUFBO0lBRUQsbUJBQW1CLENBQUMsR0FBVyxFQUFFLEtBQWE7UUFDMUMsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNuQyxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsTUFBTSxDQUFDLFlBQVksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUU7WUFDakQsSUFBSSxNQUFNLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssSUFBSSxLQUFLLEVBQUU7Z0JBQ3ZDLE1BQU0sQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztnQkFDakMsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQyxlQUFlLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO29CQUNsRCxJQUFJLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxJQUFJLEtBQUssRUFBRTt3QkFDeEMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO3dCQUNsQyxDQUFDLEVBQUUsQ0FBQztxQkFDUDtpQkFDSjtnQkFDRCxNQUFNO2FBQ1Q7U0FDSjtJQUNMLENBQUM7SUFFRCx1QkFBdUIsQ0FBQyxHQUFXO1FBQy9CLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDbkMsTUFBTSxNQUFNLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztRQUNqQyxLQUFLLE1BQU0sR0FBRyxJQUFJLE1BQU0sQ0FBQyxZQUFZLEVBQUU7WUFDbkMsSUFBSSxHQUFHLENBQUMsS0FBSyxFQUFFO2dCQUNYLE1BQU0sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO2FBQ3pCO1NBQ0o7UUFDRCxLQUFLLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxlQUFlLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFO1lBQ3ZELElBQUksTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxFQUFFO2dCQUMzQyxJQUFJLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7YUFDckM7U0FDSjtRQUNELE1BQU0sQ0FBQyxZQUFZLEdBQUcsRUFBRSxDQUFDO0lBQzdCLENBQUM7SUFFRCxxQkFBcUIsQ0FBQyxPQUFlO1FBQ2pDLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDdkMsSUFBSSxNQUFNLEVBQUU7WUFDUixJQUFJLE1BQU0sQ0FBQyxjQUFjLEVBQUU7Z0JBQ3ZCLGFBQWEsQ0FBQyxNQUFNLENBQUMsY0FBYyxDQUFDLENBQUM7Z0JBQ3JDLE1BQU0sQ0FBQyxjQUFjLEdBQUcsU0FBUyxDQUFDO2FBQ3JDO1lBQ0QsSUFBSSxNQUFNLENBQUMsaUJBQWlCLEVBQUU7Z0JBQzFCLGFBQWEsQ0FBQyxNQUFNLENBQUMsaUJBQWlCLENBQUMsQ0FBQztnQkFDeEMsTUFBTSxDQUFDLGlCQUFpQixHQUFHLFNBQVMsQ0FBQzthQUN4QztZQUNELE1BQU0sQ0FBQyxhQUFhLEdBQUcsQ0FBQyxDQUFDO1lBQ3pCLElBQUksTUFBTSxDQUFDLElBQUksRUFBRTtnQkFDYixNQUFNLENBQUMsSUFBSSxHQUFHLFNBQVMsQ0FBQztnQkFDeEIsTUFBTSxDQUFDLFNBQVMsR0FBRyxDQUFDLENBQUM7Z0JBQ3JCLE1BQU0sQ0FBQyxlQUFlLEdBQUcsQ0FBQyxDQUFDO2FBQzlCO1NBQ0o7SUFDTCxDQUFDO0lBRU8sdUJBQXVCLENBQUMsZ0JBQXFCO1FBQ2pELElBQUksQ0FBQyxnQkFBZ0IsRUFBRTtZQUNuQixPQUFPLFNBQVMsQ0FBQztTQUNwQjtRQUNELElBQUksT0FBTyxnQkFBZ0IsQ0FBQyxnQkFBZ0IsS0FBSyxRQUFRO2VBQ2xELEVBQUUsQ0FBQyxVQUFVLENBQUMsZ0JBQWdCLENBQUMsZ0JBQWdCLENBQUMsRUFBRTtZQUNyRCxPQUFPLGdCQUFnQixDQUFDLGdCQUFnQixDQUFDO1NBQzVDO1FBRUQsTUFBTSxJQUFJLEdBQUcsZ0JBQWdCLENBQUMsWUFBWTtlQUNuQyxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFrQjtlQUM5Qiw2QkFBNkIsRUFBRSxDQUFDO1FBQ3ZDLE1BQU0sUUFBUSxHQUFHLGdCQUFnQixDQUFDLFFBQVEsSUFBSSxnQkFBZ0IsQ0FBQyxFQUFFLENBQUM7UUFDbEUsSUFBSSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRTtZQUNwQixPQUFPLFNBQVMsQ0FBQztTQUNwQjtRQUVELE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRSxRQUFRLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFDdkUsSUFBSSxFQUFFLENBQUMsVUFBVSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLENBQUMsV0FBVyxFQUFFLEVBQUU7WUFDdEUsTUFBTSxRQUFRLEdBQUcsZ0JBQWdCLENBQUMsWUFBWSxJQUFJLGdCQUFnQixDQUFDLFlBQVksQ0FBQztZQUNoRixJQUFJLFFBQVEsRUFBRTtnQkFDVixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxRQUFRLENBQUMsQ0FBQztnQkFDL0MsSUFBSSxFQUFFLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUU7b0JBQ3JELE9BQU8sS0FBSyxDQUFDO2lCQUNoQjthQUNKO1lBQ0QsSUFBSSxPQUFpQixDQUFDO1lBQ3RCLElBQUk7Z0JBQ0EsT0FBTyxHQUFHLEVBQUUsQ0FBQyxXQUFXLENBQUMsV0FBVyxDQUFDLENBQUM7YUFDekM7WUFBQyxXQUFNO2dCQUNKLE9BQU8sU0FBUyxDQUFDO2FBQ3BCO1lBQ0QsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO1lBQ3JFLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUU7Z0JBQ25CLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7YUFDMUM7WUFDRCxJQUFJLElBQUksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFO2dCQUNqQixNQUFNLE9BQU8sR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXLEVBQUUsRUFBRSxDQUFDLENBQVUsQ0FBQyxDQUFDLENBQUM7Z0JBQ3hFLEtBQUssTUFBTSxTQUFTLElBQUksQ0FBQyxjQUFjLEVBQUUsVUFBVSxDQUFDLEVBQUU7b0JBQ2xELE1BQU0sR0FBRyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUM7b0JBQ25DLElBQUksR0FBRyxFQUFFO3dCQUNMLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsR0FBRyxDQUFDLENBQUM7cUJBQ3RDO2lCQUNKO2dCQUNELElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQ3hDLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7YUFDMUM7U0FDSjtRQUVELE1BQU0sVUFBVSxHQUFHLGdCQUFnQixDQUFDLFlBQVksSUFBSSxnQkFBZ0IsQ0FBQyxZQUFZLElBQUksY0FBYyxDQUFDO1FBQ3BHLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRSxVQUFVLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFDakUsSUFBSSxFQUFFLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxFQUFFO1lBQ3ZCLE9BQU8sTUFBTSxDQUFDO1NBQ2pCO1FBQ0QsT0FBTyxTQUFTLENBQUM7SUFDckIsQ0FBQztJQUVLLHNCQUFzQixDQUFDLEdBQVcsRUFBRSxVQUFrQixFQUFFLGdCQUFzQixFQUFFLE1BQWUsRUFBRSxLQUFhLEVBQUUsUUFBUSxHQUFHLE1BQU07OztZQUNuSSxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUMsZ0JBQWdCLEVBQUU7Z0JBQzNCLE9BQU87YUFDVjtZQUVELFVBQVUsR0FBRyxVQUFVLElBQUksRUFBRSxDQUFDO1lBQzlCLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBR2hELElBQUksTUFBTSxFQUFFO2dCQUNSLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBQ2hDLEdBQUcsQ0FBQyxjQUFjLEdBQUcsQ0FBQyxDQUFDO2FBQzFCO1lBRUQsSUFBSSxnQkFBZ0IsSUFBSSxNQUFNLEVBQUU7Z0JBQzVCLElBQUksTUFBTSxLQUFLLGFBQWEsSUFBSSxLQUFLLEVBQUU7b0JBQ25DLElBQUksQ0FBQyxzQkFBc0IsQ0FBQyxHQUFHLEVBQUUsS0FBSyxFQUFFLFFBQVEsQ0FBQyxDQUFDO29CQUNsRCxPQUFPO2lCQUNWO3FCQUFNLElBQUksTUFBTSxLQUFLLE9BQU8sRUFBRTtvQkFDM0IsSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLEVBQUUsS0FBSyxFQUFFLGdCQUFnQixFQUFFLFFBQVEsQ0FBQyxDQUFDO29CQUN6RCxPQUFPO2lCQUNWO3FCQUFNLElBQUksTUFBTSxLQUFLLFFBQVEsRUFBRTtvQkFDNUIsSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLEVBQUUsS0FBSyxFQUFFLGdCQUFnQixDQUFDLENBQUM7b0JBQ2hELE9BQU87aUJBQ1Y7cUJBQU0sSUFBSSxNQUFNLEtBQUssU0FBUyxFQUFFO29CQUM3QixJQUFJLENBQUMsYUFBYSxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztvQkFDakQsT0FBTztpQkFDVjtxQkFBTSxJQUFJLE1BQU0sS0FBSyxPQUFPLEVBQUU7b0JBQzNCLElBQUksQ0FBQyxXQUFXLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO29CQUMvQyxPQUFPO2lCQUNWO3FCQUFNLElBQUksTUFBTSxLQUFLLFFBQVEsRUFBRTtvQkFDNUIsSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLEVBQUUsS0FBSyxFQUFFLGdCQUFnQixDQUFDLENBQUM7b0JBQ2hELE9BQU87aUJBQ1Y7YUFDSjtpQkFBTTtnQkFDSCxNQUFNLENBQUMsSUFBSSxDQUFDLGtDQUFrQyxHQUFHLEdBQUcsQ0FBQyxDQUFDO2dCQUN0RCxJQUFJLE1BQU0sR0FBZ0IsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFHOUMsSUFBSSxDQUFDLHFCQUFxQixDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNoQyxJQUFJLENBQUMsdUJBQXVCLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBRWxDLE1BQU0sQ0FBQyxTQUFTLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQixNQUFNLENBQUMsYUFBYSxHQUFHLENBQUMsQ0FBQztnQkFDekIsTUFBTSxDQUFDLGdCQUFnQixHQUFHLGdCQUFnQixDQUFDO2dCQUUzQyxNQUFNLENBQUMsSUFBSSxHQUFHLEtBQUssQ0FBQztnQkFDcEIsSUFBSSxTQUFTLEdBQUcsS0FBSyxDQUFDO2dCQUN0QixJQUFJLENBQUEsTUFBQSxNQUFNLENBQUMsSUFBSSwwQ0FBRSxRQUFRLENBQUMsUUFBUSxFQUFFLE9BQU8sQ0FBQyxNQUFNLENBQUMsS0FBSSxDQUFDLEVBQUU7b0JBQ3RELFNBQVMsR0FBRyxJQUFJLENBQUM7aUJBQ3BCO2dCQUdELElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxNQUFNLEdBQUcsYUFBYSxFQUFFO29CQUNwQyxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLE9BQU8sRUFBRTt3QkFDbkMsSUFBSSxFQUFFLG1CQUFtQixNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sc0NBQXNDLGFBQWEsU0FBUzt3QkFDdkcsR0FBRztxQkFDTixDQUFDLENBQUM7b0JBQ0gsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxZQUFZLEVBQUU7d0JBQ3hDLEdBQUc7d0JBQ0gsTUFBTSxFQUFFLE1BQU07d0JBQ2QsSUFBSSxFQUFFLGdCQUFnQjtxQkFDekIsQ0FBQyxDQUFDO29CQUNILE1BQU0sQ0FBQyxJQUFJLEdBQUcsU0FBUyxDQUFDO29CQUN4QixPQUFPO2lCQUNWO2dCQUVELE1BQU0sVUFBVSxHQUFHLE1BQU0sSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDakQsSUFBSSxVQUFVLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsRUFBRTtvQkFDaEQsTUFBTSxDQUFDLHFCQUFxQixHQUFHLElBQUksT0FBTyxFQUFFLENBQUM7b0JBQzdDLE1BQU0sQ0FBQyxxQkFBcUIsQ0FBQyxPQUFPLEdBQUcsR0FBRyxDQUFDO2lCQUM5QztxQkFBTTtvQkFDSCxNQUFNLENBQUMscUJBQXFCLEdBQUcsSUFBSSxPQUFPLEVBQUUsQ0FBQztvQkFDN0MsSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLEVBQUUsY0FBYyxDQUFDLGlCQUFpQixFQUFFLEVBQUUsRUFBRSxJQUFJLENBQUMsQ0FBQztvQkFDbkUsTUFBTSxNQUFNLENBQUMscUJBQXFCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO2lCQUNqRDtnQkFDRCxJQUFJLENBQUMsTUFBTSxDQUFDLHFCQUFxQjt1QkFDMUIsQ0FBQyxNQUFNLENBQUMscUJBQXFCLENBQUMsT0FBTzt1QkFDckMsTUFBTSxDQUFDLHFCQUFxQixDQUFDLE9BQU8sS0FBSyxHQUFHO3VCQUM1QyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLGdCQUFnQixDQUFDLElBQUksQ0FBQyxJQUFJLFNBQVMsQ0FBQyxFQUM5RDtvQkFDRSxNQUFNLFlBQVksR0FBRyxJQUFJLENBQUMsdUJBQXVCLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztvQkFDcEUsSUFBSSxDQUFDLGdCQUFnQixJQUFJLENBQUMsWUFBWSxFQUFFO3dCQUNwQyxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLE9BQU8sRUFBRTs0QkFDbkMsSUFBSSxFQUFFLHdOQUF3Tjs0QkFDOU4sR0FBRzt5QkFDTixDQUFDLENBQUM7d0JBQ0gsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxZQUFZLEVBQUU7NEJBQ3hDLEdBQUc7NEJBQ0gsTUFBTSxFQUFFLE1BQU07NEJBQ2QsSUFBSSxFQUFFLHFCQUFxQjt5QkFDOUIsQ0FBQyxDQUFDO3dCQUNILE1BQU0sQ0FBQyxJQUFJLEdBQUcsU0FBUyxDQUFDO3dCQUN4QixPQUFPO3FCQUNWO29CQUNELElBQUksYUFBcUIsQ0FBQztvQkFDMUIsSUFBSTt3QkFDQSxhQUFhLEdBQUcsRUFBRSxDQUFDLFlBQVksQ0FBQyxZQUFZLENBQUMsQ0FBQztxQkFDakQ7b0JBQUMsT0FBTyxDQUFNLEVBQUU7d0JBQ2IsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxPQUFPLEVBQUU7NEJBQ25DLElBQUksRUFBRSxpQ0FBaUMsWUFBWSxLQUFLLE1BQUEsQ0FBQyxhQUFELENBQUMsdUJBQUQsQ0FBQyxDQUFFLE9BQU8sbUNBQUksQ0FBQyxFQUFFOzRCQUN6RSxHQUFHO3lCQUNOLENBQUMsQ0FBQzt3QkFDSCxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLFlBQVksRUFBRTs0QkFDeEMsR0FBRzs0QkFDSCxNQUFNLEVBQUUsTUFBTTs0QkFDZCxJQUFJLEVBQUUscUJBQXFCO3lCQUM5QixDQUFDLENBQUM7d0JBQ0gsTUFBTSxDQUFDLElBQUksR0FBRyxTQUFTLENBQUM7d0JBQ3hCLE9BQU87cUJBQ1Y7b0JBQ0QsTUFBTSxDQUFDLElBQUksR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsYUFBYSxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUM7b0JBQ3BELE1BQU0sQ0FBQyxTQUFTLEdBQUcsQ0FBQyxDQUFDO29CQUdyQixJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsTUFBTSxHQUFHLGFBQWEsRUFBRTt3QkFDcEMsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxPQUFPLEVBQUU7NEJBQ25DLElBQUksRUFBRSxzQ0FBc0MsTUFBTSxDQUFDLElBQUksQ0FBQyxNQUFNLHNDQUFzQyxhQUFhLFNBQVM7NEJBQzFILEdBQUc7eUJBQ04sQ0FBQyxDQUFDO3dCQUNILElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsWUFBWSxFQUFFOzRCQUN4QyxHQUFHOzRCQUNILE1BQU0sRUFBRSxNQUFNOzRCQUNkLElBQUksRUFBRSxnQkFBZ0I7eUJBQ3pCLENBQUMsQ0FBQzt3QkFDSCxNQUFNLENBQUMsSUFBSSxHQUFHLFNBQVMsQ0FBQzt3QkFDeEIsT0FBTztxQkFDVjtvQkFFRCxNQUFNLENBQUMscUJBQXFCLEdBQUcsSUFBSSxPQUFPLEVBQUUsQ0FBQztvQkFDN0MsSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLEVBQUUsY0FBYyxDQUFDLDBCQUEwQixFQUFFLEVBQUUsRUFBRSxJQUFJLENBQUMsQ0FBQztvQkFDNUUsTUFBTSxNQUFNLENBQUMscUJBQXFCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO29CQUU5QyxJQUFJLENBQUMsTUFBTSxDQUFDLHFCQUFxQjsyQkFDMUIsQ0FBQyxNQUFNLENBQUMscUJBQXFCLENBQUMsT0FBTzsyQkFDckMsTUFBTSxDQUFDLHFCQUFxQixDQUFDLE9BQU8sS0FBSyxHQUFHLEVBQUU7d0JBQ2pELElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsT0FBTyxFQUFFOzRCQUNuQyxJQUFJLEVBQUUsVUFBVSxHQUFHLHNEQUFzRDs0QkFDekUsR0FBRzt5QkFDTixDQUFDLENBQUM7d0JBQ0gsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxZQUFZLEVBQUU7NEJBQ3hDLEdBQUc7NEJBQ0gsTUFBTSxFQUFFLE1BQU07NEJBQ2QsSUFBSSxFQUFFLFdBQVc7eUJBQ3BCLENBQUMsQ0FBQzt3QkFDSCxNQUFNLENBQUMsSUFBSSxHQUFHLFNBQVMsQ0FBQzt3QkFDeEIsTUFBTSxDQUFDLHFCQUFxQixHQUFHLFNBQVMsQ0FBQzt3QkFDekMsT0FBTztxQkFDVjtpQkFDSjtnQkFDRCxNQUFNLENBQUMscUJBQXFCLEdBQUcsU0FBUyxDQUFDO2dCQUV6QyxJQUFJLGFBQWEsR0FBRyxDQUFDLENBQUMsQ0FBQztnQkFDdkIsSUFBSSxVQUFVLEdBQUcsQ0FBQyxDQUFDO2dCQUNuQixNQUFNLENBQUMsY0FBYyxHQUFHLFdBQVcsQ0FBQyxHQUFHLEVBQUU7b0JBQ3JDLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUM7b0JBQ2hDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxJQUFJLEdBQUcsQ0FBQyxlQUFlLEtBQUssQ0FBQyxFQUFFO3dCQUN4QyxJQUFJLEdBQUcsQ0FBQyxjQUFjLEVBQUU7NEJBQ3BCLGFBQWEsQ0FBQyxHQUFHLENBQUMsY0FBYyxDQUFDLENBQUM7NEJBQ2xDLEdBQUcsQ0FBQyxjQUFjLEdBQUcsU0FBUyxDQUFDO3lCQUNsQzt3QkFDRCxPQUFPO3FCQUNWO29CQUNELElBQUksR0FBRyxDQUFDLFNBQVMsS0FBSyxhQUFhLEVBQUU7d0JBQ2pDLFVBQVUsRUFBRSxDQUFDO3FCQUNoQjt5QkFBTTt3QkFDSCxVQUFVLEdBQUcsQ0FBQyxDQUFDO3dCQUNmLGFBQWEsR0FBRyxHQUFHLENBQUMsU0FBUyxDQUFDO3FCQUNqQztvQkFDRCxJQUFJLFVBQVUsSUFBSSxDQUFDLEVBQUU7d0JBQ2pCLE1BQU0sQ0FBQyxLQUFLLENBQUMsc0JBQXNCLEdBQUcsYUFBYSxHQUFHLENBQUMsU0FBUyxRQUFRLFVBQVUsR0FBRyxDQUFDLHVCQUF1QixHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQzt3QkFDeEgsSUFBSSxDQUFDLHFCQUFxQixDQUFDLEdBQUcsQ0FBQyxDQUFDO3dCQUNoQyxJQUFJLENBQUMsdUJBQXVCLENBQUMsR0FBRyxDQUFDLENBQUM7d0JBQ2xDLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsWUFBWSxFQUFFOzRCQUN4QyxHQUFHLEVBQUUsR0FBRzs0QkFDUixNQUFNLEVBQUUsTUFBTTt5QkFDakIsQ0FBQyxDQUFDO3dCQUNILElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsT0FBTyxFQUFFOzRCQUNuQyxJQUFJLEVBQUUseUJBQXlCLEdBQUcscUJBQXFCOzRCQUN2RCxHQUFHLEVBQUUsR0FBRzt5QkFDWCxDQUFDLENBQUM7cUJBQ047Z0JBQ0wsQ0FBQyxFQUFFLHVCQUF1QixHQUFHLENBQUMsQ0FBQyxDQUFDO2dCQUVoQyxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUU7b0JBQ2xELEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxNQUFNLENBQUMsWUFBWSxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTt3QkFDakQsSUFBSSxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssSUFBSSxNQUFNLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssRUFBRTs0QkFDL0QsSUFBSSxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDOzRCQUNsQyxDQUFDLEVBQUUsQ0FBQzs0QkFDSixNQUFNO3lCQUNUO3FCQUNKO2lCQUNKO2dCQUNELE1BQU0sQ0FBQyxTQUFTLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQixJQUFJLE1BQU0sQ0FBQyxJQUFJLElBQUksSUFBSSxFQUFFO29CQUNyQixJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQztpQkFDMUI7YUFDSjs7S0FDSjtJQUVELFdBQVcsQ0FBQyxHQUFXLEVBQUUsS0FBYSxFQUFFLGdCQUFxQixFQUFFLFFBQWdCO1FBQzNFLE1BQU0sVUFBVSxHQUFHLEVBQUUsQ0FBQztRQUN0QixJQUFJLFlBQVksR0FBRyxPQUFPLENBQUM7UUFDM0IsSUFBSSxnQkFBZ0IsQ0FBQyxZQUFZLEtBQUssU0FBUyxFQUFFO1lBQzdDLElBQUksZ0JBQWdCLENBQUMsWUFBWSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRTtnQkFDaEQsWUFBWSxHQUFHLFFBQVEsQ0FBQyxnQkFBZ0IsQ0FBQyxZQUFZLEVBQUUsRUFBRSxDQUFDLENBQUM7YUFDOUQ7aUJBQU07Z0JBQ0gsWUFBWSxHQUFHLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxZQUFZLENBQUMsQ0FBQzthQUN4RDtTQUNKO1FBQ0QsVUFBVSxDQUFDLElBQUksQ0FBQztZQUNaLElBQUksRUFBRSxLQUFLO1lBQ1gsT0FBTyxFQUFFLFlBQVk7U0FDeEIsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEdBQUcsRUFBRSxVQUFVLEVBQUUsUUFBUSxDQUFDLENBQUM7SUFDckQsQ0FBQztJQUVELFlBQVksQ0FBQyxHQUFXLEVBQUUsS0FBYSxFQUFFLGdCQUFxQjtRQUMxRCxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2hDLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsTUFBTyxDQUFDO1FBQzFDLElBQUk7WUFFQSxNQUFNLE1BQU0sR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFVBQVUsRUFBRSxDQUFDLFdBQVcsQ0FBQyxFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7WUFDeEUsSUFBSSxNQUFNLENBQUMsS0FBSyxFQUFFO2dCQUNkLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsT0FBTyxFQUFFO29CQUNuQyxJQUFJLEVBQUUsR0FBRyxVQUFVLFlBQVk7b0JBQy9CLE1BQU0sRUFBRSxVQUFVO29CQUNsQixHQUFHLEVBQUUsR0FBRztpQkFDWCxDQUFDLENBQUM7Z0JBQ0gsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLFlBQVksRUFBRTtvQkFDL0MsTUFBTSxFQUFFLFFBQVE7b0JBQ2hCLElBQUksRUFBRSxXQUFXO29CQUNqQixHQUFHO2lCQUNOLENBQUMsQ0FBQzthQUNOO1lBRUQsRUFBRSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLHFCQUFxQixFQUFFLFFBQVEsQ0FBQyxFQUFFLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7WUFFOUUsRUFBRSxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLHFCQUFxQixFQUFFLFFBQVEsRUFBRSxZQUFZLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQztZQUNsRixNQUFNLE9BQU8sR0FBRyxHQUFHLEVBQUU7Z0JBQ2pCLElBQUksUUFBUSxJQUFJLEVBQUUsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxxQkFBcUIsRUFBRSxRQUFRLENBQUMsQ0FBQyxFQUFFO29CQUN2RSxFQUFFLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMscUJBQXFCLEVBQUUsUUFBUSxDQUFDLEVBQUUsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztpQkFDakY7WUFDTCxDQUFDLENBQUE7WUFFRCxJQUFJLElBQUksR0FBRyxFQUFFLENBQUM7WUFFZCxJQUFJLEdBQUcsR0FBRyxVQUFVLE9BQU8sR0FBRyxtQkFBbUIsSUFBSSxDQUFDLElBQUksQ0FBQyxxQkFBcUIsRUFBRSxRQUFRLEVBQUUsWUFBWSxDQUFDLE9BQU8sZ0JBQWdCLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ3RKLE1BQU0sSUFBSSxHQUFHLEVBQUUsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLEVBQUUsRUFBRSxFQUFFLEdBQUcsa0NBQU8sT0FBTyxDQUFDLEdBQUcsS0FBRSxZQUFZLEVBQUUsRUFBRSxHQUFFLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztZQUM1RyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRTtnQkFDWCxPQUFPO2FBQ1Y7WUFDRCxJQUFJLFVBQVUsR0FBRyxFQUFFLENBQUM7WUFDcEIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFLENBQUMsSUFBUyxFQUFFLEVBQUU7Z0JBRWpDLElBQUk7b0JBQ0EsSUFBSSxRQUFRLEdBQUcsQ0FBQyxDQUFDO29CQUVqQixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDO29CQUNuRCxJQUFJLEtBQUssRUFBRTt3QkFDUCxRQUFRLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7d0JBQ3ZGLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsTUFBTSxFQUFFOzRCQUNsQyxNQUFNLEVBQUUsUUFBUTs0QkFDaEIsS0FBSyxFQUFFLEdBQUc7eUJBQ2IsQ0FBQyxDQUFDO3FCQUNOO2lCQUNKO2dCQUFDLE9BQU8sRUFBRSxFQUFFO2lCQUVaO1lBQ0wsQ0FBQyxDQUFDLENBQUM7WUFDSCxJQUFJLENBQUMsRUFBRSxDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUU7Z0JBQ2xCLE9BQU8sRUFBRSxDQUFDO2dCQUNWLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsZUFBZSxFQUFFO29CQUMzQyxNQUFNLEVBQUUsUUFBUTtvQkFDaEIsR0FBRyxFQUFFLEVBQUU7aUJBQ1YsQ0FBQyxDQUFDO1lBQ1AsQ0FBQyxDQUFDLENBQUM7WUFDSCxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxJQUFTLEVBQUUsRUFBRTtnQkFDakMsVUFBVSxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNsQyxDQUFDLENBQUMsQ0FBQztZQUNILElBQUksQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFLENBQUMsSUFBWSxFQUFFLEVBQUU7Z0JBQzdCLE9BQU8sRUFBRSxDQUFDO2dCQUNWLElBQUksSUFBSSxLQUFLLENBQUMsRUFBRTtvQkFDWixJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLE9BQU8sRUFBRTt3QkFDbkMsSUFBSSxFQUFFLFVBQVU7d0JBQ2hCLEdBQUcsRUFBRSxHQUFHO3FCQUNYLENBQUMsQ0FBQztvQkFDSCxPQUFPLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsWUFBWSxFQUFFO3dCQUMvQyxNQUFNLEVBQUUsUUFBUTt3QkFDaEIsSUFBSSxFQUFFLE9BQU87d0JBQ2IsR0FBRztxQkFDTixDQUFDLENBQUM7aUJBQ047Z0JBQ0QsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxlQUFlLEVBQUU7b0JBQzNDLE1BQU0sRUFBRSxRQUFRO29CQUNoQixHQUFHO2lCQUNOLENBQUMsQ0FBQztZQUNQLENBQUMsQ0FBQyxDQUFDO1NBQ047UUFBQyxPQUFPLEVBQUUsRUFBRTtZQUNULElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsT0FBTyxFQUFFO2dCQUNuQyxJQUFJLEVBQUUsRUFBRSxDQUFDLFFBQVEsRUFBRTtnQkFDbkIsR0FBRyxFQUFFLEdBQUc7YUFDWCxDQUFDLENBQUM7WUFDSCxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLFlBQVksRUFBRTtnQkFDeEMsTUFBTSxFQUFFLFFBQVE7Z0JBQ2hCLEdBQUc7YUFDTixDQUFDLENBQUM7U0FDTjtJQUNMLENBQUM7SUFFRCxhQUFhLENBQUMsR0FBVyxFQUFFLEtBQWEsRUFBRSxnQkFBcUI7UUFDM0QsTUFBTSxhQUFhLEdBQUcsZ0JBQWdCLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQVcsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksS0FBSyxTQUFTLENBQUMsQ0FBQztRQUN0RyxJQUFJLFdBQVcsR0FBRyxnQkFBZ0IsQ0FBQyxFQUFFLENBQUM7UUFDdEMsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNoQyxJQUFJLFVBQVUsR0FBRyxFQUFFLENBQUM7UUFDcEIsSUFBSSxRQUFRLEdBQUcsRUFBRSxDQUFDO1FBQ2xCLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBUSxDQUFDO1FBQzVDLElBQUk7WUFFQSxNQUFNLE9BQU8sR0FBRyxFQUFFLENBQUMsU0FBUyxDQUFDLFdBQVcsRUFBRSxDQUFDLFdBQVcsQ0FBQyxFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7WUFDMUUsSUFBSSxPQUFPLENBQUMsS0FBSyxFQUFFO2dCQUNmLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsT0FBTyxFQUFFO29CQUNuQyxJQUFJLEVBQUUsR0FBRyxXQUFXLFlBQVk7b0JBQ2hDLE1BQU0sRUFBRSxVQUFVO29CQUNsQixHQUFHLEVBQUUsR0FBRztpQkFDWCxDQUFDLENBQUM7Z0JBQ0gsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLFlBQVksRUFBRTtvQkFDL0MsTUFBTSxFQUFFLFNBQVM7b0JBQ2pCLElBQUksRUFBRSxXQUFXO29CQUNqQixHQUFHO2lCQUNOLENBQUMsQ0FBQzthQUNOO1lBRUQsRUFBRSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLHFCQUFxQixFQUFFLFFBQVEsQ0FBQyxFQUFFLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7WUFHOUUsVUFBVSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMscUJBQXFCLEVBQUUsUUFBUSxFQUFFLGFBQWEsQ0FBQyxDQUFDO1lBQ3ZFLElBQUksY0FBYyxHQUFHLEVBQUUsQ0FBQztZQUN4QixJQUFJLGFBQWEsQ0FBQyxPQUFPLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRTtnQkFDbEMsY0FBYyxHQUFHLGFBQWEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7YUFDN0M7WUFDRCxNQUFNLGNBQWMsR0FBRyxHQUFHLFFBQVEsSUFBSSx3QkFBd0IsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1lBRXhFLEVBQUUsQ0FBQyxhQUFhLENBQUMsVUFBVSxFQUFFLGNBQWMsQ0FBQyxDQUFDO1lBQzdDLEVBQUUsQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxxQkFBcUIsRUFBRSxRQUFRLEVBQUUsY0FBYyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDcEYsTUFBTSxPQUFPLEdBQUcsR0FBRyxFQUFFO2dCQUNqQixJQUFJLFFBQVEsSUFBSSxFQUFFLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMscUJBQXFCLEVBQUUsUUFBUSxDQUFDLENBQUMsRUFBRTtvQkFDdkUsRUFBRSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLHFCQUFxQixFQUFFLFFBQVEsQ0FBQyxFQUFFLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7aUJBQ2pGO1lBQ0wsQ0FBQyxDQUFBO1lBQ0QsSUFBSSxTQUFTLEdBQUcsRUFBRSxDQUFDO1lBRW5CLE1BQU0sSUFBSSxHQUFHLEdBQUcsV0FBVyxPQUFPLFVBQVUsZ0JBQWdCLElBQUksQ0FBQyxJQUFJLENBQUMscUJBQXFCLEVBQUUsUUFBUSxFQUFFLGNBQWMsQ0FBQyxxQkFBcUIsQ0FBQztZQUM1SSxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2xCLE1BQU0sSUFBSSxHQUFHLEVBQUUsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLEVBQUUsRUFBRSxFQUFFLEdBQUcsa0NBQU8sT0FBTyxDQUFDLEdBQUcsS0FBRSxZQUFZLEVBQUUsRUFBRSxHQUFFLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztZQUM1RyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRTtnQkFDWCxPQUFPO2FBQ1Y7WUFDRCxJQUFJLENBQUMsRUFBRSxDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUU7Z0JBQ2xCLE9BQU8sRUFBRSxDQUFDO2dCQUNWLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsZUFBZSxFQUFFO29CQUMzQyxNQUFNLEVBQUUsU0FBUztvQkFDakIsR0FBRyxFQUFFLFdBQVc7aUJBQ25CLENBQUMsQ0FBQztZQUNQLENBQUMsQ0FBQyxDQUFDO1lBQ0gsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFLENBQUMsSUFBUyxFQUFFLEVBQUU7Z0JBQ2pDLFNBQVMsSUFBSSxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7Z0JBQzdCLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7WUFDakMsQ0FBQyxDQUFDLENBQUM7WUFDSCxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxJQUFTLEVBQUUsRUFBRTtnQkFDakMsU0FBUyxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztnQkFDN0IsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztZQUNqQyxDQUFDLENBQUMsQ0FBQztZQUNILElBQUksQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFLENBQUMsSUFBWSxFQUFFLEVBQUU7Z0JBQzdCLE9BQU8sRUFBRSxDQUFDO2dCQUNWLElBQUksSUFBSSxLQUFLLENBQUMsRUFBRTtvQkFDWixJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLE9BQU8sRUFBRTt3QkFDbkMsSUFBSSxFQUFFLDRCQUE0QixJQUFJLE1BQU0sU0FBUyxFQUFFO3dCQUN2RCxHQUFHLEVBQUUsR0FBRztxQkFDWCxDQUFDLENBQUM7b0JBQ0gsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLFlBQVksRUFBRTt3QkFDL0MsTUFBTSxFQUFFLFNBQVM7d0JBQ2pCLElBQUksRUFBRSxPQUFPO3dCQUNiLEdBQUc7cUJBQ04sQ0FBQyxDQUFDO2lCQUNOO2dCQUNELElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsZUFBZSxFQUFFO29CQUMzQyxNQUFNLEVBQUUsU0FBUztvQkFDakIsR0FBRyxFQUFFLFdBQVc7aUJBQ25CLENBQUMsQ0FBQztZQUNQLENBQUMsQ0FBQyxDQUFDO1NBQ047UUFBQyxPQUFPLEVBQU8sRUFBRTtZQUNkLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsT0FBTyxFQUFFO2dCQUNuQyxJQUFJLEVBQUUsRUFBRSxDQUFDLFFBQVEsRUFBRTtnQkFDbkIsR0FBRzthQUNOLENBQUMsQ0FBQztZQUNILElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsWUFBWSxFQUFFO2dCQUN4QyxNQUFNLEVBQUUsU0FBUztnQkFDakIsR0FBRzthQUNOLENBQUMsQ0FBQztTQUNOO0lBQ0wsQ0FBQztJQUVELFdBQVcsQ0FBQyxHQUFXLEVBQUUsS0FBYSxFQUFFLGdCQUFxQjtRQUN6RCxNQUFNLFdBQVcsR0FBRyxnQkFBZ0IsQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBVyxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxLQUFLLE9BQU8sQ0FBQyxDQUFDO1FBQ2xHLElBQUksV0FBVyxHQUFHLEVBQUUsQ0FBQztRQUNyQixJQUFJLEtBQUssR0FBRyxFQUFFLENBQUM7UUFDZixJQUFJLFlBQVksR0FBRyxnQkFBZ0IsQ0FBQyxZQUFZLElBQUksS0FBSyxDQUFDO1FBQzFELE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDaEMsSUFBSSxVQUFVLEdBQUcsRUFBRSxDQUFDO1FBQ3BCLElBQUksUUFBUSxHQUFHLEVBQUUsQ0FBQztRQUNsQixNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQU0sQ0FBQztRQUN4QyxJQUFJO1lBRUEsTUFBTSxLQUFLLEdBQUcsRUFBRSxDQUFDLFNBQVMsQ0FBQyxTQUFTLEVBQUUsQ0FBQyxXQUFXLENBQUMsRUFBRSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO1lBQ3RFLElBQUksS0FBSyxDQUFDLEtBQUssRUFBRTtnQkFDYixJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLE9BQU8sRUFBRTtvQkFDbkMsSUFBSSxFQUFFLEdBQUcsU0FBUyxZQUFZO29CQUM5QixNQUFNLEVBQUUsVUFBVTtvQkFDbEIsR0FBRyxFQUFFLEdBQUc7aUJBQ1gsQ0FBQyxDQUFDO2dCQUNILE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxZQUFZLEVBQUU7b0JBQy9DLE1BQU0sRUFBRSxPQUFPO29CQUNmLElBQUksRUFBRSxXQUFXO29CQUNqQixHQUFHO2lCQUNOLENBQUMsQ0FBQzthQUNOO1lBQ0QsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLFdBQVcsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO2dCQUNqRCxJQUFJLE1BQU0sR0FBRyxXQUFXLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUNwQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFO29CQUMzQixNQUFNLEdBQUcsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsTUFBTSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQztpQkFDbkQ7Z0JBQ0QsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxLQUFLLENBQUMsRUFBRTtvQkFDbkMsV0FBVyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7aUJBQ3RDO2dCQUNELElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLEVBQUU7b0JBQ2xDLEtBQUssR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO2lCQUNoQzthQUNKO1lBRUQsSUFBSSxRQUFRLEdBQUcsR0FBRyxRQUFRLE1BQU0sQ0FBQztZQUNqQyxNQUFNLFNBQVMsR0FBRyx3QkFBd0IsQ0FBQyxLQUFLLENBQUMsS0FBSyxLQUFLLENBQUM7WUFDNUQsSUFBSSxTQUFTLEVBQUU7Z0JBQ1gsUUFBUSxHQUFHLEdBQUcsUUFBUSxNQUFNLENBQUM7YUFDaEM7WUFDRCxRQUFRLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxxQkFBcUIsRUFBRSxRQUFRLENBQUMsQ0FBQztZQUN0RCxVQUFVLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxxQkFBcUIsRUFBRSxHQUFHLFFBQVEsUUFBUSxDQUFDLENBQUM7WUFDbkUsRUFBRSxDQUFDLGFBQWEsQ0FBQyxRQUFRLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFFbEMsSUFBSSxTQUFTLEVBQUU7Z0JBQ1gsRUFBRSxDQUFDLGFBQWEsQ0FBQyxVQUFVLEVBQUUsWUFBWSxRQUFRLGNBQWMsQ0FBQyxDQUFDO2FBQ3BFO2lCQUFNO2dCQUNILEVBQUUsQ0FBQyxhQUFhLENBQUMsVUFBVSxFQUFFLFdBQVcsUUFBUSxJQUFJLFlBQVksY0FBYyxDQUFDLENBQUM7YUFDbkY7WUFFRCxNQUFNLE9BQU8sR0FBRyxHQUFHLEVBQUU7Z0JBQ2pCLElBQUksVUFBVSxJQUFJLEVBQUUsQ0FBQyxVQUFVLENBQUMsVUFBVSxDQUFDLEVBQUU7b0JBQ3pDLEVBQUUsQ0FBQyxVQUFVLENBQUMsVUFBVSxDQUFDLENBQUM7aUJBQzdCO2dCQUNELElBQUksUUFBUSxJQUFJLEVBQUUsQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLEVBQUU7b0JBQ3JDLEVBQUUsQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLENBQUM7aUJBQzNCO1lBQ0wsQ0FBQyxDQUFBO1lBRUQsTUFBTSxJQUFJLEdBQUcsR0FBRyxTQUFTLFlBQVksV0FBVyxtQkFBbUIsS0FBSyxvQ0FBb0MsVUFBVSxFQUFFLENBQUM7WUFDekgsTUFBTSxJQUFJLEdBQUcsRUFBRSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsRUFBRSxFQUFFLEVBQUUsR0FBRyxrQ0FBTyxPQUFPLENBQUMsR0FBRyxLQUFFLFlBQVksRUFBRSxFQUFFLEdBQUUsRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO1lBQzVHLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFO2dCQUNYLE9BQU87YUFDVjtZQUNELElBQUksQ0FBQyxFQUFFLENBQUMsT0FBTyxFQUFFLEdBQUcsRUFBRTtnQkFDbEIsT0FBTyxFQUFFLENBQUM7Z0JBQ1YsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxlQUFlLEVBQUU7b0JBQzNDLEdBQUcsRUFBRSxXQUFXO2lCQUNuQixDQUFDLENBQUM7WUFDUCxDQUFDLENBQUMsQ0FBQztZQUNILElBQUksQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLE1BQU0sRUFBRSxDQUFDLElBQVMsRUFBRSxFQUFFO2dCQUNqQyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDO1lBQ2pDLENBQUMsQ0FBQyxDQUFDO1lBQ0gsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFLENBQUMsSUFBUyxFQUFFLEVBQUU7Z0JBQ2pDLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7WUFDakMsQ0FBQyxDQUFDLENBQUM7WUFDSCxJQUFJLENBQUMsRUFBRSxDQUFDLE1BQU0sRUFBRSxHQUFHLEVBQUU7Z0JBQ2pCLE9BQU8sRUFBRSxDQUFDO2dCQUNWLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsZUFBZSxFQUFFO29CQUMzQyxNQUFNLEVBQUUsT0FBTztvQkFDZixHQUFHLEVBQUUsV0FBVztpQkFDbkIsQ0FBQyxDQUFDO1lBQ1AsQ0FBQyxDQUFDLENBQUM7U0FDTjtRQUFDLE9BQU8sRUFBRSxFQUFFO1lBQ1QsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQztTQUNuQjtJQUNMLENBQUM7SUFFRCxZQUFZLENBQUMsR0FBVyxFQUFFLEtBQWEsRUFBRSxnQkFBcUI7UUFDMUQsTUFBTSxZQUFZLEdBQUcsZ0JBQWdCLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQVcsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksS0FBSyxRQUFRLENBQUMsQ0FBQztRQUNwRyxJQUFJLFlBQVksR0FBRyxFQUFFLENBQUM7UUFDdEIsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNoQyxJQUFJLFFBQVEsR0FBRyxFQUFFLENBQUM7UUFDbEIsSUFBSTtZQUNBLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxZQUFZLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtnQkFDbEQsSUFBSSxNQUFNLEdBQUcsWUFBWSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDckMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRTtvQkFDM0IsTUFBTSxHQUFHLE1BQU0sQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7aUJBQ25EO2dCQUNELElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLEVBQUU7b0JBQ2hDLFlBQVksR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO29CQUNwQyxNQUFNO2lCQUNUO2FBQ0o7WUFFRCxJQUFJLFFBQVEsR0FBRyxHQUFHLFFBQVEsTUFBTSxDQUFDO1lBQ2pDLFFBQVEsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLHFCQUFxQixFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBQ3RELEVBQUUsQ0FBQyxhQUFhLENBQUMsUUFBUSxFQUFFLEtBQUssQ0FBQyxDQUFDO1lBQ2xDLE1BQU0sT0FBTyxHQUFHLEdBQUcsRUFBRTtnQkFDakIsSUFBSSxRQUFRLElBQUksRUFBRSxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUMsRUFBRTtvQkFDckMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUMsQ0FBQztpQkFDM0I7WUFDTCxDQUFDLENBQUE7WUFFRCxNQUFNLElBQUksR0FBRywyQkFBMkIsWUFBWSxVQUFVLFFBQVEsRUFBRSxDQUFDO1lBQ3pFLE1BQU0sSUFBSSxHQUFHLEVBQUUsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLEVBQUUsRUFBRSxFQUFFLEdBQUcsa0NBQU8sT0FBTyxDQUFDLEdBQUcsS0FBRSxZQUFZLEVBQUUsRUFBRSxHQUFFLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztZQUM1RyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRTtnQkFDWCxPQUFPO2FBQ1Y7WUFDRCxJQUFJLENBQUMsRUFBRSxDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUU7Z0JBQ2xCLE9BQU8sRUFBRSxDQUFDO2dCQUNWLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsZUFBZSxFQUFFO29CQUMzQyxHQUFHO2lCQUNOLENBQUMsQ0FBQztZQUNQLENBQUMsQ0FBQyxDQUFDO1lBQ0gsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFLENBQUMsSUFBUyxFQUFFLEVBQUU7Z0JBQ2pDLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7WUFDakMsQ0FBQyxDQUFDLENBQUM7WUFDSCxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxJQUFTLEVBQUUsRUFBRTtnQkFDakMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztZQUNqQyxDQUFDLENBQUMsQ0FBQztZQUNILElBQUksQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFLEdBQUcsRUFBRTtnQkFDakIsT0FBTyxFQUFFLENBQUM7Z0JBQ1YsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxlQUFlLEVBQUU7b0JBQzNDLE1BQU0sRUFBRSxRQUFRO29CQUNoQixHQUFHO2lCQUNOLENBQUMsQ0FBQztZQUNQLENBQUMsQ0FBQyxDQUFDO1NBQ047UUFBQyxPQUFPLEVBQUUsRUFBRTtZQUNULE9BQU8sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7U0FDbkI7SUFDTCxDQUFDO0lBRUssc0JBQXNCLENBQUMsR0FBVyxFQUFFLEtBQVksRUFBRSxRQUFnQjs7WUFDcEUsSUFBSTtnQkFDQSxNQUFNLElBQUksQ0FBQyxjQUFjLEVBQUUsQ0FBQztnQkFDNUIsTUFBTSxJQUFJLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUM3QixNQUFNLE1BQU0sR0FBRyxNQUFNLElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxFQUFFLFFBQVEsQ0FBQyxDQUFDO2dCQUN0RCxJQUFJLENBQUMsTUFBTSxFQUFFO29CQUNULE1BQU0sSUFBSSxLQUFLLENBQUMseUJBQXlCLENBQUMsQ0FBQztpQkFDOUM7Z0JBQ0QsTUFBTSxVQUFVLEdBQUcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDM0MsTUFBTSxpQkFBaUIsR0FBRyxJQUFJLHFDQUFpQixDQUFDLFVBQVUsQ0FBQyxDQUFDO2dCQUM1RCxNQUFNLGlCQUFpQixDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDM0MsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUU7b0JBQ25DLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsTUFBTSxFQUFFO3dCQUNsQyxNQUFNLEVBQUUsQ0FBQyxHQUFHLEtBQUssQ0FBQyxNQUFNO3dCQUN4QixLQUFLLEVBQUUsR0FBRztxQkFDYixDQUFDLENBQUM7b0JBQ0gsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxXQUFXLEVBQUU7d0JBQ3ZDLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDOzRCQUNqQixJQUFJLEVBQUUsYUFBYSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLOzRCQUNyQyxLQUFLLEVBQUUsRUFBRTt5QkFDWixDQUFDO3dCQUNGLEdBQUcsRUFBRSxHQUFHO3FCQUNYLENBQUMsQ0FBQztvQkFDSCxNQUFNLGlCQUFpQixDQUFDLGlCQUFpQixDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO2lCQUN2RDtnQkFDRCxNQUFNLGlCQUFpQixDQUFDLFdBQVcsRUFBRSxDQUFDO2dCQUV0QyxNQUFNLElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBQzdCLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsZUFBZSxFQUFFO29CQUMzQyxPQUFPLEVBQUUsS0FBSztvQkFDZCxPQUFPLEVBQUUsRUFBRTtvQkFDWCxLQUFLLEVBQUUsR0FBRztpQkFDYixDQUFDLENBQUM7YUFDTjtZQUFDLE9BQU8sRUFBTyxFQUFFO2dCQUNkLE9BQU8sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7Z0JBQ2hCLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsWUFBWSxFQUFFO29CQUN4QyxPQUFPLEVBQUUsRUFBRTtvQkFDWCxLQUFLLEVBQUUsR0FBRztpQkFDYixDQUFDLENBQUE7Z0JBQ0YsTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQzthQUNwQjtRQUNMLENBQUM7S0FBQTtJQUVLLGdCQUFnQixDQUFDLEdBQVcsRUFBRSxLQUFZLEVBQUUsUUFBZ0I7O1lBQzlELElBQUk7Z0JBQ0EsTUFBTSxJQUFJLENBQUMsY0FBYyxFQUFFLENBQUM7Z0JBQzVCLE1BQU0sSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDN0IsTUFBTSxJQUFJLENBQUMsWUFBWSxDQUFDLEdBQUcsRUFBRSxRQUFRLENBQUMsQ0FBQztnQkFDdkMsTUFBTSxVQUFVLEdBQUcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDM0MsSUFBSSxDQUFDLFVBQVUsRUFBRTtvQkFDYixNQUFNLElBQUksS0FBSyxDQUFDLHlCQUF5QixDQUFDLENBQUM7aUJBQzlDO2dCQUNELE1BQU0sV0FBVyxHQUFHLElBQUksc0JBQVcsQ0FBQyxVQUFVLENBQUMsQ0FBQztnQkFDaEQsV0FBVyxDQUFDLEVBQUUsQ0FBQyxVQUFVLEVBQUUsQ0FBQyxRQUFnQixFQUFFLEVBQUU7b0JBQzVDLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsTUFBTSxFQUFFO3dCQUNsQyxNQUFNLEVBQUUsT0FBTzt3QkFDZixNQUFNLEVBQUUsUUFBUTt3QkFDaEIsS0FBSyxFQUFFLEdBQUc7cUJBQ2IsQ0FBQyxDQUFDO2dCQUNQLENBQUMsQ0FBQyxDQUFDO2dCQUNILE1BQU0sV0FBVyxDQUFDLGtCQUFrQixDQUFDLEtBQUssQ0FBQyxDQUFDO2dCQUU1QyxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLGVBQWUsRUFBRTtvQkFDM0MsT0FBTyxFQUFFLEtBQUs7b0JBQ2QsT0FBTyxFQUFFLEVBQUU7b0JBQ1gsS0FBSyxFQUFFLEdBQUc7aUJBQ2IsQ0FBQyxDQUFDO2FBQ047WUFBQyxPQUFPLEVBQU8sRUFBRTtnQkFDZCxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO2dCQUNoQixJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLFlBQVksRUFBRTtvQkFDeEMsTUFBTSxFQUFFLE9BQU87b0JBQ2YsR0FBRztpQkFDTixDQUFDLENBQUM7Z0JBQ0gsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxPQUFPLEVBQUU7b0JBQ25DLElBQUksRUFBRSxFQUFFLENBQUMsT0FBTztvQkFDaEIsR0FBRyxFQUFFLEdBQUc7aUJBQ1gsQ0FBQyxDQUFDO2dCQUNILE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7Z0JBQ2pCLE1BQU0sSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQzthQUNoQztRQUNMLENBQUM7S0FBQTtJQUVELFNBQVMsQ0FBQyxHQUFXLEVBQUUsVUFBa0I7UUFDckMsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNuQyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRTtZQUNkLE9BQU87U0FDVjtRQUNELE1BQU0sU0FBUyxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsTUFBTSxHQUFHLFVBQVUsQ0FBQztRQUNsRCxJQUFJLFNBQVMsSUFBSSxDQUFDLEVBQUU7WUFDaEIsTUFBTSxDQUFDLGVBQWUsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sR0FBRyxVQUFVLENBQUE7U0FDM0Q7YUFDSTtZQUNELE1BQU0sQ0FBQyxlQUFlLEdBQUcsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sR0FBRyxTQUFTLENBQUMsR0FBRyxVQUFVLEdBQUcsQ0FBQyxDQUFDO1NBQzlFO1FBQ0QsTUFBTSxDQUFDLFNBQVMsR0FBRyxVQUFVLENBQUM7UUFDOUIsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxTQUFTLEVBQUUsQ0FBQyxFQUFFLEVBQUU7WUFDdkMsSUFBSSxZQUFZLEdBQUcsVUFBVSxHQUFHLENBQUMsQ0FBQztZQUNsQyxJQUFJLFNBQVMsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sQ0FBQyxTQUFTLEdBQUcsQ0FBQyxDQUFDLEdBQUcsVUFBVSxFQUFFLENBQUMsTUFBTSxDQUFDLFNBQVMsR0FBRyxDQUFDLENBQUMsR0FBRyxVQUFVLEdBQUcsVUFBVSxDQUFDLENBQUM7WUFFekgsTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsTUFBTSxHQUFHLFlBQVksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLE1BQU0sR0FBRyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFFakYsU0FBUyxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQztZQUM1QyxNQUFNLGFBQWEsR0FBRyxVQUFVLEdBQUcsQ0FBQyxDQUFDO1lBQ3JDLElBQUksU0FBUyxDQUFDLE1BQU0sR0FBRyxhQUFhLEVBQUU7Z0JBQ2xDLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsYUFBYSxHQUFHLFNBQVMsQ0FBQyxNQUFNLENBQUMsQ0FBQztnQkFDOUQsU0FBUyxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxTQUFTLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQzthQUNsRDtZQUVELElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxFQUFFLGNBQWMsQ0FBQyxNQUFNLEVBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO1lBQ25HLElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxFQUFFLGNBQWMsQ0FBQyxNQUFNLEVBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO1lBQ25HLElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxFQUFFLGNBQWMsQ0FBQyxNQUFNLEVBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO1NBQ3RHO0lBRUwsQ0FBQztJQUVELFlBQVksQ0FBQyxHQUFXLEVBQUUsT0FBZSxFQUFFLElBQVksRUFBRSxLQUFLLEdBQUcsSUFBSSxFQUFFLFFBQTRCLFNBQVM7UUFFeEcsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO1lBQzFDLElBQUksR0FBRyxLQUFLLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRzttQkFDeEIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssU0FBUzttQkFDbEMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssTUFBTSxFQUFFO2dCQUNwQyxPQUFPO2FBQ1Y7U0FDSjtRQUNELElBQUksSUFBSSxHQUFHLEtBQUssQ0FBQztRQUNqQixJQUFJO1lBQ0EsSUFBSSxJQUFJLElBQUksU0FBUyxFQUFFO2dCQUNuQixJQUFJLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQzthQUN6QjtZQUNELE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDbkMsTUFBTSxLQUFLLEdBQUcsR0FBRyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUM3QixLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtnQkFDbkMsS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO2FBQ3hDO1lBQ0QsR0FBRyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDdEIsTUFBTSxPQUFPLEdBQUcsS0FBSyxHQUFHLElBQUksT0FBTyxHQUFHLElBQUksRUFBRSxDQUFDO1lBQzdDLElBQUksS0FBSyxFQUFFO2dCQUNQLElBQUksQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDO29CQUN0QixlQUFlLEVBQUUsTUFBTSxDQUFDLGVBQWU7b0JBQ3ZDLE9BQU8sRUFBRSxPQUFPO29CQUNoQixLQUFLLEVBQUUsSUFBSTtvQkFDWCxLQUFLLEVBQUUsQ0FBQztvQkFDUixTQUFTLEVBQUUsSUFBSSxJQUFJLEVBQUUsQ0FBQyxPQUFPLEVBQUU7b0JBQy9CLE9BQU8sRUFBRSxPQUFPLEtBQUssY0FBYyxDQUFDLE1BQU07d0JBQ3RDLENBQUMsQ0FBQyxvQkFBb0I7d0JBQ3RCLENBQUMsQ0FBQyxhQUFhLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FBQyxNQUFNLEdBQUcsRUFBRTtpQkFDekQsQ0FBQyxDQUFDO2dCQUNILE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDO29CQUNyQixHQUFHLEVBQUUsR0FBRztvQkFDUixPQUFPLEVBQWtCLE9BQU87b0JBQ2hDLElBQUksRUFBRSxJQUFJO29CQUNWLEtBQUssRUFBRSxJQUFJO29CQUNYLFNBQVMsRUFBRSxJQUFJLElBQUksRUFBRSxDQUFDLE9BQU8sRUFBRTtpQkFDbEMsQ0FBQyxDQUFDO2FBQ047WUFDRCxJQUFJLE9BQU8sS0FBSyxjQUFjLENBQUMsVUFBVSxJQUFJLE9BQU8sS0FBSyxjQUFjLENBQUMsR0FBRyxFQUFFO2dCQUN6RSxNQUFNLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztnQkFDMUIsSUFBSSxPQUFPLEtBQUssY0FBYyxDQUFDLEdBQUcsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRTtvQkFDM0QsTUFBTSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO2lCQUMxQzthQUNKO1lBQ0QsTUFBTSxVQUFVLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxPQUFPLElBQUksSUFBSSxFQUFFLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ2hGLElBQUksQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLE1BQU0sQ0FBQyxlQUFlLEVBQUUsTUFBTSxDQUFDLEVBQUUsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1lBRS9GLElBQUksSUFBSSxDQUFDLEtBQUssSUFBSSxTQUFTLEVBQUU7Z0JBQ3pCLElBQUksQ0FBQyxLQUFLLEdBQUcsV0FBVyxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7YUFDbkU7U0FDSjtRQUNELE9BQU8sRUFBRSxFQUFFO1lBQ1AsTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQztTQUNwQjtJQUVMLENBQUM7SUFFRCxpQkFBaUI7UUFDYixNQUFNLFdBQVcsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBR3pDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNWLE9BQU8sQ0FBQyxHQUFHLElBQUksQ0FBQyxlQUFlLENBQUMsTUFBTSxFQUFFO1lBQ3BDLE1BQU0sY0FBYyxHQUFHLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDL0MsTUFBTSxPQUFPLEdBQUcsV0FBVyxHQUFHLGNBQWMsQ0FBQyxTQUFTLENBQUM7WUFFdkQsSUFBSSxPQUFPLEdBQUcsY0FBYyxDQUFDLE9BQU8sRUFBRTtnQkFFbEMsSUFBSSxjQUFjLENBQUMsS0FBSyxHQUFHLEVBQUUsRUFBRTtvQkFDM0IsTUFBTSxDQUFDLElBQUksQ0FBQyw0QkFBNEIsY0FBYyxDQUFDLEtBQUssY0FBYyxjQUFjLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztvQkFDcEcsSUFBSSxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO29CQUNsQyxJQUFJLENBQUMsMEJBQTBCLENBQUMsY0FBYyxDQUFDLENBQUM7b0JBQ2hELFNBQVM7aUJBQ1o7Z0JBR0QsSUFBSSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxjQUFjLENBQUMsZUFBZSxDQUFDLEVBQUU7b0JBQ3hELE1BQU0sQ0FBQyxJQUFJLENBQUMsa0RBQWtELGNBQWMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDO29CQUN4RixJQUFJLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7b0JBRWxDLFNBQVM7aUJBQ1o7Z0JBR0QsSUFBSSxjQUFjLENBQUMsT0FBTyxHQUFHLElBQUksRUFBRTtvQkFDL0IsY0FBYyxDQUFDLE9BQU8sSUFBSSxDQUFDLENBQUM7aUJBQy9CO2dCQUNELGNBQWMsQ0FBQyxLQUFLLEVBQUUsQ0FBQztnQkFDdkIsY0FBYyxDQUFDLFNBQVMsR0FBRyxXQUFXLENBQUM7Z0JBR3ZDLElBQUk7b0JBQ0EsTUFBTSxPQUFPLEdBQUcsY0FBYyxDQUFDLE9BQU8sQ0FBQztvQkFDdkMsTUFBTSxJQUFJLEdBQUcsY0FBYyxDQUFDLEtBQUssQ0FBQztvQkFDbEMsTUFBTSxVQUFVLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLE9BQU8sSUFBSSxJQUFJLEVBQUUsRUFBRSxRQUFRLENBQUMsQ0FBQztvQkFFL0QsTUFBTSxDQUFDLElBQUksQ0FBQyw2QkFBNkIsY0FBYyxDQUFDLEtBQUssTUFBTSxjQUFjLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztvQkFDN0YsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsY0FBYyxDQUFDLGVBQWUsQ0FBQyxDQUFDO2lCQUN6RDtnQkFBQyxPQUFPLEdBQVEsRUFBRTtvQkFDZixNQUFNLENBQUMsS0FBSyxDQUFDLDJCQUEyQixHQUFHLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztvQkFFdkQsSUFBSSxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO29CQUVsQyxTQUFTO2lCQUNaO2FBQ0o7WUFHRCxDQUFDLEVBQUUsQ0FBQztTQUNQO0lBQ0wsQ0FBQztJQUVPLGdCQUFnQixDQUFDLGVBQW9CO1FBQ3pDLElBQUksQ0FBQyxlQUFlLElBQUksQ0FBQyxlQUFlLENBQUMsTUFBTSxFQUFFO1lBQzdDLE9BQU8sS0FBSyxDQUFDO1NBQ2hCO1FBR0QsT0FBTyxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsS0FBSyxlQUFlLENBQUM7WUFDdkQsSUFBSSxDQUFDLGNBQWMsQ0FBQyxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDcEQsQ0FBQztJQUVPLDBCQUEwQixDQUFDLGNBQTBCO1FBQ3pELE1BQU0sUUFBUSxHQUFHLGNBQWMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLGNBQWMsQ0FBQyxDQUFDO1FBQzlELElBQUksQ0FBQyxRQUFRO1lBQUUsT0FBTztRQUV0QixNQUFNLEdBQUcsR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDeEIsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNuQyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUk7WUFBRSxPQUFPO1FBRXpCLE1BQU0sWUFBWSxHQUFHLGNBQWMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUM3RCxNQUFNLGVBQWUsR0FBRyxjQUFjLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUV2RSxNQUFNLGFBQWEsR0FBRyxlQUFlLENBQUMsVUFBVSxDQUFDLGNBQWMsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUN4RSxNQUFNLGtCQUFrQixHQUFHLGVBQWUsQ0FBQyxVQUFVLENBQUMsY0FBYyxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDeEYsTUFBTSxpQkFBaUIsR0FBRyxlQUFlLENBQUMsVUFBVSxDQUFDLGNBQWMsQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUVyRixJQUFJLENBQUMsYUFBYSxJQUFJLENBQUMsa0JBQWtCLElBQUksQ0FBQyxpQkFBaUI7WUFBRSxPQUFPO1FBRXhFLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxNQUFNLENBQUMsWUFBWSxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtZQUNqRCxJQUFJLE1BQU0sQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxLQUFLLGNBQWMsQ0FBQyxLQUFLLEVBQUU7Z0JBQ3ZELE1BQU0sQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztnQkFDakMsTUFBTTthQUNUO1NBQ0o7UUFFRCxNQUFNLENBQUMsYUFBYSxHQUFHLENBQUMsTUFBTSxDQUFDLGFBQWEsSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7UUFFdkQsSUFBSSxNQUFNLENBQUMsYUFBYSxHQUFHLGtCQUFrQixFQUFFO1lBQzNDLE1BQU0sQ0FBQyxLQUFLLENBQUMscUJBQXFCLEdBQUcsVUFBVSxNQUFNLENBQUMsYUFBYSxzQkFBc0IsQ0FBQyxDQUFDO1lBQzNGLElBQUksQ0FBQyxxQkFBcUIsQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUNoQyxJQUFJLENBQUMsdUJBQXVCLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDbEMsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxZQUFZLEVBQUU7Z0JBQ3hDLEdBQUcsRUFBRSxHQUFHO2dCQUNSLE1BQU0sRUFBRSxNQUFNO2FBQ2pCLENBQUMsQ0FBQztZQUNILElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsT0FBTyxFQUFFO2dCQUNuQyxJQUFJLEVBQUUseUJBQXlCLEdBQUcsaUJBQWlCO2dCQUNuRCxHQUFHLEVBQUUsR0FBRzthQUNYLENBQUMsQ0FBQztZQUNILE9BQU87U0FDVjtRQUVELE1BQU0sQ0FBQyxJQUFJLENBQUMsZ0NBQWdDLEdBQUcsdUJBQXVCLE1BQU0sQ0FBQyxhQUFhLElBQUksa0JBQWtCLEdBQUcsQ0FBQyxDQUFDO1FBQ3JILElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUVsQyxJQUFJLGtCQUFrQixFQUFFO1lBQ3BCLElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxFQUFFLGNBQWMsQ0FBQyxpQkFBaUIsRUFBRSxFQUFFLEVBQUUsSUFBSSxDQUFDLENBQUM7U0FDdEU7YUFBTSxJQUFJLGlCQUFpQixFQUFFO1lBQzFCLElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxFQUFFLGNBQWMsQ0FBQyxlQUFlLEVBQUUsRUFBRSxFQUFFLElBQUksQ0FBQyxDQUFDO1NBQ3BFO2FBQU07WUFDSCxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsRUFBRSxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUM7U0FDekM7SUFDTCxDQUFDO0lBRUQsTUFBTSxDQUFDLE1BQWM7UUFDakIsSUFBSSxNQUFNLEdBQUcsRUFBRSxDQUFDO1FBQ2hCLE1BQU0sVUFBVSxHQUFHLGlCQUFpQixDQUFDO1FBQ3JDLE1BQU0sZ0JBQWdCLEdBQUcsVUFBVSxDQUFDLE1BQU0sQ0FBQztRQUMzQyxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO1lBQzdCLE1BQU0sSUFBSSxVQUFVLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxHQUFHLGdCQUFnQixDQUFDLENBQUMsQ0FBQztTQUM3RTtRQUNELE9BQU8sTUFBTSxDQUFDO0lBQ2xCLENBQUM7SUFLTyxtQkFBbUIsQ0FBQyxTQUFpQixFQUFFLE9BQWU7UUFDMUQsSUFBSTtZQUVBLE1BQU0sRUFBRSxHQUFHLFNBQVMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQzVDLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBRzVDLE1BQU0sU0FBUyxHQUFHLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBRWpFLE9BQU8sU0FBUyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztTQUM5QjtRQUFDLE9BQU8sRUFBRSxFQUFFO1lBQ1QsTUFBTSxDQUFDLEtBQUssQ0FBQyxzQ0FBc0MsRUFBRSxFQUFFLENBQUMsQ0FBQztZQUN6RCxPQUFPLGlCQUFpQixDQUFDO1NBQzVCO0lBQ0wsQ0FBQztJQUVPLGNBQWMsQ0FBQyxNQUFvQjtRQUN2QyxJQUFJO1lBRUEsT0FBTyxNQUFNLElBQUksT0FBTyxNQUFNLENBQUMsSUFBSSxLQUFLLFVBQVUsQ0FBQztTQUN0RDtRQUFDLE9BQU8sR0FBRyxFQUFFO1lBQ1YsT0FBTyxLQUFLLENBQUM7U0FDaEI7SUFDTCxDQUFDO0lBRU8sWUFBWSxDQUFDLE1BQW9CLEVBQUUsT0FBZSxFQUFFLE9BQWUsRUFBRSxJQUFZO1FBQ3JGLE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7WUFDbkMsSUFBSTtnQkFDQSxJQUFJLENBQUMsSUFBSSxDQUFDLGNBQWMsQ0FBQyxNQUFNLENBQUMsRUFBRTtvQkFDOUIsTUFBTSxDQUFDLElBQUksS0FBSyxDQUFDLHNCQUFzQixDQUFDLENBQUMsQ0FBQztvQkFDMUMsT0FBTztpQkFDVjtnQkFHRCxNQUFNLFlBQVksR0FBRyxJQUFJLFVBQVUsQ0FBQyxPQUFPLENBQUMsQ0FBQztnQkFDN0MsTUFBTSxDQUFDLElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQyxFQUFFLFlBQVksQ0FBQyxNQUFNLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxDQUFDLEdBQUcsRUFBRSxFQUFFO29CQUNyRSxJQUFJLEdBQUcsRUFBRTt3QkFDTCxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7cUJBQ2Y7eUJBQU07d0JBQ0gsT0FBTyxFQUFFLENBQUM7cUJBQ2I7Z0JBQ0wsQ0FBQyxDQUFDLENBQUM7YUFDTjtZQUFDLE9BQU8sR0FBRyxFQUFFO2dCQUNWLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQzthQUNmO1FBQ0wsQ0FBQyxDQUFDLENBQUM7SUFDUCxDQUFDO0lBRUQsSUFBSSxDQUFDLE9BQWUsRUFBRSxZQUFrQixFQUFFLFFBQWlCO1FBQ3ZELE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDLGtCQUFrQixFQUFFLFVBQVUsT0FBTyxFQUFFLENBQUMsQ0FBQztRQUVuRSxJQUFJLGVBQWUsR0FBRyxJQUFJLENBQUMsZ0JBQWdCLENBQUM7UUFDNUMsSUFBSSxZQUFZLElBQUksU0FBUyxFQUFFO1lBQzNCLGVBQWUsR0FBRyxZQUFZLENBQUM7U0FDbEM7UUFFRCxJQUFJLGVBQWUsSUFBSSxTQUFTLEVBQUU7WUFDOUIsSUFBSSxDQUFDLHFCQUFxQixDQUFDLE9BQU8sRUFBRSxlQUFlLENBQUMsQ0FBQztTQUN4RDthQUFNO1lBQ0gsSUFBSSxDQUFDLG1CQUFtQixDQUFDLE9BQU8sQ0FBQyxDQUFDO1NBQ3JDO0lBQ0wsQ0FBQztJQUVPLHFCQUFxQixDQUFDLE9BQWUsRUFBRSxlQUFtQztRQUM5RSxJQUFJLENBQUMsSUFBSSxDQUFDLGNBQWMsQ0FBQyxlQUFlLENBQUMsTUFBTSxDQUFDLEVBQUU7WUFDOUMsTUFBTSxDQUFDLEtBQUssQ0FBQyx1Q0FBdUMsQ0FBQyxDQUFDO1lBQ3RELE9BQU87U0FDVjtRQUVELElBQUk7WUFDQSxNQUFNLGdCQUFnQixHQUFHLElBQUksQ0FBQyxtQkFBbUIsQ0FDN0MsZUFBZSxDQUFDLFlBQVksQ0FBQyxPQUFPLEVBQ3BDLGVBQWUsQ0FBQyxZQUFZLENBQUMsT0FBTyxDQUN2QyxDQUFDO1lBRUYsSUFBSSxDQUFDLFlBQVksQ0FBQyxlQUFlLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxJQUFJLENBQUM7aUJBQ3JFLEtBQUssQ0FBQyxHQUFHLENBQUMsRUFBRTtnQkFDVCxNQUFNLENBQUMsS0FBSyxDQUFDLHNDQUFzQyxFQUFFLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUN0RSxDQUFDLENBQUMsQ0FBQztTQUNWO1FBQUMsT0FBTyxHQUFRLEVBQUU7WUFDZixNQUFNLENBQUMsS0FBSyxDQUFDLGlEQUFpRCxFQUFFLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztTQUNoRjtJQUNMLENBQUM7SUFFTyxtQkFBbUIsQ0FBQyxPQUFlO1FBRXZDLE1BQU0saUJBQWlCLEdBQUcsQ0FBQyxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUUvQyxpQkFBaUIsQ0FBQyxPQUFPLENBQUMsQ0FBQyxhQUFhLEVBQUUsS0FBSyxFQUFFLEVBQUU7WUFDL0MsSUFBSSxDQUFDLElBQUksQ0FBQyxjQUFjLENBQUMsYUFBYSxDQUFDLE1BQU0sQ0FBQyxFQUFFO2dCQUM1QyxNQUFNLENBQUMsSUFBSSxDQUFDLGFBQWEsS0FBSyxpQ0FBaUMsQ0FBQyxDQUFDO2dCQUNqRSxPQUFPO2FBQ1Y7WUFFRCxJQUFJO2dCQUNBLE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxDQUFDLG1CQUFtQixDQUM3QyxhQUFhLENBQUMsWUFBWSxDQUFDLE9BQU8sRUFDbEMsYUFBYSxDQUFDLFlBQVksQ0FBQyxPQUFPLENBQ3JDLENBQUM7Z0JBRUYsSUFBSSxDQUFDLFlBQVksQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxJQUFJLENBQUM7cUJBQ25FLEtBQUssQ0FBQyxHQUFHLENBQUMsRUFBRTtvQkFDVCxNQUFNLENBQUMsS0FBSyxDQUFDLDhCQUE4QixLQUFLLEdBQUcsRUFBRSxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7Z0JBQ3RFLENBQUMsQ0FBQyxDQUFDO2FBQ1Y7WUFBQyxPQUFPLEdBQVEsRUFBRTtnQkFDZixNQUFNLENBQUMsS0FBSyxDQUFDLHlDQUF5QyxLQUFLLEdBQUcsRUFBRSxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7YUFDaEY7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNQLENBQUM7SUFFYSxXQUFXLENBQUMsT0FBZSxFQUFFLEdBQVc7O1lBQ2xELE1BQU0saUJBQWlCLEdBQUcsSUFBSSxDQUFDO1lBQy9CLE1BQU0sZUFBZSxHQUFHLEVBQUUsQ0FBQztZQUMzQixNQUFNLEtBQUssR0FBRyxDQUFDLENBQUM7WUFDaEIsSUFBSSxZQUFZLEdBQUcsRUFBRSxDQUFDO1lBQ3RCLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxLQUFLLEVBQUUsQ0FBQyxFQUFFLEVBQUU7Z0JBQzVCLElBQUk7b0JBQ0EsSUFBSSxVQUFVLEdBQUcsT0FBTyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO29CQUN2RCxJQUFJLENBQUMsV0FBVyxDQUFDLFVBQVUsQ0FBQyxHQUFHLElBQUksT0FBTyxFQUFFLENBQUM7b0JBQzdDLElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxFQUFFLGNBQWMsQ0FBQyxVQUFVLEVBQUUsVUFBVSxHQUFHLEtBQUssRUFBRSxJQUFJLENBQUMsQ0FBQztvQkFDNUUsTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLFVBQVUsQ0FBQyxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO29CQUMzRCxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUMsQ0FBQyxPQUFPLEVBQUU7d0JBQ3ZDLE1BQU0sSUFBSSxLQUFLLENBQUMsbUNBQW1DLENBQUMsQ0FBQztxQkFDeEQ7b0JBQ0QsTUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsVUFBVSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO29CQUN6RSxNQUFNLFlBQVksR0FBRyxPQUFPLEdBQUcsQ0FBQyxDQUFDO29CQUNqQyxJQUFJLE1BQU0sR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFVBQVUsR0FBRyxlQUFlLENBQUMsQ0FBQztvQkFDdEQsSUFBSSxVQUFVLEdBQUcsZUFBZSxJQUFJLENBQUMsRUFBRTt3QkFDbkMsTUFBTSxFQUFFLENBQUM7cUJBQ1o7b0JBQ0QsTUFBTSxhQUFhLEdBQUcsQ0FBQyxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO29CQUNoRCxNQUFNLE9BQU8sQ0FBQyxVQUFVLENBQ3BCLGFBQWEsQ0FBQyxHQUFHLENBQUMsQ0FBTyxLQUFLLEVBQUUsRUFBRTt3QkFDOUIsSUFBSSxLQUFLLEdBQUcsZUFBZSxDQUFDO3dCQUM1QixNQUFNLFVBQVUsR0FBRyxDQUFDLEtBQUssR0FBRyxlQUFlLENBQUMsQ0FBQzt3QkFDN0MsSUFBSSxVQUFVLEdBQUcsS0FBSyxHQUFHLFVBQVUsRUFBRTs0QkFDakMsS0FBSyxHQUFHLFVBQVUsR0FBRyxVQUFVLENBQUM7eUJBQ25DO3dCQUNELE1BQU0sVUFBVSxHQUFHLENBQUMsWUFBWSxHQUFHLEtBQUssR0FBRyxlQUFlLENBQUMsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQzt3QkFDMUYsSUFBSSxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUMsR0FBRyxJQUFJLE9BQU8sRUFBRSxDQUFDO3dCQUM3QyxNQUFNLENBQUMsSUFBSSxDQUFDLHlCQUF5QixLQUFLLEVBQUUsQ0FBQyxDQUFDO3dCQUM5QyxJQUFJLENBQUMsWUFBWSxDQUFDLEdBQUcsRUFBRSxjQUFjLENBQUMsVUFBVSxFQUFFLFVBQVUsR0FBRyxHQUFHLEdBQUcsS0FBSyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO3dCQUNoSCxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsVUFBVSxDQUFDLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7d0JBQzNELE1BQU0sQ0FBQyxJQUFJLENBQUMsMEJBQTBCLEtBQUssRUFBRSxDQUFDLENBQUM7b0JBQ25ELENBQUMsQ0FBQSxDQUFDLENBQ0wsQ0FBQztvQkFDRixLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO3dCQUM3QixNQUFNLEtBQUssR0FBRyxDQUFDLENBQUM7d0JBQ2hCLElBQUksS0FBSyxHQUFHLGVBQWUsQ0FBQzt3QkFDNUIsTUFBTSxVQUFVLEdBQUcsQ0FBQyxLQUFLLEdBQUcsZUFBZSxDQUFDLENBQUM7d0JBQzdDLElBQUksVUFBVSxHQUFHLEtBQUssR0FBRyxVQUFVLEVBQUU7NEJBQ2pDLEtBQUssR0FBRyxVQUFVLEdBQUcsVUFBVSxDQUFDO3lCQUNuQzt3QkFDRCxNQUFNLFVBQVUsR0FBRyxDQUFDLFlBQVksR0FBRyxLQUFLLEdBQUcsZUFBZSxDQUFDLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUM7d0JBQzFGLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLFVBQVUsQ0FBQyxDQUFDLE9BQU8sRUFBRTs0QkFDdkMsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQ0FBc0MsR0FBRyxVQUFVLENBQUMsQ0FBQzt5QkFDeEU7d0JBQ0QsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsVUFBVSxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTs0QkFDbEUsTUFBTSxRQUFRLEdBQUcsUUFBUSxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsVUFBVSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDOzRCQUN2RSxZQUFZLElBQUksTUFBTSxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUMsQ0FBQzt5QkFDakQ7d0JBQ0QsT0FBTyxJQUFJLENBQUMsV0FBVyxDQUFDLFVBQVUsQ0FBQyxDQUFDO3FCQUN2QztvQkFDRCxPQUFPLFlBQVksQ0FBQztpQkFDdkI7Z0JBQ0QsT0FBTyxFQUFFLEVBQUU7b0JBQ1AsTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQztvQkFDakIsTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQztpQkFDcEI7YUFDSjtZQUNELE9BQU8sWUFBWSxDQUFDO1FBQ3hCLENBQUM7S0FBQTtJQUVLLGFBQWEsQ0FBQyxHQUFXOztZQUMzQixNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQ25DLE1BQU0sQ0FBQyxTQUFTLEdBQUcsSUFBSSxPQUFPLEVBQUUsQ0FBQztZQUNqQyxJQUFJLENBQUMsWUFBWSxDQUFDLEdBQUcsRUFBRSxjQUFjLENBQUMsSUFBSSxFQUFFLEVBQUUsRUFBRSxJQUFJLENBQUMsQ0FBQztZQUN0RCxNQUFNLE1BQU0sQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2xDLE1BQU0sQ0FBQyxTQUFTLEdBQUcsU0FBUyxDQUFDO1lBQzdCLE9BQU8sTUFBTSxDQUFDO1FBQ2xCLENBQUM7S0FBQTtJQUVELFNBQVMsQ0FBQyxHQUFXO1FBQ2pCLE1BQU0sS0FBSyxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDN0IsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUU7WUFDbkMsS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLEVBQUUsQ0FBQztTQUMxQztRQUNELEdBQUcsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ3RCLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtZQUMxQyxJQUFJLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLEdBQUcsRUFBRTtnQkFDNUIsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO2FBQzFCO1NBQ0o7UUFFRCxNQUFNLE1BQU0sR0FBRztZQUNYLEVBQUUsRUFBRSxFQUFFO1lBQ04sR0FBRyxFQUFFLEdBQUc7WUFDUixZQUFZLEVBQUUsRUFBRTtZQUNoQixJQUFJLEVBQUUsRUFBRTtZQUNSLEdBQUcsRUFBRSxFQUFFO1lBQ1AsVUFBVSxFQUFFLEVBQUU7WUFDZCxTQUFTLEVBQUUsQ0FBQztZQUNaLGVBQWUsRUFBRSxDQUFDO1lBQ2xCLElBQUksRUFBRSxNQUFNO1lBQ1osS0FBSyxFQUFFLENBQUMsQ0FBQztZQUNULFNBQVMsRUFBRSxDQUFDO1lBQ1osS0FBSyxFQUFFLGlCQUFpQixDQUFDLE9BQU87U0FDbkMsQ0FBQztRQUVGLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQzFCLE9BQU8sTUFBTSxDQUFDO0lBQ2xCLENBQUM7SUFFSyxlQUFlLENBQUMsT0FBb0I7O1lBQ3RDLElBQUk7Z0JBQ0EsTUFBTSxRQUFRLEdBQUcsTUFBTSxlQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRTtvQkFDdEMsTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFnQjtvQkFDaEMsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPO29CQUN4QixJQUFJLEVBQUUsT0FBTyxDQUFDLElBQUk7aUJBQ3JCLENBQUMsQ0FBQztnQkFDSCxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLGFBQWEsRUFBRTtvQkFDekMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxLQUFLO29CQUNwQixNQUFNLEVBQUUsUUFBUSxDQUFDLE1BQU07b0JBQ3ZCLEdBQUcsRUFBRSxPQUFPLENBQUMsR0FBRztvQkFDaEIsSUFBSSxFQUFFLFFBQVEsQ0FBQyxJQUFJO2lCQUN0QixDQUFDLENBQUM7YUFDTjtZQUFDLE9BQU8sS0FBVSxFQUFFO2dCQUNqQixJQUFJLEtBQUssQ0FBQyxRQUFRLEVBQUU7b0JBQ2hCLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsYUFBYSxFQUFFO3dCQUN6QyxLQUFLLEVBQUUsT0FBTyxDQUFDLEtBQUs7d0JBQ3BCLE1BQU0sRUFBRSxLQUFLLENBQUMsUUFBUSxDQUFDLE1BQU07d0JBQzdCLEdBQUcsRUFBRSxPQUFPLENBQUMsR0FBRzt3QkFDaEIsSUFBSSxFQUFFLEtBQUssQ0FBQyxRQUFRLENBQUMsSUFBSTtxQkFDNUIsQ0FBQyxDQUFDO2lCQUNOO3FCQUFNO29CQUNILE1BQU0sQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7aUJBQ3ZCO2FBQ0o7UUFDTCxDQUFDO0tBQUE7SUFFRCxJQUFJLENBQUMsT0FBZSxFQUFFLE9BQVk7UUFDOUIsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLFNBQVMsRUFBRTtZQUMzQixJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsT0FBTyxDQUFDLENBQUM7U0FDdEM7UUFDRCxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDdkMsQ0FBQztJQUVELEtBQUs7UUFDRCxNQUFNLENBQUMsSUFBSSxDQUFDLHNCQUFzQixDQUFDLENBQUM7UUFHcEMsSUFBSSxDQUFDLGtCQUFrQixFQUFFLENBQUM7UUFHMUIsSUFBSSxDQUFDLHNCQUFzQixFQUFFLENBQUM7UUFHOUIsSUFBSSxJQUFJLENBQUMsTUFBTSxFQUFFO1lBQ2IsSUFBSSxDQUFDLE1BQU0sQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1lBQ2pDLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLENBQUM7WUFDcEIsSUFBSSxDQUFDLE1BQU0sR0FBRyxTQUFTLENBQUM7U0FDM0I7UUFHRCxJQUFJLENBQUMsb0JBQW9CLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDO1FBQ2hELElBQUksQ0FBQyxVQUFVLEdBQUcsRUFBRSxDQUFDO1FBQ3JCLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxTQUFTLENBQUM7UUFHbEMsSUFBSSxDQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7UUFDbEIsSUFBSSxDQUFDLGlCQUFpQixHQUFHLEVBQUUsQ0FBQztRQUU1QixNQUFNLENBQUMsSUFBSSxDQUFDLCtCQUErQixDQUFDLENBQUM7SUFDakQsQ0FBQztJQUVELFVBQVU7UUFDTixPQUFPLElBQUksQ0FBQyxPQUFPLENBQUM7SUFDeEIsQ0FBQztJQUVLLElBQUk7O1lBQ04sSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ2IsTUFBTSxJQUFJLE9BQU8sQ0FBTyxDQUFDLE9BQU8sRUFBRSxFQUFFO2dCQUNoQyxFQUFFLENBQUMsa0JBQWtCLEVBQUUsQ0FBQztnQkFDeEIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO2dCQUNqQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRTtvQkFDVixPQUFPLEVBQUUsQ0FBQztnQkFDZCxDQUFDLENBQUMsQ0FBQztZQUNQLENBQUMsQ0FBQyxDQUFDO1FBQ1AsQ0FBQztLQUFBO0lBRUssY0FBYzs7WUFDaEIsTUFBTSxLQUFLLEdBQUcsTUFBTSx1QkFBVSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ3RDLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO2dCQUNuQyxJQUFJLEtBQUssR0FBRyxLQUFLLENBQUM7Z0JBQ2xCLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtvQkFDMUMsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFO3dCQUN0QyxLQUFLLEdBQUcsSUFBSSxDQUFDO3dCQUNiLE1BQU07cUJBQ1Q7aUJBQ0o7Z0JBQ0QsTUFBTSxFQUNGLElBQUksRUFBRSxZQUFZLEVBQUUsWUFBWSxFQUFFLEtBQUssRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLFFBQVEsR0FDM0UsR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQ2IsTUFBTSxNQUFNLEdBQUc7b0JBQ1gsRUFBRSxFQUFFLEVBQUU7b0JBQ04sR0FBRyxFQUFFLElBQUk7b0JBQ1QsWUFBWSxFQUFFLEVBQUU7b0JBQ2hCLElBQUksRUFBRSxFQUFFO29CQUNSLEdBQUcsRUFBRSxFQUFFO29CQUNQLFVBQVUsRUFBRSxFQUFFO29CQUNkLFNBQVMsRUFBRSxDQUFDO29CQUNaLGVBQWUsRUFBRSxDQUFDO29CQUNsQixJQUFJLEVBQUUsUUFBUTtvQkFDZCxLQUFLLEVBQUUsQ0FBQyxDQUFDO29CQUNULFNBQVMsRUFBRSxDQUFDO29CQUNaLEtBQUssRUFBRSxpQkFBaUIsQ0FBQyxPQUFPO2lCQUNuQyxDQUFDO2dCQUNGLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsTUFBTSxFQUFFO29CQUNsQyxFQUFFLEVBQUUsTUFBTSxDQUFDLEVBQUU7b0JBQ2IsR0FBRyxFQUFFLE1BQU0sQ0FBQyxHQUFHO29CQUNmLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSTtvQkFDakIsR0FBRyxFQUFFLE1BQU0sQ0FBQyxHQUFHO29CQUNmLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSztvQkFDbkIsVUFBVSxFQUFFLE1BQU0sQ0FBQyxVQUFVO29CQUM3QixJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUk7aUJBQ3BCLENBQUMsQ0FBQztnQkFDSCxJQUFJLENBQUMsS0FBSyxFQUFFO29CQUNSLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO2lCQUM3QjthQUNKO1FBQ0wsQ0FBQztLQUFBO0lBRUssWUFBWSxDQUFDLElBQVksRUFBRSxXQUFtQixNQUFNLEVBQUUsUUFBaUIsS0FBSzs7WUFDOUUsSUFBSTtnQkFDQSxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUU7b0JBQzFDLElBQUksSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksSUFBSSxFQUFFO3dCQUM3QixNQUFNLFVBQVUsR0FBRyxJQUFJLHdCQUFZLENBQUMsSUFBSSxDQUFDLENBQUM7d0JBQzFDLFVBQVUsQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFLENBQUMsSUFBUyxFQUFFLEVBQUU7NEJBQ2hDLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsV0FBVyxFQUFFO2dDQUN2QyxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztvQ0FDakIsSUFBSSxFQUFFLElBQUksV0FBVyxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQztvQ0FDcEMsS0FBSyxFQUFFLEVBQUU7aUNBQ1osQ0FBQztnQ0FDRixHQUFHLEVBQUUsSUFBSTs2QkFDWixDQUFDLENBQUM7d0JBQ1AsQ0FBQyxDQUFDLENBQUM7d0JBQ0gsVUFBVSxDQUFDLEVBQUUsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxLQUFLLEVBQUUsRUFBRTs0QkFDN0IsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxPQUFPLEVBQUU7Z0NBQ25DLElBQUksRUFBRSxLQUFLLENBQUMsT0FBTztnQ0FDbkIsR0FBRyxFQUFFLElBQUk7NkJBQ1osQ0FBQyxDQUFDO3dCQUNQLENBQUMsQ0FBQyxDQUFDO3dCQUNILFVBQVUsQ0FBQyxFQUFFLENBQUMsT0FBTyxFQUFFLENBQUMsS0FBSyxFQUFFLEVBQUU7NEJBQzdCLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsYUFBYSxFQUFFO2dDQUN6QyxHQUFHLEVBQUUsSUFBSTtnQ0FDVCxPQUFPLEVBQUUsSUFBSTs2QkFDaEIsQ0FBQyxDQUFDOzRCQUNILElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsT0FBTyxFQUFFO2dDQUNuQyxJQUFJLEVBQUUsS0FBSyxDQUFDLE9BQU87Z0NBQ25CLEdBQUcsRUFBRSxJQUFJOzZCQUNaLENBQUMsQ0FBQzt3QkFDUCxDQUFDLENBQUMsQ0FBQzt3QkFDSCxNQUFNLFNBQVMsR0FBRyxNQUFNLFVBQVUsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7d0JBQ3JELElBQUksQ0FBQyxTQUFTLEVBQUU7NEJBQ1osT0FBTyxLQUFLLENBQUM7eUJBQ2hCO3dCQUNELElBQUksS0FBSyxFQUFFOzRCQUNQLE1BQU0sVUFBVSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQzs0QkFDL0IsTUFBTSxVQUFVLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDO3lCQUNsQzt3QkFDRCxJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxHQUFHLFVBQVUsQ0FBQzt3QkFDdEMsT0FBTyxJQUFJLENBQUM7cUJBQ2Y7aUJBQ0o7Z0JBQ0QsT0FBTyxLQUFLLENBQUM7YUFDaEI7WUFBQyxPQUFPLEVBQUUsRUFBRTtnQkFDVCxNQUFNLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7Z0JBQ3ZDLE9BQU8sS0FBSyxDQUFDO2FBQ2hCO1FBQ0wsQ0FBQztLQUFBO0lBRUssWUFBWSxDQUFDLElBQVk7O1lBQzNCLElBQUk7Z0JBQ0EsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO29CQUMxQyxJQUFJLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLElBQUksRUFBRTt3QkFDN0IsTUFBTSxJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxDQUFDLFVBQVUsRUFBRSxDQUFDO3dCQUM1QyxPQUFPLElBQUksQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUM7cUJBQ25DO2lCQUNKO2FBQ0o7WUFBQyxPQUFPLEVBQUUsRUFBRTtnQkFDVCxNQUFNLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7YUFDMUM7UUFDTCxDQUFDO0tBQUE7Q0FDSjtBQWprRUQsOEJBaWtFQztBQWdDRCxJQUFZLGlCQU1YO0FBTkQsV0FBWSxpQkFBaUI7SUFDekIsb0NBQWUsQ0FBQTtJQUNmLGdDQUFXLENBQUE7SUFDWCxtQ0FBYyxDQUFBO0lBQ2QsaURBQTRCLENBQUE7SUFDNUIscURBQWdDLENBQUE7QUFDcEMsQ0FBQyxFQU5XLGlCQUFpQixHQUFqQix5QkFBaUIsS0FBakIseUJBQWlCLFFBTTVCO0FBRUQsSUFBWSxXQUlYO0FBSkQsV0FBWSxXQUFXO0lBQ25CLG1EQUFXLENBQUE7SUFDWCxpREFBVSxDQUFBO0lBQ1YsbURBQVcsQ0FBQTtBQUNmLENBQUMsRUFKVyxXQUFXLEdBQVgsbUJBQVcsS0FBWCxtQkFBVyxRQUl0QjtBQTBCRCxJQUFZLGNBbUJYO0FBbkJELFdBQVksY0FBYztJQUN0Qiw4QkFBWSxDQUFBO0lBQ1osNEJBQVUsQ0FBQTtJQUNWLDhCQUFZLENBQUE7SUFDWixtQ0FBaUIsQ0FBQTtJQUNqQixtQ0FBaUIsQ0FBQTtJQUNqQixxQ0FBbUIsQ0FBQTtJQUNuQixxQ0FBbUIsQ0FBQTtJQUNuQixtQ0FBaUIsQ0FBQTtJQUNqQiw2QkFBVyxDQUFBO0lBQ1gsb0NBQWtCLENBQUE7SUFDbEIsaUNBQWUsQ0FBQTtJQUNmLDRCQUFVLENBQUE7SUFDVix5Q0FBdUIsQ0FBQTtJQUN2QixtREFBaUMsQ0FBQTtJQUNqQyw4QkFBWSxDQUFBO0lBQ1osdUNBQXFCLENBQUE7SUFDckIsNEJBQVUsQ0FBQTtJQUNWLCtCQUFhLENBQUE7QUFDakIsQ0FBQyxFQW5CVyxjQUFjLEdBQWQsc0JBQWMsS0FBZCxzQkFBYyxRQW1CekI7QUFFRCxJQUFZLG1CQXVCWDtBQXZCRCxXQUFZLG1CQUFtQjtJQUMzQiwwQ0FBbUIsQ0FBQTtJQUNuQix3Q0FBaUIsQ0FBQTtJQUNqQixvQ0FBYSxDQUFBO0lBQ2Isd0NBQWlCLENBQUE7SUFDakIsd0NBQWlCLENBQUE7SUFDakIsNENBQXFCLENBQUE7SUFDckIseURBQWtDLENBQUE7SUFDbEMsMERBQW1DLENBQUE7SUFDbkMsc0NBQWUsQ0FBQTtJQUNmLDBDQUFtQixDQUFBO0lBQ25CLHNDQUFlLENBQUE7SUFDZiwwRUFBbUQsQ0FBQTtJQUNuRCxrREFBMkIsQ0FBQTtJQUMzQixvQ0FBYSxDQUFBO0lBQ2Isc0RBQStCLENBQUE7SUFDL0Isc0RBQStCLENBQUE7SUFDL0Isc0RBQStCLENBQUE7SUFDL0IsNENBQXFCLENBQUE7SUFDckIsb0RBQTZCLENBQUE7SUFDN0Isb0RBQTZCLENBQUE7SUFDN0IsMENBQW1CLENBQUE7SUFDbkIsa0RBQTJCLENBQUE7QUFDL0IsQ0FBQyxFQXZCVyxtQkFBbUIsR0FBbkIsMkJBQW1CLEtBQW5CLDJCQUFtQixRQXVCOUIifQ==
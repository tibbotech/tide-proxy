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
const gdb_server_1 = require("./gdb-server");
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
    return path.join(__dirname, '..', 'platforms');
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
        socket.on(TIBBO_PROXY_MESSAGE.FIRMWARE_UPLOAD, (message) => {
            this.startFirmwareUpload(message.mac, message.data, message.deviceDefinition);
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
        socket.on(TIBBO_PROXY_MESSAGE.START_GDB, (message, ack) => __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                const port = yield this.startGdbServer(message.mac, message.console);
                if (typeof ack === 'function') {
                    ack({ port });
                }
                this.emit(TIBBO_PROXY_MESSAGE.GDB_STARTED, { mac: message.mac, port });
            }
            catch (ex) {
                logger.error(`failed to start GDB server: ${(_a = ex === null || ex === void 0 ? void 0 : ex.message) !== null && _a !== void 0 ? _a : ex}`);
                if (typeof ack === 'function') {
                    ack({ error: (_b = ex === null || ex === void 0 ? void 0 : ex.message) !== null && _b !== void 0 ? _b : String(ex) });
                }
            }
        }));
        socket.on(TIBBO_PROXY_MESSAGE.STOP_GDB, () => {
            this.stopGdbServer();
        });
    }
    startGdbServer(mac, withConsole = false) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.gdbProxyServer === undefined) {
                this.gdbProxyServer = new gdb_server_1.GdbProxyServer(this.listenPort);
            }
            const port = yield this.gdbProxyServer.start();
            this.gdbProxyServer.setTarget(mac);
            if (withConsole) {
                this.gdbProxyServer.onConsoleOutput((text) => {
                    this.emit(TIBBO_PROXY_MESSAGE.GDB_CONSOLE, { mac, data: text });
                });
            }
            else {
                this.gdbProxyServer.detachConsoleOutput();
            }
            return port;
        });
    }
    stopGdbServer() {
        if (this.gdbProxyServer) {
            this.gdbProxyServer.dispose();
            this.gdbProxyServer = undefined;
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
                    if (device.resetProgrammingToken
                        && device.resetProgrammingToken.command === replyForCommand) {
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
    extractDeviceIdFromBinary(bytes) {
        const marker = bytes.indexOf('<FD>', 0, 'binary');
        if (marker < 0) {
            return undefined;
        }
        let pos = marker + 4;
        const fields = [];
        while (pos < bytes.length && fields.length < 8) {
            while (pos < bytes.length && (bytes[pos] === 0 || bytes[pos] === 0x20)) {
                pos++;
            }
            const end = bytes.indexOf(0, pos);
            if (end < 0) {
                break;
            }
            const field = bytes.slice(pos, end).toString('binary').trim();
            if (field) {
                fields.push(field);
            }
            pos = end + 1;
        }
        const partVersion = fields[2];
        if (!partVersion) {
            return undefined;
        }
        const dash = partVersion.lastIndexOf('-');
        return dash > 0 ? partVersion.slice(0, dash) : partVersion;
    }
    resolveTiosFirmwarePath(deviceDefinition, deviceId) {
        if (typeof (deviceDefinition === null || deviceDefinition === void 0 ? void 0 : deviceDefinition.tiosFirmwarePath) === 'string'
            && fs.existsSync(deviceDefinition.tiosFirmwarePath)) {
            return deviceDefinition.tiosFirmwarePath;
        }
        const root = (deviceDefinition === null || deviceDefinition === void 0 ? void 0 : deviceDefinition.platformsDir)
            || process.env.TIDE_PLATFORMS_DIR
            || resolveAtPlatformsPackageRoot();
        const platform = deviceId || (deviceDefinition === null || deviceDefinition === void 0 ? void 0 : deviceDefinition.platform) || (deviceDefinition === null || deviceDefinition === void 0 ? void 0 : deviceDefinition.id);
        if (!root || !platform) {
            return undefined;
        }
        const firmwareDir = path.join(root, 'Platforms', platform, 'firmware');
        if (fs.existsSync(firmwareDir) && fs.statSync(firmwareDir).isDirectory()) {
            const explicit = (deviceDefinition === null || deviceDefinition === void 0 ? void 0 : deviceDefinition.tiosFirmware) || (deviceDefinition === null || deviceDefinition === void 0 ? void 0 : deviceDefinition.firmwareFile);
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
        const legacyName = (deviceDefinition === null || deviceDefinition === void 0 ? void 0 : deviceDefinition.tiosFirmware) || (deviceDefinition === null || deviceDefinition === void 0 ? void 0 : deviceDefinition.firmwareFile) || 'firmware.bin';
        const legacy = path.join(root, platform, 'firmware', legacyName);
        if (fs.existsSync(legacy)) {
            return legacy;
        }
        return undefined;
    }
    startApplicationUpload(mac, fileString, deviceDefinition, method, files, baudRate = 115200) {
        var _a;
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
                const isPlainTpc = bytes.length >= 12
                    && bytes.slice(0, 4).toString('binary') === 'TBIN'
                    && bytes.slice(-4).toString('binary') === 'TBIN';
                if (!isPlainTpc) {
                    yield this.startFirmwareUpload(mac, fileString, deviceDefinition);
                    return;
                }
                const device = this.getDevice(mac);
                this.stopApplicationUpload(mac);
                this.clearDeviceMessageQueue(mac);
                device.fileIndex = 0;
                device.uploadRetries = 0;
                device.deviceDefinition = deviceDefinition;
                device.file = bytes;
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
                const deviceId = this.extractDeviceIdFromBinary(bytes);
                if (deviceId) {
                    device.deviceId = deviceId;
                    logger.info(`extracted device id "${deviceId}" from binary for ${mac}`);
                }
                const deviceInfo = yield this.getDeviceInfo(mac);
                const inLoader = deviceInfo.tios.indexOf('TiOS-32 Loader') >= 0;
                let qAcked = false;
                if (!inLoader) {
                    device.resetProgrammingToken = new Subject();
                    device.resetProgrammingToken.command = PCODE_COMMANDS.RESET_PROGRAMMING;
                    this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING, '', true);
                    yield device.resetProgrammingToken.wait(5000);
                    qAcked = !!device.resetProgrammingToken
                        && device.resetProgrammingToken.message === REPLY_OK;
                    device.resetProgrammingToken = undefined;
                }
                if (qAcked) {
                    this.beginUploadStream(mac);
                    return;
                }
                const firmwarePath = this.resolveTiosFirmwarePath(deviceDefinition, deviceId);
                if (!firmwarePath) {
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
                        data: `Could not read TIOS firmware: ${firmwarePath}: ${(_a = e === null || e === void 0 ? void 0 : e.message) !== null && _a !== void 0 ? _a : e}`,
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
                const combined = Buffer.concat([firmwareBytes, bytes]);
                yield this.startFirmwareUpload(mac, combined.toString('binary'), deviceDefinition);
            }
        });
    }
    startFirmwareUpload(mac, fileString, deviceDefinition) {
        return __awaiter(this, void 0, void 0, function* () {
            fileString = fileString || '';
            const bytes = Buffer.from(fileString, 'binary');
            logger.info('starting firmware upload for ' + mac);
            let device = this.getDevice(mac);
            const isZephyr = !(bytes.length >= 8
                && bytes.slice(-4).toString('binary') === 'TBIN');
            this.stopApplicationUpload(mac);
            this.clearDeviceMessageQueue(mac);
            device.fileIndex = 0;
            device.uploadRetries = 0;
            device.deviceDefinition = deviceDefinition;
            device.file = bytes;
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
            const inLoader = deviceInfo.tios.indexOf('TiOS-32 Loader') >= 0;
            if (!inLoader) {
                device.resetProgrammingToken = new Subject();
                device.resetProgrammingToken.command = PCODE_COMMANDS.RESET_PROGRAMMING_FIRMWARE;
                this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING_FIRMWARE, '', true);
                let qfRetry;
                if (isZephyr) {
                    qfRetry = setTimeout(() => {
                        if (device.resetProgrammingToken
                            && device.resetProgrammingToken.message !== REPLY_OK) {
                            this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING_FIRMWARE, '', true);
                        }
                    }, 3000);
                }
                yield device.resetProgrammingToken.wait(10000);
                if (qfRetry)
                    clearTimeout(qfRetry);
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
            this.beginUploadStream(mac);
        });
    }
    beginUploadStream(mac) {
        const device = this.getDevice(mac);
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
        const paddedParts = mac.split('.').map(p => p.padStart(3, '0'));
        const paddedMac = paddedParts.join('.');
        for (let i = this.pendingMessages.length - 1; i >= 0; i--) {
            if (this.pendingMessages[i].message.indexOf(`[${paddedMac}]`) !== -1) {
                this.pendingMessages.splice(i, 1);
            }
        }
        device.blockSize = 1;
        if (device.file != null) {
            this.sendBlock(mac, 0);
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
        const isResetProgrammingFirmware = msgAfterBracket.startsWith(PCODE_COMMANDS.RESET_PROGRAMMING_FIRMWARE);
        const isResetProgramming = !isResetProgrammingFirmware
            && msgAfterBracket.startsWith(PCODE_COMMANDS.RESET_PROGRAMMING);
        const isAppUploadFinish = msgAfterBracket.startsWith(PCODE_COMMANDS.APPUPLOADFINISH);
        if (!isUploadBlock && !isResetProgramming && !isResetProgrammingFirmware && !isAppUploadFinish)
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
        if (isResetProgrammingFirmware) {
            this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING_FIRMWARE, '', true);
        }
        else if (isResetProgramming) {
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
            yield device.infoToken.wait(10000);
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
        this.stopGdbServer();
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
    TIBBO_PROXY_MESSAGE["FIRMWARE_UPLOAD"] = "firmware";
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
    TIBBO_PROXY_MESSAGE["START_GDB"] = "start_gdb";
    TIBBO_PROXY_MESSAGE["STOP_GDB"] = "stop_gdb";
    TIBBO_PROXY_MESSAGE["GDB_STARTED"] = "gdb_started";
    TIBBO_PROXY_MESSAGE["GDB_CONSOLE"] = "gdb_console";
})(TIBBO_PROXY_MESSAGE = exports.TIBBO_PROXY_MESSAGE || (exports.TIBBO_PROXY_MESSAGE = {}));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGlkZS1wcm94eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy90aWRlLXByb3h5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBK0I7QUFDL0IsMkNBQXlDO0FBQ3pDLDJDQUF1QztBQUN2QywyREFBd0Q7QUFDeEQsNkNBQW9FO0FBQ3BFLHNFQUE0QztBQUM1Qyw2Q0FBOEM7QUFHOUMsdURBQXdEO0FBQ3hELGtEQUFzQztBQUN0QyxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsZUFBZSxDQUFDLENBQUM7QUFDcEMsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3pCLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUM3QixNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDbkMsTUFBTSxHQUFHLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQzNCLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FBQyxXQUFXLENBQUMsQ0FBQyxFQUFFLFdBQVcsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxFQUFFLGlCQUFpQixFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7QUFDeEcsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3pCLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUM3QixNQUFNLEVBQUUsT0FBTyxFQUFFLEdBQUcsT0FBTyxDQUFDLGNBQWMsQ0FBQyxDQUFDO0FBRTVDLE1BQU0sYUFBYSxHQUFHLEVBQUUsQ0FBQztBQUN6QixNQUFNLElBQUksR0FBRyxLQUFLLENBQUM7QUFHbkIsTUFBTSxRQUFRLEdBQUcsR0FBRyxDQUFDO0FBQ3JCLE1BQU0sZUFBZSxHQUFHLEdBQUcs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
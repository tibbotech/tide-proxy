import * as dgram from 'dgram';
import { performance } from 'perf_hooks';
import { SerialPort } from 'serialport'
import { MicropythonSerial } from './MicropythonSerial';
import { NodeESP32Serial as ESP32Serial } from './ESP32Serial/node';
import SerialDevice from './NodeSerialPort';

// import { TibboDevice, PCODE_STATE, TaikoMessage, TIBBO_PROXY_MESSAGE, TaikoReply, PCODEMachineState, PCODE_COMMANDS } from './types';
import { io as socketIOClient } from 'socket.io-client';
import axios, { Method } from 'axios';
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
const MAX_FILE_SIZE = 65535 * BLOCK_SIZE; // 16-bit block index cap
const UPLOAD_STALL_TIMEOUT_MS = 9000;
const UPLOAD_BLOCK_TIMEOUT = 200;

interface UDPMessage {
    deviceInterface: any,
    message: string,
    nonce: string,
    tries: number,
    timestamp: number,
    timeout: number,
}

export interface TIDEProxyToolPaths {
    openocd?: string;
    bossac?: string;
    jlink?: string;
    dfuUtil?: string;
}

export interface TIDEProxyOptions {
    serverAddress?: string;
    proxyName?: string;
    port?: number;
    targetInterface?: string;
    toolPaths?: TIDEProxyToolPaths;
}

interface TBNetworkInterface {
    socket: dgram.Socket,
    netInterface: any
}

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

function openocdFirmwareExtension(buf: Buffer): 'elf' | 'hex' {
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

/** `{projectRoot}/platforms`, where project root is `process.cwd()`. Expects `Platforms/<id>/firmware/` under that. */
function resolveAtPlatformsPackageRoot(): string {
    return path.join(process.cwd(), 'platforms');
}

export class TIDEProxy {
    devices: Array<TibboDevice> = [];
    pendingMessages: Array<UDPMessage> = [];
    timer?: NodeJS.Timeout;
    interfaces: Array<TBNetworkInterface> = [];
    currentInterface: TBNetworkInterface | undefined = undefined;
    socket: any;
    server: any;
    memoryCalls: { [key: string]: any } = {};
    discoveredDevices: { [key: string]: string } = {};
    id: string;
    clients: any[];
    listenPort: number;
    serialDevices: { [key: string]: SerialDevice } = {};
    adks: any[] = [];
    networkWatcherTimer?: NodeJS.Timeout;
    lastInterfaceState: string = '';
    toolPaths: TIDEProxyToolPaths;

    constructor(serverAddress: string, proxyName: string, port?: number, targetInterface?: string, options?: TIDEProxyOptions);
    constructor(options: TIDEProxyOptions);
    constructor(
        serverAddressOrOptions: string | TIDEProxyOptions = '',
        proxyName?: string,
        port: number = 3535,
        targetInterface?: string,
        options?: TIDEProxyOptions
    ) {
        // Handle both constructor signatures
        let serverAddress: string;
        let actualProxyName: string;
        let actualPort: number;
        let actualTargetInterface: string | undefined;
        let toolPaths: TIDEProxyToolPaths;

        if (typeof serverAddressOrOptions === 'object') {
            // New options-based constructor
            serverAddress = serverAddressOrOptions.serverAddress || '';
            actualProxyName = serverAddressOrOptions.proxyName || '';
            actualPort = serverAddressOrOptions.port || 3535;
            actualTargetInterface = serverAddressOrOptions.targetInterface;
            toolPaths = serverAddressOrOptions.toolPaths || {};
        } else {
            // Legacy constructor
            serverAddress = serverAddressOrOptions;
            actualProxyName = proxyName || '';
            actualPort = port;
            actualTargetInterface = targetInterface;
            toolPaths = options?.toolPaths || {};
        }

        // Set default tool paths based on platform
        const isWindows = process.platform === 'win32';
        this.toolPaths = {
            openocd: toolPaths.openocd || (isWindows ? 'openocd.exe' : 'openocd'),
            bossac: toolPaths.bossac || (isWindows ? 'bossac.exe' : 'bossac'),
            jlink: toolPaths.jlink || (isWindows ? 'JLinkExe.exe' : 'JLinkExe'),
            dfuUtil: toolPaths.dfuUtil || (isWindows ? 'dfu-util.exe' : 'dfu-util'),
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
        this.server.on('connection', (conClient: any) => {
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

    initInterfaces(targetInterface: any = '') {
        const ifaces = os.networkInterfaces();

        // Clear pending operations that might use old interfaces
        this.clearPendingOperations();

        // Store old interfaces for cleanup
        const oldInterfaces = [...this.interfaces];
        this.interfaces = [];

        // Create new interfaces first
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

                        socket.on('message', (msg: Buffer, info) => {
                            this.handleMessage(msg, info, int);
                        });

                        socket.on('listening', () => {
                            logger.info('Listening on ' + tmp.address);
                        });

                        const int: TBNetworkInterface = {
                            socket: socket,
                            netInterface: tmp
                        };

                        // Bind socket
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
                    } catch (err: any) {
                        logger.error(`Failed to create interface for ${tmp.address}:`, err.message);
                    }
                }
            }
        }

        // Clean up old interfaces after new ones are ready
        this.cleanupOldInterfaces(oldInterfaces);
    }

    private clearPendingOperations(): void {
        // Clear the message check timer to prevent operations on old sockets
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }

        // Clear pending messages to prevent retries on closed sockets
        this.pendingMessages = [];
    }

    private cleanupOldInterfaces(oldInterfaces: TBNetworkInterface[]): void {
        // Use setTimeout to allow any in-flight operations to complete
        setTimeout(() => {
            oldInterfaces.forEach((oldInterface, index) => {
                try {
                    if (oldInterface.socket) {
                        oldInterface.socket.removeAllListeners();
                        oldInterface.socket.close();
                    }
                } catch (err: any) {
                    logger.error(`Error closing old socket ${index}:`, err.message);
                }
            });
        }, 100); // Small delay to allow pending operations to complete
    }

    private getInterfaceState(): string {
        const ifaces = os.networkInterfaces();
        const state: string[] = [];
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

    private startNetworkWatcher(targetInterface?: string): void {
        // Store the initial state
        this.lastInterfaceState = this.getInterfaceState();

        // Check for network interface changes every 5 seconds
        this.networkWatcherTimer = setInterval(() => {
            const currentState = this.getInterfaceState();
            if (currentState !== this.lastInterfaceState) {
                logger.info('Network interface change detected, reinitializing interfaces...');
                this.lastInterfaceState = currentState;
                this.initInterfaces(targetInterface);
            }
        }, 5000);
    }

    private stopNetworkWatcher(): void {
        if (this.networkWatcherTimer) {
            clearInterval(this.networkWatcherTimer);
            this.networkWatcherTimer = undefined;
        }
    }

    setInterface(targetInterface: string) {
        // Clear device lists when switching interfaces
        this.devices = [];
        this.discoveredDevices = {};

        // If empty string or falsy value is passed, set to undefined (all interfaces)
        if (!targetInterface) {
            this.currentInterface = undefined;
            return;
        }
        // go through all 

        this.initInterfaces(targetInterface);

        // this.currentInterface = undefined;
        // const ifaces = os.networkInterfaces();
        // let tmpInterface = ifaces[targetInterface];
        // if (tmpInterface) {
        //     for (let i = 0; i < tmpInterface.length; i++) {
        //         const tmp = tmpInterface[i];
        //         if (tmp.family == 'IPv4' && !tmp.internal) {
        //             // Find the matching interface in this.interfaces by address
        //             for (let j = 0; j < this.interfaces.length; j++) {
        //                 if (this.interfaces[j].netInterface.address === tmp.address) {
        //                     this.currentInterface = this.interfaces[j];
        //                     return;
        //                 }
        //             }
        //         }
        //     }
        // }
    }

    registerListeners(socket: any) {
        socket.on('disconnect', () => {
            logger.error('disconnected');
        });
        socket.on('connect_error', (error: any) => {
            logger.error('connection error' + error);
        });

        socket.on(TIBBO_PROXY_MESSAGE.REFRESH, (message: TaikoMessage) => {
            this.handleRefresh();
        });

        socket.on(TIBBO_PROXY_MESSAGE.BUZZ, (message: TaikoMessage) => {
            this.sendToDevice(message.mac, PCODE_COMMANDS.BUZZ, '');
        });
        socket.on(TIBBO_PROXY_MESSAGE.REBOOT, (message: TaikoMessage) => {
            this.stopApplicationUpload(message.mac);
            this.sendToDevice(message.mac, PCODE_COMMANDS.REBOOT, '', false);
        });
        socket.on(TIBBO_PROXY_MESSAGE.APPLICATION_UPLOAD, (message: any) => {
            this.startApplicationUpload(message.mac, message.data, message.deviceDefinition, message.method, message.files, message.baudRate);
        });
        socket.on(TIBBO_PROXY_MESSAGE.COMMAND, (message: TaikoMessage) => {
            this.sendToDevice(message.mac, message.command, message.data, true, message.nonce);
        });
        socket.on(TIBBO_PROXY_MESSAGE.HTTP, (message: HTTPMessage) => {
            this.handleHTTPProxy(message);
        });
        socket.on(TIBBO_PROXY_MESSAGE.SET_PDB_STORAGE_ADDRESS, this.setPDBAddress.bind(this));
        socket.on(TIBBO_PROXY_MESSAGE.ATTACH_SERIAL, (message: any) => {
            const { port, baudRate, reset } = message;
            this.attachSerial(port, baudRate, reset);
        });
        socket.on(TIBBO_PROXY_MESSAGE.DETACH_SERIAL, (message: any) => {
            const { port } = message;
            this.detachSerial(port);
        });

        socket.on(TIBBO_PROXY_MESSAGE.GPIO_SET, async (message: any) => {
            const { address, pin, value } = message;
            const adk = this.adks.find((adk: any) => adk.address === address);
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
                } catch (ex) {
                    console.log(ex);
                }
            }
        });

        socket.on(TIBBO_PROXY_MESSAGE.WIEGAND_SEND, async (message: any) => {
            const { address, value } = message;
            const adk = this.adks.find((adk: any) => adk.address === address);
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
                } catch (ex) {
                    console.log(ex);
                }
            }
        });

        socket.on(TIBBO_PROXY_MESSAGE.POLL_DEVICE, (message: any) => {
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

    setServer(serverAddress: string, proxyName: string) {
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.close();
        }
        const socketURL = url.parse(serverAddress);
        let socketioPath = '/socket.io';
        if (socketURL.path != '/') {
            socketioPath = socketURL.path + socketioPath;
        }
        this.socket = socketIOClient(socketURL.protocol + '//' + socketURL.host + '/devices', {
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

    setADKS(adks: any[]) {
        this.adks = adks;
    }

    handleRefresh() {
        const msg = Buffer.from(PCODE_COMMANDS.DISCOVER);
        this.discoveredDevices = {};
        this.send(msg);
        this.getSerialPorts();
        this.getDFUDevices();
    }

    setPDBAddress(message: TaikoMessage): void {
        if (message.mac) {
            const device = this.getDevice(message.mac);
            device.pdbStorageAddress = Number(message.data);
        }
    }

    handleMessage(msg: Buffer, info: any, socket: TBNetworkInterface) {
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
        let replyFor: TaikoMessage | undefined = undefined;

        const identifier = secondPart.split('|')[1];
        for (let i = 0; i < device.messageQueue.length; i++) {
            if (device.messageQueue[i].nonce == identifier) {
                replyFor = device.messageQueue.splice(i, 1)[0];
                i--;
            }
        }
        // detect failed upload
        // if (device && device.file) {
        //     if (identifier !== undefined && replyFor === undefined && device.fileIndex !== 0) {
        //         console.log('consuming message ' + msg.toString());
        //     }
        // }
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
            const adk = this.adks.find((adk: any) => adk.address === mac);
            if (adk) {
                device.streamURL = adk.streamURL;
            }
            this.sendToDevice(mac, PCODE_COMMANDS.INFO, '');
            return;
        }

        if (reply != undefined) {
            const tmpReply: TaikoReply = {
                mac: mac,
                data: messagePart,
                reply: message.substr(message.indexOf(']') + 1, 1),
                nonce: identifier
            }
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
                case PCODE_COMMANDS.UPLOAD: // dont send reply for uploads

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
                        || replyForCommand == PCODE_COMMANDS.STEP
                    ) {
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
                        // if (pc[0].toUpperCase() === 'C') {
                        // error state
                        // console.log(`device ${mac} in error state`);
                        // }

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
                case PCODE_COMMANDS.UPLOAD: {
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
                            // if (device.fileIndex % 10 == 0 || device.fileIndex == device.fileBlocksTotal) {
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
                        // if is app upload, send app upload finish (starts with TBIN)
                        if (device.file?.toString('binary').indexOf('TBIN') == 0) {
                            this.sendToDevice(mac, PCODE_COMMANDS.APPUPLOADFINISH, '', true);
                        } else {
                            // otherwise is tios firmware upload
                            this.sendToDevice(mac, 'N', '', true);
                            this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                                'nonce': identifier,
                                'mac': mac
                            });
                        }
                    }
                }
                    break;
                case 'N': // tios firmware upload
                    this.sendToDevice(mac, PCODE_COMMANDS.REBOOT, '', false);
                    break;
                case PCODE_COMMANDS.APPUPLOADFINISH: {
                    let verifyCount = 0;
                    logger.info(`${mac}, resetting...`);
                    const verifyDevice = this.getDevice(mac);

                    // Pause the stall watchdog during verification
                    if (verifyDevice.uploadWatchdog) {
                        clearInterval(verifyDevice.uploadWatchdog);
                        verifyDevice.uploadWatchdog = undefined;
                    }

                    // Clear any previous verification timer
                    if (verifyDevice.verificationTimer) {
                        clearInterval(verifyDevice.verificationTimer);
                    }

                    verifyDevice.uploadAttempts = (verifyDevice.uploadAttempts || 0) + 1;

                    verifyDevice.verificationTimer = setInterval(() => {
                        this.sendToDevice(mac, PCODE_COMMANDS.INFO, '');
                        const dev = this.getDevice(mac);
                        if (dev.appVersion != '' && dev.file) {
                            if (dev.file?.toString('binary').indexOf(dev.appVersion) >= 0) {
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
                            } else {
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
                const deviceState: PCODEMachineState = <PCODEMachineState>stateString.substring(0, 3);
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

    async handleDebugPrint(device: TibboDevice, state: string) {
        if (device.printing) {
            return;
        }
        const currentTimestamp = new Date().getTime();
        if (device.lastPoll === undefined || currentTimestamp - device.lastPoll > 5000) {
            // stop auto continue if no client polls of device
            return;
        }
        device.printing = true;
        const address = device.pdbStorageAddress;
        if (address != undefined && device.lastRunCommand != undefined) {
            const start = performance.now();
            const val = await this.getVariable(address, device.mac);
            const end = performance.now();
            logger.info(`getVariable ${val} took ${end - start}ms`);
            this.emit(TIBBO_PROXY_MESSAGE.DEBUG_PRINT, {
                data: JSON.stringify({
                    data: val,
                    state
                }),
                mac: device.mac
            });
            const deviceState: PCODEMachineState = <PCODEMachineState>state.substring(0, 3)
            if (deviceState == PCODEMachineState.DEBUG_PRINT_AND_CONTINUE) {
                if (device.lastRunCommand != undefined) {
                    if (device.lastRunCommand.command == PCODE_COMMANDS.RUN) {
                        device.lastRunCommand.data = '+' + device.breakpoints;
                    }
                    this.sendToDevice(device.lastRunCommand.mac, device.lastRunCommand.command, device.lastRunCommand.data);
                }
            } else {
                this.sendToDevice(device.mac, PCODE_COMMANDS.STATE, '');
            }
        }

        device.printing = false;
    }

    removeDeviceMessage(mac: string, nonce: string) {
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

    clearDeviceMessageQueue(mac: string) {
        const device = this.getDevice(mac);
        const nonces = new Set<string>();
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

    stopApplicationUpload(address: string) {
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

    private resolveTiosFirmwarePath(deviceDefinition: any): string | undefined {
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
            let entries: string[];
            try {
                entries = fs.readdirSync(firmwareDir);
            } catch {
                return undefined;
            }
            const bins = entries.filter((f) => f.toLowerCase().endsWith('.bin'));
            if (bins.length === 1) {
                return path.join(firmwareDir, bins[0]);
            }
            if (bins.length > 1) {
                const byLower = new Map(bins.map((b) => [b.toLowerCase(), b] as const));
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

    async startApplicationUpload(mac: string, fileString: string, deviceDefinition?: any, method?: string, files?: any[], baudRate = 115200): Promise<void> {
        if (!mac && !deviceDefinition) {
            return;
        }

        fileString = fileString || '';
        const bytes = Buffer.from(fileString, 'binary');

        // Reset upload attempt counter on a fresh upload from the client
        if (method) {
            const dev = this.getDevice(mac);
            dev.uploadAttempts = 0;
        }

        if (deviceDefinition && method) {
            if (method === 'micropython' && files) {
                this.startUploadMicropython(mac, files, baudRate);
                return;
            } else if (method === 'esp32') {
                this.uploadESP32(mac, bytes, deviceDefinition, baudRate);
                return;
            } else if (method === 'bossac') {
                this.uploadBossac(mac, bytes, deviceDefinition);
                return;
            } else if (method === 'openocd') {
                this.uploadOpenOCD(mac, bytes, deviceDefinition);
                return;
            } else if (method === 'jlink') {
                this.uploadJLink(mac, bytes, deviceDefinition);
                return;
            } else if (method === 'dfu-util') {
                this.uploadDfuUtil(mac, bytes, deviceDefinition, files);
                return;
            } else if (method === 'teensy') {
                this.uploadTeensy(mac, bytes, deviceDefinition);
                return;
            }
        } else {
            logger.info('starting application upload for ' + mac);
            let device: TibboDevice = this.getDevice(mac);

            // Guard against concurrent uploads: cancel any in-progress upload first
            this.stopApplicationUpload(mac);
            this.clearDeviceMessageQueue(mac);

            device.fileIndex = 0;
            device.uploadRetries = 0;
            device.deviceDefinition = deviceDefinition;

            device.file = bytes;
            let isTpcFile = false;
            if (device.file?.toString('binary').indexOf('TBIN') == 0) {
                isTpcFile = true;
            }

            // Validate file size against 16-bit block index limit
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
            // first get device info, if already in 'TiOS-32 Loader' mode, skip the reset programming mode  
            const deviceInfo = await this.getDeviceInfo(mac);
            if (deviceInfo.tios.indexOf('TiOS-32 Loader') >= 0) {
                device.resetProgrammingToken = new Subject();
                device.resetProgrammingToken.message = 'A';
            } else {
                device.resetProgrammingToken = new Subject();
                this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING, '', true);
                await device.resetProgrammingToken.wait(5000);
            }
            if (!device.resetProgrammingToken
                || !device.resetProgrammingToken.message
                || device.resetProgrammingToken.message === 'F'
                || (device.tios.indexOf('TiOS-32 Loader') >= 0 && isTpcFile)
            ) {
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
                let firmwareBytes: Buffer;
                try {
                    firmwareBytes = fs.readFileSync(firmwarePath);
                } catch (e: any) {
                    this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                        data: `Could not read TIOS firmware: ${firmwarePath}: ${e?.message ?? e}`,
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

                // Recheck combined size against limit
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
                await device.resetProgrammingToken.wait(5000);

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
                } else {
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
    }

    uploadESP32(mac: string, bytes: Buffer, deviceDefinition: any, baudRate: number): void {
        const filesArray = [];
        let flashAddress = 0x10000;
        if (deviceDefinition.flashAddress !== undefined) {
            if (deviceDefinition.flashAddress.startsWith('0x')) {
                flashAddress = parseInt(deviceDefinition.flashAddress, 16);
            } else {
                flashAddress = Number(deviceDefinition.flashAddress);
            }
        }
        filesArray.push({
            data: bytes,
            address: flashAddress,
        });
        this.startUploadEsp32(mac, filesArray, baudRate);
    }

    uploadBossac(mac: string, bytes: Buffer, deviceDefinition: any): void {
        const fileBase = this.makeid(8);
        const bossacPath = this.toolPaths.bossac!;
        try {
            // see if bossac is installed and in path
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
            // make temporary folder
            fs.mkdirSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase), { recursive: true });
            // random file name
            fs.writeFileSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase, `zephyr.bin`), bytes);
            const cleanup = () => {
                if (fileBase && fs.existsSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase))) {
                    fs.rmdirSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase), { recursive: true });
                }
            }

            let ccmd = ``;
            // see if bossac is installed
            ccmd = `${bossacPath} -p ${mac} -R -e -w -v -b ${path.join(PROJECT_OUTPUT_FOLDER, fileBase, `zephyr.bin`)} -o ${deviceDefinition.partitions[0].size}`;
            const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60000, shell: true });
            if (!exec.pid) {
                return;
            }
            let outputData = '';
            exec.stdout.on('data', (data: any) => {
                // [=========================     ] 99% (2178/2179 pages)
                try {
                    let progress = 0;
                    // get string in parenthesis
                    const match = data.toString().match(/\(([^)]+)\)/);
                    if (match) {
                        progress = match[1].split('/')[0] / match[1].split('/')[1].replace('pages', '').trim();
                        this.emit(TIBBO_PROXY_MESSAGE.UPLOAD, {
                            'data': progress,
                            'mac': mac
                        });
                    }
                } catch (ex) {

                }
            });
            exec.on('error', () => {
                cleanup();
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    method: 'bossac',
                    mac: '',
                });
            });
            exec.stderr.on('data', (data: any) => {
                outputData += data.toString();
            });
            exec.on('exit', (code: Number) => {
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
        } catch (ex) {
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

    uploadOpenOCD(mac: string, bytes: Buffer, deviceDefinition: any): void {
        const openocdMethod = deviceDefinition.uploadMethods.find((method: any) => method.name === 'openocd');
        let jlinkDevice = deviceDefinition.id;
        const fileBase = this.makeid(8);
        let scriptPath = '';
        let filePath = '';
        const openocdPath = this.toolPaths.openocd!;
        try {
            // see if openocd is installed and in path
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
            // make temporary folder
            fs.mkdirSync(path.join(PROJECT_OUTPUT_FOLDER, fileBase), { recursive: true });
            // random file name

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
            }
            let cmdOutput = '';

            const ccmd = `${openocdPath} -f ${scriptPath} -c 'program ${path.join(PROJECT_OUTPUT_FOLDER, fileBase, uploadFileName)} verify reset exit'`;
            console.log(ccmd);
            const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60000, shell: true });
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
            exec.stderr.on('data', (data: any) => {
                cmdOutput += data.toString();
                console.log(data.toString());
            });
            exec.stdout.on('data', (data: any) => {
                cmdOutput += data.toString();
                console.log(data.toString());
            });
            exec.on('exit', (code: Number) => {
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
        } catch (ex: any) {
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

    uploadJLink(mac: string, bytes: Buffer, deviceDefinition: any): void {
        const jlinkMethod = deviceDefinition.uploadMethods.find((method: any) => method.name === 'jlink');
        let jlinkDevice = '';
        let speed = '';
        let flashAddress = deviceDefinition.flashAddress || '0x0';
        const fileBase = this.makeid(8);
        let scriptPath = '';
        let filePath = '';
        const jlinkPath = this.toolPaths.jlink!;
        try {
            // see if jlink is installed and in path
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
            // random file name
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
            } else {
                fs.writeFileSync(scriptPath, `loadbin ${filePath} ${flashAddress}\nR\nG\nExit`);
            }

            const cleanup = () => {
                if (scriptPath && fs.existsSync(scriptPath)) {
                    fs.unlinkSync(scriptPath);
                }
                if (filePath && fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }

            const ccmd = `${jlinkPath} -device ${jlinkDevice} -if SWD -speed ${speed} -autoconnect 1 -CommanderScript ${scriptPath}`;
            const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60000, shell: true });
            if (!exec.pid) {
                return;
            }
            exec.on('error', () => {
                cleanup();
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    mac: jlinkDevice,
                });
            });
            exec.stderr.on('data', (data: any) => {
                console.log(data.toString());
            });
            exec.stdout.on('data', (data: any) => {
                console.log(data.toString());
            });
            exec.on('exit', () => {
                cleanup();
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    method: 'jlink',
                    mac: jlinkDevice,
                });
            });
        } catch (ex) {
            console.log(ex);
        }
    }

    uploadDfuUtil(mac: string, bytes: Buffer, deviceDefinition: any, files?: any[]): void {
        const dfuUtilMethod = deviceDefinition.uploadMethods.find((method: any) => method.name === 'dfu-util');
        let pid = '';
        let alt = '';
        let dfuse = false;
        let dfuseAddress = '0x08000000';
        const addressFromFiles = files?.[0]?.address;
        if (addressFromFiles !== undefined) {
            dfuseAddress = typeof addressFromFiles === 'number'
                ? '0x' + addressFromFiles.toString(16)
                : String(addressFromFiles);
        }
        const fileBase = this.makeid(8);
        let filePath = '';
        const dfuUtilPath = this.toolPaths.dfuUtil!;
        try {
            const dfuUtil = cp.spawnSync(dfuUtilPath, ['--version'], { shell: true });
            if (dfuUtil.error) {
                this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                    data: `${dfuUtilPath} not found`,
                    format: 'markdown',
                    mac: mac,
                });
                return this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                    method: 'dfu-util',
                    code: 'not_found',
                    mac,
                });
            }
            for (let i = 0; i < dfuUtilMethod.options.length; i++) {
                let option = dfuUtilMethod.options[i];
                if (option.indexOf('"') === 0) {
                    option = option.substring(1, option.length - 1);
                }
                if (option.indexOf('--pid=') === 0) {
                    pid = option.split('=')[1];
                }
                if (option.indexOf('--alt=') === 0) {
                    alt = option.split('=')[1];
                }
                if (option === '--dfuse') {
                    dfuse = true;
                }
            }

            const fileName = `${fileBase}.bin`;
            filePath = path.join(PROJECT_OUTPUT_FOLDER, fileName);
            fs.mkdirSync(PROJECT_OUTPUT_FOLDER, { recursive: true });
            fs.writeFileSync(filePath, bytes);

            const cleanup = () => {
                if (filePath && fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            };

            const args: string[] = [];
            if (pid) {
                args.push(`-d ${pid}`);
            }
            if (mac) {
                args.push(`-S ${mac}`);
            }
            if (alt) {
                args.push(`-a ${alt}`);
            }
            if (dfuse) {
                args.push(`-s ${dfuseAddress}:leave`);
            }
            args.push(`-D ${filePath}`);

            const ccmd = `${dfuUtilPath} ${args.join(' ')}`;
            console.log(ccmd);
            let cmdOutput = '';
            const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60000, shell: true });
            if (!exec.pid) {
                cleanup();
                return;
            }
            const handleProgress = (data: any) => {
                const text = data.toString();
                cmdOutput += text;
                const match = text.match(/(\d+)%/);
                if (match) {
                    const progress = Number(match[1]) / 100;
                    this.emit(TIBBO_PROXY_MESSAGE.UPLOAD, {
                        'data': progress,
                        'mac': mac,
                    });
                }
            };
            exec.stdout.on('data', handleProgress);
            exec.stderr.on('data', handleProgress);
            exec.on('error', () => {
                cleanup();
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                    method: 'dfu-util',
                    mac,
                });
            });
            exec.on('exit', (code: Number) => {
                cleanup();
                if (code !== 0) {
                    this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                        data: `dfu-util exited with code ${code}\n${cmdOutput}`,
                        mac: mac,
                    });
                    return this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                        method: 'dfu-util',
                        code: 'error',
                        mac,
                    });
                }
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    method: 'dfu-util',
                    mac,
                });
            });
        } catch (ex: any) {
            this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                data: ex.toString(),
                mac,
            });
            this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                method: 'dfu-util',
                mac,
            });
        }
    }

    uploadTeensy(mac: string, bytes: Buffer, deviceDefinition: any): void {
        const teensyMethod = deviceDefinition.uploadMethods.find((method: any) => method.name === 'teensy');
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
            // random file name
            let fileName = `${fileBase}.hex`;
            filePath = path.join(PROJECT_OUTPUT_FOLDER, fileName);
            fs.writeFileSync(filePath, bytes);
            const cleanup = () => {
                if (filePath && fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }

            const ccmd = `teensy_loader_cli --mcu=${teensyDevice} -w -v ${filePath}`;
            const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60000, shell: true });
            if (!exec.pid) {
                return;
            }
            exec.on('error', () => {
                cleanup();
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    mac,
                });
            });
            exec.stderr.on('data', (data: any) => {
                console.log(data.toString());
            });
            exec.stdout.on('data', (data: any) => {
                console.log(data.toString());
            });
            exec.on('exit', () => {
                cleanup();
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    method: 'teensy',
                    mac,
                });
            });
        } catch (ex) {
            console.log(ex);
        }
    }

    async startUploadMicropython(mac: string, files: any[], baudRate: number): Promise<void> {
        try {
            await this.getSerialPorts();
            await this.detachSerial(mac);
            const attach = await this.attachSerial(mac, baudRate);
            if (!attach) {
                throw new Error('Failed to attach serial');
            }
            const serialPort = this.serialDevices[mac];
            const micropythonSerial = new MicropythonSerial(serialPort);
            await micropythonSerial.enterRawMode(true);
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
                await micropythonSerial.writeFileToDevice(files[i]);
            }
            await micropythonSerial.exitRawMode();

            await this.detachSerial(mac);
            this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                'error': false,
                'nonce': '',
                'mac': mac
            });
        } catch (ex: any) {
            console.log(ex);
            this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                'nonce': '',
                'mac': mac
            })
            logger.error(ex);
        }
    }

    async startUploadEsp32(mac: string, files: any[], baudRate: number): Promise<void> {
        try {
            await this.getSerialPorts();
            await this.detachSerial(mac);
            await this.attachSerial(mac, baudRate);
            const serialPort = this.serialDevices[mac];
            if (!serialPort) {
                throw new Error('Failed to attach serial');
            }
            const esp32Serial = new ESP32Serial(serialPort);
            esp32Serial.on('progress', (progress: number) => {
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD, {
                    method: 'esp32',
                    'data': progress,
                    'mac': mac
                });
            });
            await esp32Serial.writeFilesToDevice(files);

            this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                'error': false,
                'nonce': '',
                'mac': mac
            });
        } catch (ex: any) {
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
            await this.detachSerial(mac);
        }
    }

    sendBlock(mac: string, blockIndex: number): void {
        const device = this.getDevice(mac);
        if (!device.file) {
            return;
        }
        const remainder = device.file.length % BLOCK_SIZE;
        if (remainder == 0) {
            device.fileBlocksTotal = device.file.length / BLOCK_SIZE
        }
        else {
            device.fileBlocksTotal = (device.file.length - remainder) / BLOCK_SIZE + 1;
        }
        device.fileIndex = blockIndex;
        for (let i = 0; i < device.blockSize; i++) {
            let currentBlock = blockIndex + i;
            let fileBlock = device.file.slice((device.fileIndex + i) * BLOCK_SIZE, (device.fileIndex + i) * BLOCK_SIZE + BLOCK_SIZE);

            const buf = Buffer.from([(0xff00 & currentBlock) >> 8, (0x00ff & currentBlock)]);
            // const buf = new Buffer([(0xff00 & blockIndex) >> 8, (0x00ff & blockIndex)]);
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

    sendToDevice(mac: string, command: string, data: string, reply = true, nonce: string | undefined = undefined): void {
        // only send messages for tibbo devices
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
                    command: <PCODE_COMMANDS>command,
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

    checkMessageQueue(): void {
        const currentDate = new Date().getTime();

        // Process messages from oldest to newest (FIFO), but safely handle removals
        let i = 0;
        while (i < this.pendingMessages.length) {
            const pendingMessage = this.pendingMessages[i];
            const elapsed = currentDate - pendingMessage.timestamp;

            if (elapsed > pendingMessage.timeout) {
                // Check if we should retry or discard
                if (pendingMessage.tries > 10) {
                    logger.warn(`Discarding message after ${pendingMessage.tries} attempts: ${pendingMessage.message}`);
                    this.pendingMessages.splice(i, 1);
                    this.handleUploadMessageTimeout(pendingMessage);
                    continue;
                }

                // Check if the interface is still valid before retrying
                if (!this.isValidInterface(pendingMessage.deviceInterface)) {
                    logger.warn(`Interface no longer valid, discarding message: ${pendingMessage.message}`);
                    this.pendingMessages.splice(i, 1);
                    // Don't increment i since we removed an item
                    continue;
                }

                // Update retry parameters
                if (pendingMessage.timeout < 1024) {
                    pendingMessage.timeout *= 2;
                }
                pendingMessage.tries++;
                pendingMessage.timestamp = currentDate;

                // Retry sending the message
                try {
                    const message = pendingMessage.message;
                    const pnum = pendingMessage.nonce;
                    const newMessage = Buffer.from(`${message}|${pnum}`, 'binary');

                    logger.info(`Retrying message (attempt ${pendingMessage.tries}): ${pendingMessage.message}`);
                    this.send(newMessage, pendingMessage.deviceInterface);
                } catch (err: any) {
                    logger.error(`Error retrying message: ${err.message}`);
                    // Remove the message if we can't retry it
                    this.pendingMessages.splice(i, 1);
                    // Don't increment i since we removed an item
                    continue;
                }
            }

            // Only increment if we didn't remove an item
            i++;
        }
    }

    private isValidInterface(deviceInterface: any): boolean {
        if (!deviceInterface || !deviceInterface.socket) {
            return false;
        }

        // Check if this interface still exists in our current interfaces
        return this.interfaces.some(int => int === deviceInterface) &&
            this.isSocketActive(deviceInterface.socket);
    }

    private handleUploadMessageTimeout(pendingMessage: UDPMessage): void {
        const macMatch = pendingMessage.message.match(/\[([^\]]+)\]/);
        if (!macMatch) return;

        const mac = macMatch[1];
        const device = this.getDevice(mac);
        if (!device.file) return;

        const commandStart = pendingMessage.message.indexOf(']') + 1;
        const msgAfterBracket = pendingMessage.message.substring(commandStart);

        const isUploadBlock = msgAfterBracket.startsWith(PCODE_COMMANDS.UPLOAD);
        const isResetProgramming = msgAfterBracket.startsWith(PCODE_COMMANDS.RESET_PROGRAMMING);
        const isAppUploadFinish = msgAfterBracket.startsWith(PCODE_COMMANDS.APPUPLOADFINISH);

        if (!isUploadBlock && !isResetProgramming && !isAppUploadFinish) return;

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
        } else if (isAppUploadFinish) {
            this.sendToDevice(mac, PCODE_COMMANDS.APPUPLOADFINISH, '', true);
        } else {
            this.sendBlock(mac, device.fileIndex);
        }
    }

    makeid(length: number): string {
        let result = '';
        const characters = '0123456789abcde';
        const charactersLength = characters.length;
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    }

    /**
     * Calculate the broadcast address for a given IP and netmask
     */
    private getBroadcastAddress(ipAddress: string, netmask: string): string {
        try {
            // Convert IP address and netmask to numeric representation
            const ip = ipAddress.split('.').map(Number);
            const mask = netmask.split('.').map(Number);

            // Calculate broadcast address: (ip | ~mask)
            const broadcast = ip.map((octet, i) => octet | (~mask[i] & 255));

            return broadcast.join('.');
        } catch (ex) {
            logger.error('Error calculating broadcast address:', ex);
            return '255.255.255.255'; // Fallback to general broadcast
        }
    }

    private isSocketActive(socket: dgram.Socket): boolean {
        try {
            // Check if socket exists and hasn't been closed
            return socket && typeof socket.send === 'function';
        } catch (err) {
            return false;
        }
    }

    private sendToSocket(socket: dgram.Socket, message: Buffer, address: string, port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                if (!this.isSocketActive(socket)) {
                    reject(new Error('Socket is not active'));
                    return;
                }

                // Convert Buffer to Uint8Array to satisfy TypeScript types
                const messageArray = new Uint8Array(message);
                socket.send(messageArray, 0, messageArray.length, port, address, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    send(message: Buffer, netInterface?: any, targetIP?: string): void {
        logger.info(`${new Date().toLocaleTimeString()} sent: ${message}`);

        let targetInterface = this.currentInterface;
        if (netInterface != undefined) {
            targetInterface = netInterface;
        }

        if (targetInterface != undefined) {
            this.sendToSingleInterface(message, targetInterface);
        } else {
            this.sendToAllInterfaces(message);
        }
    }

    private sendToSingleInterface(message: Buffer, targetInterface: TBNetworkInterface): void {
        if (!this.isSocketActive(targetInterface.socket)) {
            logger.error('Target interface socket is not active');
            return;
        }

        try {
            const broadcastAddress = this.getBroadcastAddress(
                targetInterface.netInterface.address,
                targetInterface.netInterface.netmask
            );

            this.sendToSocket(targetInterface.socket, message, broadcastAddress, PORT)
                .catch(err => {
                    logger.error('Error sending to specific interface:', err.message);
                });
        } catch (err: any) {
            logger.error('Error preparing message for specific interface:', err.message);
        }
    }

    private sendToAllInterfaces(message: Buffer): void {
        // Create a snapshot of interfaces to avoid race conditions
        const interfaceSnapshot = [...this.interfaces];

        interfaceSnapshot.forEach((interfaceItem, index) => {
            if (!this.isSocketActive(interfaceItem.socket)) {
                logger.warn(`Interface ${index} socket is not active, skipping`);
                return;
            }

            try {
                const broadcastAddress = this.getBroadcastAddress(
                    interfaceItem.netInterface.address,
                    interfaceItem.netInterface.netmask
                );

                this.sendToSocket(interfaceItem.socket, message, broadcastAddress, PORT)
                    .catch(err => {
                        logger.error(`Error sending to interface ${index}:`, err.message);
                    });
            } catch (err: any) {
                logger.error(`Error preparing message for interface ${index}:`, err.message);
            }
        });
    }

    private async getVariable(address: number, mac: string): Promise<string> {
        const COMMAND_WAIT_TIME = 3000;
        const READ_BLOCK_SIZE = 16;
        const TRIES = 3;
        let outputString = '';
        for (let t = 0; t < TRIES; t++) {
            try {
                let tmpAddress = address.toString(16).padStart(4, '0');
                this.memoryCalls[tmpAddress] = new Subject();
                this.sendToDevice(mac, PCODE_COMMANDS.GET_MEMORY, tmpAddress + ',02', true);
                await this.memoryCalls[tmpAddress].wait(COMMAND_WAIT_TIME);
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
                await Promise.allSettled(
                    blockRequests.map(async (block) => {
                        let count = READ_BLOCK_SIZE;
                        const blockIndex = (block * READ_BLOCK_SIZE);
                        if (blockIndex + count > stringSize) {
                            count = stringSize - blockIndex;
                        }
                        const strAddress = (startAddress + block * READ_BLOCK_SIZE).toString(16).padStart(4, '0');
                        this.memoryCalls[strAddress] = new Subject();
                        logger.info(`started getting block ${block}`);
                        this.sendToDevice(mac, PCODE_COMMANDS.GET_MEMORY, strAddress + ',' + count.toString(16).padStart(2, '0'), true);
                        await this.memoryCalls[strAddress].wait(COMMAND_WAIT_TIME);
                        logger.info(`finished getting block ${block}`);
                    })
                );
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
    }

    async getDeviceInfo(mac: string): Promise<TibboDevice> {
        const device = this.getDevice(mac);
        device.infoToken = new Subject();
        this.sendToDevice(mac, PCODE_COMMANDS.INFO, '', true);
        await device.infoToken.wait(5000);
        device.infoToken = undefined;
        return device;
    }

    getDevice(mac: string): TibboDevice {
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

    async handleHTTPProxy(message: HTTPMessage) {
        try {
            const response = await axios(message.url, {
                method: message.method as Method,
                headers: message.headers,
                data: message.data
            });
            this.emit(TIBBO_PROXY_MESSAGE.HTTP_RESPONSE, {
                nonce: message.nonce,
                status: response.status,
                url: message.url,
                data: response.data
            });
        } catch (error: any) {
            if (error.response) {
                this.emit(TIBBO_PROXY_MESSAGE.HTTP_RESPONSE, {
                    nonce: message.nonce,
                    status: error.response.status,
                    url: message.url,
                    data: error.response.data
                });
            } else {
                logger.error(error);
            }
        }
    }

    emit(channel: string, content: any) {
        if (this.socket !== undefined) {
            this.socket.emit(channel, content);
        }
        this.server.emit(channel, content);
    }

    close() {
        logger.info('Closing TIDEProxy...');

        // Stop network watcher
        this.stopNetworkWatcher();

        // Stop all pending operations first
        this.clearPendingOperations();

        // Close socket.io connection
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.close();
            this.socket = undefined;
        }

        // Close all UDP interfaces
        this.cleanupOldInterfaces([...this.interfaces]);
        this.interfaces = [];
        this.currentInterface = undefined;

        // Clear device states
        this.devices = [];
        this.discoveredDevices = {};

        logger.info('TIDEProxy closed successfully');
    }

    getDevices(): Array<TibboDevice> {
        return this.devices;
    }

    async stop() {
        this.close();
        await new Promise<void>((resolve) => {
            io.removeAllListeners();
            this.server.removeAllListeners();
            io.close(() => {
                resolve();
            });
        });
    }

    async getSerialPorts() {
        const ports = await SerialPort.list();
        for (let i = 0; i < ports.length; i++) {
            let found = false;
            for (let j = 0; j < this.devices.length; j++) {
                if (this.devices[j].mac == ports[i].path) {
                    found = true;
                    break;
                }
            }
            const {
                path, manufacturer, serialNumber, pnpId, locationId, productId, vendorId,
            } = ports[i];
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
    }

    getDFUDevices(): void {
        const dfuUtilPath = this.toolPaths.dfuUtil!;
        let result: any;
        try {
            result = cp.spawnSync(dfuUtilPath, ['-l'], { shell: true, timeout: 5000 });
        } catch {
            return;
        }
        if (!result || result.error || result.status !== 0) {
            return;
        }
        const output = `${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`;
        const regex = /Found DFU:\s*\[([0-9a-f]{4}:[0-9a-f]{4})\][^\n]*?path="([^"]+)"[^\n]*?alt=(\d+)[^\n]*?serial="([^"]*)"/gi;
        const seen = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = regex.exec(output)) !== null) {
            const vidpid = match[1];
            const devPath = match[2];
            const serial = match[4];
            const identifier = serial || `${vidpid}@${devPath}`;
            if (seen.has(identifier)) {
                continue;
            }
            seen.add(identifier);

            let existing: TibboDevice | undefined;
            for (let j = 0; j < this.devices.length; j++) {
                if (this.devices[j].mac === identifier) {
                    existing = this.devices[j];
                    break;
                }
            }
            const device: TibboDevice = existing || {
                ip: '',
                mac: identifier,
                messageQueue: [],
                tios: '',
                app: '',
                appVersion: '',
                fileIndex: 0,
                fileBlocksTotal: 0,
                type: 'dfu',
                pcode: PCODE_STATE.STOPPED,
                blockSize: 1,
                state: PCODEMachineState.STOPPED,
            };
            if (!existing) {
                this.devices.push(device);
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
        }
    }

    async attachSerial(port: string, baudRate: number = 115200, reset: boolean = false) {
        try {
            for (let i = 0; i < this.devices.length; i++) {
                if (this.devices[i].mac == port) {
                    const serialPort = new SerialDevice(port);
                    serialPort.on('data', (data: any) => {
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
                    const connected = await serialPort.connect(baudRate);
                    if (!connected) {
                        return false;
                    }
                    if (reset) {
                        await serialPort.write('\x03');
                        await serialPort.write('\x04');
                    }
                    this.serialDevices[port] = serialPort;
                    return true;
                }
            }
            return false;
        } catch (ex) {
            logger.error('error attaching serial');
            return false;
        }
    }

    async detachSerial(port: string) {
        try {
            for (let i = 0; i < this.devices.length; i++) {
                if (this.devices[i].mac == port) {
                    await this.serialDevices[port].disconnect();
                    delete this.serialDevices[port];
                }
            }
        } catch (ex) {
            logger.error('error detaching serial');
        }
    }
}

export interface TibboDevice {
    ip: string;
    mac: string;
    messageQueue: Array<TaikoMessage>;
    tios: string;
    app: string;
    appVersion: string;
    type: string;
    file?: Buffer;
    fileIndex: number;
    blockSize: number;
    fileBlocksTotal: number;
    pcode: PCODE_STATE;
    lastRunCommand?: TaikoMessage;
    state: PCODEMachineState;
    pdbStorageAddress?: number;
    deviceInterface?: any;
    printing?: boolean;
    lastPoll?: number;
    breakpoints?: string;
    streamURL?: string;
    uploadRetries?: number;
    uploadWatchdog?: NodeJS.Timeout;
    verificationTimer?: NodeJS.Timeout;
    uploadAttempts?: number;
    deviceDefinition?: any;
    resetProgrammingToken?: any;
    infoToken?: any;
}

export enum PCODEMachineState {
    STOPPED = '***',
    RUN = '*R*',
    PAUSED = '**B',
    DEBUG_PRINT_AND_STOP = '**P',
    DEBUG_PRINT_AND_CONTINUE = '*P*'
}

export enum PCODE_STATE {
    STOPPED = 0,
    PAUSED = 1,
    RUNNING = 2
}

export interface TaikoMessage {
    mac: string;
    command: PCODE_COMMANDS;
    data: string;
    nonce?: string;
    timestamp: number;
}

export interface HTTPMessage {
    url: string;
    data: any;
    method: string;
    headers: any;
    nonce?: string;
}

export interface TaikoReply {
    mac: string;
    data: string;
    replyFor?: string;
    reply?: string;
    nonce?: string;
}

export enum PCODE_COMMANDS {
    STATE = "PC",
    RUN = "PR",
    PAUSE = "PB",
    BREAKPOINT = "CB",
    GET_MEMORY = "GM",
    GET_PROPERTY = "GP",
    SET_PROPERTY = "SR",
    SET_MEMORY = "SM",
    STEP = "PO",
    SET_POINTER = "SP",
    DISCOVER = '_?',
    INFO = 'X',
    RESET_PROGRAMMING = 'Q',
    RESET_PROGRAMMING_FIRMWARE = 'QF',
    UPLOAD = 'D',
    APPUPLOADFINISH = "T",
    BUZZ = 'B',
    REBOOT = 'EC'
}

export enum TIBBO_PROXY_MESSAGE {
    REFRESH = 'refresh',
    DEVICE = 'device',
    BUZZ = 'buzz',
    REBOOT = 'reboot',
    UPLOAD = 'upload',
    REGISTER = 'register',
    APPLICATION_UPLOAD = 'application',
    UPLOAD_COMPLETE = 'upload_complete',
    STATE = 'state',
    COMMAND = 'command',
    REPLY = 'reply',
    SET_PDB_STORAGE_ADDRESS = 'set_pdb_storage_address',
    DEBUG_PRINT = 'debug_print',
    HTTP = 'http',
    HTTP_RESPONSE = 'http_response',
    ATTACH_SERIAL = 'attach_serial',
    DETACH_SERIAL = 'detach_serial',
    GPIO_SET = 'gpio_set',
    WIEGAND_SEND = 'wiegand_send',
    UPLOAD_ERROR = 'upload_error',
    MESSAGE = 'message',
    POLL_DEVICE = 'poll_device',
}

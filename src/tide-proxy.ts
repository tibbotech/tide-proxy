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
const { Subject } = require('await-notify');

const RETRY_TIMEOUT = 50;
const PORT = 65535;


const REPLY_OK = "A";
const NOTIFICATION_OK = "J";
const ERROR_SEQUENCE = 'S';

const BLOCK_SIZE = 128;

interface UDPMessage {
    deviceInterface: any,
    message: string,
    nonce: string,
    tries: number,
    timestamp: number,
    timeout: number,
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

    constructor(serverAddress = '', proxyName: string, port = 3535, targetInterface?: string) {
        this.id = new Date().getTime().toString();
        this.listenPort = port;
        const ifaces = os.networkInterfaces();
        for (const key in ifaces) {
            // broadcasts[i] = networks[i] | ~subnets[i] + 256;
            const iface = ifaces[key];
            for (let i = 0; i < iface.length; i++) {
                const tmp = iface[i];
                if (tmp.family == 'IPv4' && !tmp.internal) {
                    // const broadcastAddress = this.getBroadcastAddress(tmp.address, tmp.netmask);
                    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
                    // if (broadcastAddress == NaN) {
                    //     continue;
                    // }
                    socket.on('close', () => {
                        logger.info('client disconnected');
                    });

                    socket.on('error', (err) => {
                        logger.error(`udp server error:\n${err.stack}`);
                        socket.close();
                    });
                    socket.on('message', (msg: Buffer, info) => {
                        this.handleMessage(msg, info, int);
                    });

                    socket.on('listening', () => {
                        logger.info('listening on ' + tmp.address);
                    });

                    socket.bind({
                        // port: PORT,
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
        this.server.on('connection', (conClient: any) => {
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

    setInterface(targetInterface: string) {
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

    handleRefresh() {
        const msg = Buffer.from(PCODE_COMMANDS.DISCOVER);
        this.discoveredDevices = {};
        this.send(msg);
        this.getSerialPorts();
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
                        this.sendToDevice(mac, PCODE_COMMANDS.STATE, '');
                        // let newMessage = Buffer.from(`_[${mac}]${P_PCODESTATE}|a`);
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
                        if (pc[0].toUpperCase() === 'C') {
                            // error state
                            // console.log(`device ${mac} in error state`);
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
                            this.sendToDevice(mac, PCODE_COMMANDS.APPUPLOADFINISH, '', true);
                        }
                    }
                    break;
                case PCODE_COMMANDS.APPUPLOADFINISH:
                    // verify binary on device is what we sent
                    let count = 0;
                    logger.info(`${mac}, resetting...`);
                    const deviceStatusTimer = setInterval(() => {
                        this.sendToDevice(mac, PCODE_COMMANDS.INFO, '');
                        const device = this.getDevice(mac);
                        if (device.appVersion != '' && device.file) {
                            if (device.file?.toString('binary').indexOf(device.appVersion) >= 0) {
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
                            // device is not responding or not programmed
                            if (device.file) {
                                // retry the upload
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
        for (let i = 0; i < device.messageQueue.length; i++) {
            const nonce = device.messageQueue[i].nonce;
            if (nonce) {
                this.removeDeviceMessage(mac, nonce);
            }
        }
        device.messageQueue = [];
    }

    stopApplicationUpload(address: string) {
        const device = this.getDevice(address);
        if (device && device.file) {
            device.file = undefined;
            device.fileIndex = 0;
            device.fileBlocksTotal = 0;
        }
    }

    startApplicationUpload(mac: string, fileString: string, deviceDefinition?: any, method?: string, files?: any[], baudRate = 115200): void {
        if (!mac && !deviceDefinition) {
            return;
        }

        const bytes = Buffer.from(fileString, 'binary');
        if (deviceDefinition && method) {
            if (method === 'micropython' && files) {
                this.startUploadMicropython(mac, files, baudRate);
                return;
            } else if (method === 'esp32') {
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
                return;
            } else if (method === 'bossac') {
                const bossacMethod = deviceDefinition.uploadMethods.find((method: any) => method.name === 'bossac');
                const fileBase = this.makeid(8);
                let scriptPath = '';
                let filePath = '';
                try {
                    // make temporary folder
                    fs.mkdirSync(path.join(__dirname, fileBase));
                    // random file name
                    fs.writeFileSync(path.join(__dirname, fileBase, `zephyr.bin`), bytes);
                    const cleanup = () => {
                        if (fileBase && fs.existsSync(fileBase)) {
                            fs.unlinkSync(fileBase);
                        }
                    }

                    let ccmd = ``;
                    // see if bossac is installed
                    try {
                        ccmd = `bossac -p ${mac} -d`;
                        cp.execSync(ccmd);
                    } catch (ex) {
                        return this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                            method: 'bossac',
                            mac: '',
                        });
                    }
                    ccmd = `bossac -p ${mac} -R -e -w -v -b ${path.join(__dirname, fileBase, `zephyr.bin`)} -o ${deviceDefinition.partitions[0].size}`;
                    const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60000, shell: true });
                    if (!exec.pid) {
                        return;
                    }
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
                        console.log(data.toString());
                    });
                    exec.on('exit', () => {
                        cleanup();
                        this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                            method: 'bossac',
                            mac: '',
                        });
                    });
                } catch (ex) {
                    console.log(ex);
                }
            } else if (method === 'openocd') {
                const openocdMethod = deviceDefinition.uploadMethods.find((method: any) => method.name === 'openocd');
                let jlinkDevice = deviceDefinition.id;
                const fileBase = this.makeid(8);
                let scriptPath = '';
                let filePath = '';
                try {
                    // make temporary folder
                    fs.mkdirSync(path.join(__dirname, fileBase));
                    // random file name

                    scriptPath = path.join(__dirname, fileBase, `openocd.cfg`);
                    if (openocdMethod.options.length > 0) {
                        fs.writeFileSync(scriptPath, openocdMethod.options[0]);
                    }
                    fs.writeFileSync(path.join(__dirname, fileBase, `zephyr.elf`), bytes);
                    const cleanup = () => {
                        if (fileBase && fs.existsSync(fileBase)) {
                            fs.unlinkSync(fileBase);
                        }
                    }

                    const ccmd = `openocd -f ${scriptPath} -c 'program ${path.join(__dirname, fileBase, 'zephyr.elf')} verify reset exit'`;
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
                        console.log(data.toString());
                    });
                    exec.stdout.on('data', (data: any) => {
                        console.log(data.toString());
                    });
                    exec.on('exit', () => {
                        cleanup();
                        this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                            method: 'openocd',
                            mac: jlinkDevice,
                        });
                    });
                } catch (ex) {
                    console.log(ex);
                }
            } else if (method === 'jlink') {
                const jlinkMethod = deviceDefinition.uploadMethods.find((method: any) => method.name === 'jlink');
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
                    // random file name
                    let fileName = `${fileBase}.bin`;
                    filePath = path.join(__dirname, fileName);
                    scriptPath = path.join(__dirname, `${fileBase}.jlink`);
                    fs.writeFileSync(filePath, bytes);
                    fs.writeFileSync(scriptPath, `loadbin ${filePath} ${flashAddress}\nR\nG\nExit`);
                    const cleanup = () => {
                        if (scriptPath && fs.existsSync(scriptPath)) {
                            fs.unlinkSync(scriptPath);
                        }
                        if (filePath && fs.existsSync(filePath)) {
                            fs.unlinkSync(filePath);
                        }
                    }

                    const ccmd = `JLinkExe -device ${jlinkDevice} -if SWD -speed ${speed} -autoconnect 1 -CommanderScript ${scriptPath}`;
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

                }
            }
        } else {
            logger.info('starting application upload for ' + mac);
            let device: TibboDevice = this.getDevice(mac);
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

    async startUploadMicropython(mac: string, files: any[], baudRate: number): Promise<void> {
        try {
            await this.getSerialPorts();
            await this.detachSerial(mac);
            const attach = await this.attachSerial(mac, baudRate);
            if (!attach) {
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    'error': true,
                    'nonce': '',
                    'mac': mac
                });
                return;
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
        } catch (ex) {
            console.log(ex);
            logger.error(ex);
        }
    }

    async startUploadEsp32(mac: string, files: any[], baudRate: number): Promise<void> {
        try {
            await this.getSerialPorts();
            await this.detachSerial(mac);
            await this.attachSerial(mac, baudRate);
            const serialPort = this.serialDevices[mac];
            const esp32Serial = new ESP32Serial(serialPort);
            await esp32Serial.writeFilesToDevice(files);
            this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                'error': false,
                'nonce': '',
                'mac': mac
            });
        } catch (ex) {
            console.log(ex);
            logger.error(ex);
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
            if (fileBlock.length < BLOCK_SIZE) {
                const filler = Buffer.alloc(BLOCK_SIZE - fileBlock.length);
                // const filler = new Buffer(BLOCK_SIZE - fileBlock.length);
                fileBlock = Buffer.concat([fileBlock, filler]);
            }

            this.sendToDevice(mac, PCODE_COMMANDS.UPLOAD, Buffer.concat([fileBlock]).toString('binary'), true);
        }

    }

    sendToDevice(mac: string, command: string, data: string, reply = true, nonce: string | undefined = undefined): void {
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
        for (let i = 0; i < this.pendingMessages.length; i++) {
            const elapsed = currentDate - this.pendingMessages[i].timestamp;
            if (elapsed > this.pendingMessages[i].timeout) {
                if (this.pendingMessages[i].timeout < 1024) {
                    this.pendingMessages[i].timeout *= 2;
                }
                if (this.pendingMessages[i].tries > 10) {
                    console.log(`discarding ${this.pendingMessages[i].message}`);
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

    makeid(length: number): string {
        let result = '';
        const characters = '0123456789abcde';
        const charactersLength = characters.length;
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    }

    send(message: Buffer, netInterface?: any, targetIP?: string): void {
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

    private async getVariable(address: number, mac: string): Promise<string> {
        const COMMAND_WAIT_TIME = 3000;
        const READ_BLOCK_SIZE = 16;
        const TRIES = 3;
        for (let t = 0; t < TRIES; t++) {
            try {
                let outputString = '';
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
        return '';
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
        if (this.socket) {
            this.socket.close();
            this.socket.removeAllListeners();
        }
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
                serial_attached: false,
            };
            if (this.serialDevices[path]) {
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
            if (!found) {
                this.devices.push(device);
            }
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
                    await serialPort.connect(baudRate, reset);
                    this.serialDevices[port] = serialPort;
                    this.devices[i].serial_attached = true;
                    return true;
                }
            }
            return false;
        } catch (ex) {
            logger.error('error attaching serial');
        }
    }

    async detachSerial(port: string) {
        try {
            for (let i = 0; i < this.devices.length; i++) {
                if (this.devices[i].mac == port ||
                    (this.devices[i].serial_attached && port === '')) {
                    this.serialDevices[port].disconnect();
                    delete this.serialDevices[port];
                    this.devices[i].serial_attached = false;
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
    serial_attached?: boolean;
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
}

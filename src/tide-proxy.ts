import * as dgram from 'dgram';
// import { TibboDevice, PCODE_STATE, TaikoMessage, TIBBO_PROXY_MESSAGE, TaikoReply, PCODEMachineState, PCODE_COMMANDS } from './types';
import { io as socketIOClient } from 'socket.io-client';
const winston = require('winston');
const url = require('url');
const io = require("socket.io")({ serveClient: false });
const os = require('os');
const ifaces = os.networkInterfaces();
const { Subject } = require('await-notify');

const RETRY_TIMEOUT = 10;
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
    timestamp: number
}

interface TBNetworkInterface {
    socket: dgram.Socket,
    netInterface: any
}

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.simple(),
    transports: [
        //
        // - Write all logs with level `error` and below to `error.log`
        // - Write all logs with level `info` and below to `combined.log`
        //
    ],
});

if (process.env.NODE_ENV != 'production') {
    logger.add(new winston.transports.Console({ format: winston.format.simple(), }));
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

    constructor(serverAddress = '', proxyName: string, port = 3535, targetInterface?: string) {
        this.id = new Date().getTime().toString();
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
                        console.log(`udp server error:\n${err.stack}`);
                        socket.close();
                    });
                    socket.on('message', (msg: Buffer, info) => {
                        this.handleMessage(msg, info, int);
                    });

                    socket.on('listening', () => {
                        console.log('listening on ' + tmp.address);
                    });

                    socket.bind({
                        // port: PORT,
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
        this.server.on('connection', (conClient: any) => {
            this.clients.push(conClient);
            console.log('client connected on socket');
            conClient.on(TIBBO_PROXY_MESSAGE.REFRESH, (message: TaikoMessage) => {
                this.handleRefresh();
            });

            conClient.on(TIBBO_PROXY_MESSAGE.BUZZ, (message: TaikoMessage) => {
                this.sendToDevice(message.mac, PCODE_COMMANDS.BUZZ, '');
            });
            conClient.on(TIBBO_PROXY_MESSAGE.REBOOT, (message: TaikoMessage) => {
                this.sendToDevice(message.mac, PCODE_COMMANDS.REBOOT, '', false);
            });
            conClient.on(TIBBO_PROXY_MESSAGE.APPLICATION_UPLOAD, (message: TaikoMessage) => {
                this.startApplicationUpload(message.mac, message.data);
            });
            conClient.on(TIBBO_PROXY_MESSAGE.COMMAND, (message: TaikoMessage) => {
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

    setInterface(targetInterface: string) {
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
        this.socket.on('disconnect', () => {
            logger.error('disconnected');
        });
        this.socket.on('connect_error', (error: any) => {
            logger.error('connection error' + error);
        });

        this.socket.on(TIBBO_PROXY_MESSAGE.REFRESH, (message: TaikoMessage) => {
            this.handleRefresh();
        });

        this.socket.on(TIBBO_PROXY_MESSAGE.BUZZ, (message: TaikoMessage) => {
            this.sendToDevice(message.mac, PCODE_COMMANDS.BUZZ, '');
        });
        this.socket.on(TIBBO_PROXY_MESSAGE.REBOOT, (message: TaikoMessage) => {
            this.sendToDevice(message.mac, PCODE_COMMANDS.REBOOT, '', false);
        });
        this.socket.on(TIBBO_PROXY_MESSAGE.APPLICATION_UPLOAD, (message: TaikoMessage) => {
            this.startApplicationUpload(message.mac, message.data);
        });
        this.socket.on(TIBBO_PROXY_MESSAGE.COMMAND, (message: TaikoMessage) => {
            this.sendToDevice(message.mac, message.command, message.data, true, message.nonce);
        });
        this.socket.on(TIBBO_PROXY_MESSAGE.SET_PDB_STORAGE_ADDRESS, this.setPDBAddress.bind(this));
    }

    handleRefresh() {
        const msg = Buffer.from(PCODE_COMMANDS.DISCOVER);
        this.discoveredDevices = {};
        this.send(msg);
    }

    setPDBAddress(message: TaikoMessage): void {
        const device = this.getDevice(message.mac);
        device.pdbStorageAddress = Number(message.data);
    }

    async handleMessage(msg: Buffer, info: any, socket: TBNetworkInterface): Promise<void> {
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
                if (device.fileBlocksTotal > 0) {
                    replyForCommand = PCODE_COMMANDS.UPLOAD;
                }
            }
            tmpReply.replyFor = replyForCommand;
            switch(tmpReply.replyFor) {
                case PCODE_COMMANDS.UPLOAD: // dont send reply for uploads
            
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
                        // let newMessage = Buffer.from(`_[${mac}]${P_PCODESTATE}|a`);
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
                        const pc = replyParts[0]
                        let pcode_state = PCODE_STATE.STOPPED
                        if (pc[1] == 'R') {
                            pcode_state = PCODE_STATE.RUNNING
                        }
                        else if (pc[2] == 'B') {
                            pcode_state = PCODE_STATE.PAUSED
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
                        for (let i = 0; i < device.messageQueue.length; i++) {
                            if (device.messageQueue[i].command == PCODE_COMMANDS.UPLOAD) {
                                for (let j = 0; j < this.pendingMessages.length; j++) {
                                    if (this.pendingMessages[j].nonce == device.messageQueue[i].nonce) {
                                        this.pendingMessages.splice(j, 1);
                                        j--;
                                    }
                                }
                                device.messageQueue.splice(i, 1);
                                i--;
                            }
                        }
                        device.fileIndex = 0xff00 & msg[msg.length - 2] << 8 | 0x00ff & msg[msg.length - 1];
                        device.fileIndex += device.blockSize;
                        if (device.file != null && device.fileIndex * BLOCK_SIZE < device.file.length) {
                            this.sendBlock(mac, device.fileIndex);
                            if (device.fileIndex % 10 == 0 || device.fileIndex == device.fileBlocksTotal) {
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
                    // if (messagePart) {
                    //     device.blockSize = Number(messagePart);
                    // }
                    device.blockSize = 1;
                    if (device.file != null) {
                        this.sendBlock(mac, 0);
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
                switch (deviceState) {
                    case PCODEMachineState.DEBUG_PRINT_AND_CONTINUE:
                        await this.handleDebugPrint(device, deviceState);
                        break;
                    case PCODEMachineState.DEBUG_PRINT_AND_STOP:
                        if (device.state != PCODEMachineState.DEBUG_PRINT_AND_STOP) {
                            await this.handleDebugPrint(device, deviceState);
                        }
                        break;
                }

                device.state = deviceState;
            }
        }
    }

    async handleDebugPrint(device: TibboDevice, deviceState: PCODEMachineState): Promise<void> {
        const address = device.pdbStorageAddress;
        if (address != undefined && device.lastRunCommand != undefined) {
            const val = await this.getVariable(address, device.mac);
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

        }
    }

    startApplicationUpload(mac: string, fileString: string): void {
        let device: TibboDevice = this.getDevice(mac);
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
                    timestamp: new Date().getTime()
                });
                device.messageQueue.push({
                    mac: mac,
                    command: <PCODE_COMMANDS>command,
                    data: data,
                    nonce: pnum
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

    checkMessageQueue(): void {
        const currentDate = new Date().getTime();
        for (let i = 0; i < this.pendingMessages.length; i++) {
            if (currentDate - this.pendingMessages[i].timestamp > RETRY_TIMEOUT) {
                if (this.pendingMessages[i].tries > 4) {
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

    getBroadcastAddress(address: string, netmask: string): string {
        const addressBytes = address.split(".").map(Number);
        const netmaskBytes = netmask.split(".").map(Number);
        const subnetBytes = netmaskBytes.map(
            (_, index) => addressBytes[index] & netmaskBytes[index]
        );
        const broadcastBytes = netmaskBytes.map(
            (_, index) => subnetBytes[index] | (~netmaskBytes[index] + 256)
        );
        return broadcastBytes.map(String).join(".")
    }

    private async getVariable(address: number, mac: string): Promise<string> {
        let outputString = "";
        let tmpAddress = address.toString(16).padStart(4, '0');
        this.memoryCalls[tmpAddress] = new Subject();
        const COMMAND_WAIT_TIME = 1000;
        const READ_BLOCK_SIZE = 16;
        try {
            this.sendToDevice(mac, PCODE_COMMANDS.GET_MEMORY, tmpAddress + ',02', true);
            await this.memoryCalls[tmpAddress].wait(COMMAND_WAIT_TIME);
            const stringSize = parseInt(this.memoryCalls[tmpAddress].message[0], 16);
            let index = 0;
            address += 2;
            let blocks = Math.floor(stringSize / READ_BLOCK_SIZE);
            if (stringSize % READ_BLOCK_SIZE != 0) {
                blocks++;
            }
            for (let i = 0; i < blocks; i++) {
                let count = READ_BLOCK_SIZE;
                if (index + count > stringSize) {
                    count = stringSize - index;
                }
                tmpAddress = address.toString(16).padStart(4, '0')
                this.sendToDevice(mac, PCODE_COMMANDS.GET_MEMORY, tmpAddress + ',' + count.toString(16).padStart(2, '0'), true);
                this.memoryCalls[tmpAddress] = new Subject();
                await this.memoryCalls[tmpAddress].wait(COMMAND_WAIT_TIME);
                for (let i = 0; i < this.memoryCalls[tmpAddress].message.length; i++) {
                    const charCode = parseInt(this.memoryCalls[tmpAddress].message[i], 16);
                    outputString += String.fromCharCode(charCode);
                }
                this.memoryCalls[tmpAddress] = undefined;
                index += count;
                address += count;
            }
        }
        catch (ex) {
            logger.error(ex);
        }
        return outputString;
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
            fileIndex: 0,
            fileBlocksTotal: 0,
            pcode: -1,
            blockSize: 1,
            state: PCODEMachineState.STOPPED
        };

        this.devices.push(device);
        return device;
    }

    emit(channel: string, content: any) {
        if (this.socket !== undefined) {
            this.socket.emit(channel, content);
        }
        this.server.emit(channel, content);
    }

    async close() {
        this.socket.close();
        this.socket.removeAllListeners();
    }
}

export interface TibboDevice {
    ip: string;
    mac: string;
    messageQueue: Array<TaikoMessage>;
    tios: string;
    app: string;
    file?: Buffer;
    fileIndex: number;
    blockSize: number;
    fileBlocksTotal: number;
    pcode: PCODE_STATE;
    lastRunCommand?: TaikoMessage;
    state: PCODEMachineState;
    pdbStorageAddress?: number;
    deviceInterface?: any;
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
    REBOOT = 'E'
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
    DEBUG_PRINT = 'debug_print'
}
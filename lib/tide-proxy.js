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
const socket_io_client_1 = require("socket.io-client");
const winston = require('winston');
const url = require('url');
const io = require("socket.io")({ serveClient: false });
const os = require('os');
const ifaces = os.networkInterfaces();
const { Subject } = require('await-notify');
const RETRY_TIMEOUT = 500;
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
            path: socketioPath
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
        return __awaiter(this, void 0, void 0, function* () {
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
                    if (device.fileBlocksTotal > 0) {
                        replyForCommand = PCODE_COMMANDS.UPLOAD;
                    }
                }
                tmpReply.replyFor = replyForCommand;
                this.emit(TIBBO_PROXY_MESSAGE.REPLY, tmpReply);
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
                            device.fileIndex--;
                            this.sendBlock(mac, device.fileIndex);
                        }
                        break;
                    case PCODE_COMMANDS.RESET_PROGRAMMING:
                        if (messagePart) {
                            device.blockSize = Number(messagePart);
                        }
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
                    const deviceState = stateString.substring(0, 3);
                    this.emit(TIBBO_PROXY_MESSAGE.STATE, {
                        'mac': mac,
                        'data': messagePart
                    });
                    switch (deviceState) {
                        case PCODEMachineState.DEBUG_PRINT_AND_CONTINUE:
                            yield this.handleDebugPrint(device, deviceState);
                            break;
                        case PCODEMachineState.DEBUG_PRINT_AND_STOP:
                            if (device.state != PCODEMachineState.DEBUG_PRINT_AND_STOP) {
                                yield this.handleDebugPrint(device, deviceState);
                            }
                            break;
                    }
                    device.state = deviceState;
                }
            }
        });
    }
    handleDebugPrint(device, deviceState) {
        return __awaiter(this, void 0, void 0, function* () {
            const address = device.pdbStorageAddress;
            if (address != undefined && device.lastRunCommand != undefined) {
                const val = yield this.getVariable(address, device.mac);
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
                    timestamp: new Date().getTime()
                });
                device.messageQueue.push({
                    mac: mac,
                    command: command,
                    data: data,
                    nonce: pnum
                });
            }
            const newMessage = Buffer.concat([Buffer.from(`${message}|${pnum}`, 'binary')]);
            this.send(newMessage, device.deviceInterface);
            if (this.timer == undefined) {
                this.timer = setInterval(this.checkMessageQueue.bind(this), 300);
            }
        }
        catch (ex) {
            logger.error(ex);
        }
    }
    checkMessageQueue() {
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
    makeid(length) {
        let result = '';
        const characters = '0123456789abcde';
        const charactersLength = characters.length;
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    }
    send(message, netInterface) {
        logger.info(`${new Date().toLocaleTimeString()} sent: ${message}`);
        let targetInterface = this.currentInterface;
        if (netInterface != undefined) {
            targetInterface = netInterface;
        }
        if (targetInterface != undefined) {
            const broadcastAddress = this.getBroadcastAddress(targetInterface.netInterface.address, targetInterface.netInterface.netmask);
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
                    const broadcastAddress = this.getBroadcastAddress(tmp.netInterface.address, tmp.netInterface.netmask);
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
    getBroadcastAddress(address, netmask) {
        const addressBytes = address.split(".").map(Number);
        const netmaskBytes = netmask.split(".").map(Number);
        const subnetBytes = netmaskBytes.map((_, index) => addressBytes[index] & netmaskBytes[index]);
        const broadcastBytes = netmaskBytes.map((_, index) => subnetBytes[index] | (~netmaskBytes[index] + 256));
        return broadcastBytes.map(String).join(".");
    }
    getVariable(address, mac) {
        return __awaiter(this, void 0, void 0, function* () {
            let outputString = "";
            let tmpAddress = address.toString(16).padStart(4, '0');
            this.memoryCalls[tmpAddress] = new Subject();
            const COMMAND_WAIT_TIME = 1000;
            const READ_BLOCK_SIZE = 16;
            try {
                this.sendToDevice(mac, PCODE_COMMANDS.GET_MEMORY, tmpAddress + ',02', true);
                yield this.memoryCalls[tmpAddress].wait(COMMAND_WAIT_TIME);
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
                    tmpAddress = address.toString(16).padStart(4, '0');
                    this.sendToDevice(mac, PCODE_COMMANDS.GET_MEMORY, tmpAddress + ',' + count.toString(16).padStart(2, '0'), true);
                    this.memoryCalls[tmpAddress] = new Subject();
                    yield this.memoryCalls[tmpAddress].wait(COMMAND_WAIT_TIME);
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
            state: PCODEMachineState.STOPPED
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGlkZS1wcm94eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy90aWRlLXByb3h5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7OztBQUFBLCtCQUErQjtBQUUvQix1REFBd0Q7QUFDeEQsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQ25DLE1BQU0sR0FBRyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUMzQixNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUMsRUFBRSxXQUFXLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztBQUN4RCxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekIsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDLGlCQUFpQixFQUFFLENBQUM7QUFDdEMsTUFBTSxFQUFFLE9BQU8sRUFBRSxHQUFHLE9BQU8sQ0FBQyxjQUFjLENBQUMsQ0FBQztBQUU1QyxNQUFNLGFBQWEsR0FBRyxHQUFHLENBQUM7QUFDMUIsTUFBTSxJQUFJLEdBQUcsS0FBSyxDQUFDO0FBR25CLE1BQU0sUUFBUSxHQUFHLEdBQUcsQ0FBQztBQUNyQixNQUFNLGVBQWUsR0FBRyxHQUFHLENBQUM7QUFDNUIsTUFBTSxjQUFjLEdBQUcsR0FBRyxDQUFDO0FBRTNCLE1BQU0sVUFBVSxHQUFHLEdBQUcsQ0FBQztBQWV2QixNQUFNLE1BQU0sR0FBRyxPQUFPLENBQUMsWUFBWSxDQUFDO0lBQ2hDLEtBQUssRUFBRSxNQUFNO0lBQ2IsTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFO0lBQy9CLFVBQVUsRUFBRSxFQUtYO0NBQ0osQ0FBQyxDQUFDO0FBRUgsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLFFBQVEsSUFBSSxZQUFZLEVBQUU7SUFDdEMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMs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
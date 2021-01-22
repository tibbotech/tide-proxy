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
const socketIOClient = require("socket.io-client");
const winston = require('winston');
const url = require('url');
const io = require("socket.io")({ serveClient: false });
const os = require('os');
const ifaces = os.networkInterfaces();
const { Subject } = require('await-notify');
const RETRY_TIMEOUT = 1000;
const PORT = 65535;
const REPLY_OK = "A";
const NOTIFICATION_OK = "J";
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
        for (const key in ifaces) {
            const iface = ifaces[key];
            for (let i = 0; i < iface.length; i++) {
                const tmp = iface[i];
                if (tmp.family == 'IPv4' && !tmp.internal) {
                    const socket = dgram.createSocket('udp4');
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
                    socket.bind(PORT, tmp.address, () => {
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
            const socketURL = url.parse(serverAddress);
            let socketioPath = '/socket.io';
            if (socketURL.path != '/') {
                socketioPath = socketURL.path + socketioPath;
            }
            this.socket = socketIOClient(socketURL.protocol + '//' + socketURL.host + '/devices', {
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
                logger.error('connection error');
            });
            this.socket.on(TIBBO_PROXY_MESSAGE.REFRESH, (message) => {
                const msg = Buffer.from(PCODE_COMMANDS.DISCOVER);
                this.send(msg);
            });
            this.socket.on(TIBBO_PROXY_MESSAGE.BUZZ, (message) => {
                this.sendToDevice(message.mac, PCODE_COMMANDS.BUZZ, '');
            });
            this.socket.on(TIBBO_PROXY_MESSAGE.REBOOT, (message) => {
                const device = this.getDevice(message.mac);
                device.file = undefined;
                device.fileBlocksTotal = 0;
                device.messageQueue = [];
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
        this.server = io.of('/tide');
        this.server.on('connection', (conClient) => {
            console.log('client connected on socket');
            conClient.on(TIBBO_PROXY_MESSAGE.REFRESH, (message) => {
                const msg = Buffer.from(PCODE_COMMANDS.DISCOVER);
                this.send(msg);
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
        });
        io.listen(port);
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
            device.deviceInterface = socket.netInterface;
            const secondPart = message.substring(message.indexOf(']') + 2);
            const messagePart = secondPart.split('|')[0];
            let replyFor = undefined;
            const identifier = secondPart.split('|')[1];
            for (let i = 0; i < device.messageQueue.length; i++) {
                if (device.messageQueue[i].nonce == identifier) {
                    replyFor = device.messageQueue.splice(i, 1)[0];
                    break;
                }
            }
            for (let i = 0; i < this.pendingMessages.length; i++) {
                if (this.pendingMessages[i].nonce == identifier) {
                    this.pendingMessages.splice(i, 1)[0];
                    break;
                }
            }
            const reply = message.substring(message.indexOf(']') + 1, message.indexOf(']') + 2);
            let fileBlock;
            if (device.messageQueue.length == 0 && replyFor == undefined && reply != NOTIFICATION_OK) {
                if (device.fileBlocksTotal == 0) {
                    device.ip = ip;
                    device.mac = mac;
                    this.sendToDevice(mac, PCODE_COMMANDS.INFO, '');
                }
            }
            if (device.fileBlocksTotal != 0 && replyFor == undefined && reply != NOTIFICATION_OK) {
                device.fileIndex++;
                if (reply != REPLY_OK) {
                    device.fileIndex--;
                }
                else {
                    for (let i = 0; i < device.messageQueue.length; i++) {
                        if (device.messageQueue[i].command == PCODE_COMMANDS.UPLOAD) {
                            for (let j = 0; j < this.pendingMessages.length; j++) {
                                if (this.pendingMessages[j].nonce == device.messageQueue[i].nonce) {
                                    this.pendingMessages.splice(j, 1);
                                    break;
                                }
                            }
                            device.messageQueue.splice(i, 1);
                            break;
                        }
                    }
                }
                if (device.file != null && device.fileIndex * BLOCK_SIZE < device.file.length) {
                    fileBlock = device.file.slice(device.fileIndex * BLOCK_SIZE, device.fileIndex * BLOCK_SIZE + BLOCK_SIZE);
                    this.sendBlock(mac, fileBlock, device.fileIndex);
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
                    case PCODE_COMMANDS.RESET_PROGRAMMING:
                        if (device.file != null) {
                            const remainder = device.file.length % BLOCK_SIZE;
                            if (remainder == 0) {
                                device.fileBlocksTotal = device.file.length / BLOCK_SIZE;
                            }
                            else {
                                device.fileBlocksTotal = (device.file.length - remainder) / BLOCK_SIZE + 1;
                            }
                            fileBlock = device.file.slice(device.fileIndex * BLOCK_SIZE, device.fileIndex * BLOCK_SIZE + BLOCK_SIZE);
                            this.sendBlock(mac, fileBlock, 0);
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
        device.messageQueue = [];
        this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING, '');
    }
    sendBlock(mac, fileBlock, blockIndex) {
        const buf = Buffer.from([(0xff00 & blockIndex) >> 8, (0x00ff & blockIndex)]);
        fileBlock = Buffer.concat([buf, fileBlock]);
        if (fileBlock.length < BLOCK_SIZE) {
            const filler = Buffer.alloc(BLOCK_SIZE - fileBlock.length);
            fileBlock = Buffer.concat([fileBlock, filler]);
        }
        this.sendToDevice(mac, PCODE_COMMANDS.UPLOAD, Buffer.concat([fileBlock]).toString('binary'), true);
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
                this.send(newMessage);
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
            state: PCODEMachineState.STOPPED
        };
        this.devices.push(device);
        return device;
    }
    emit(channel, content) {
        this.socket.emit(channel, content);
        this.server.emit(channel, content);
    }
    close() {
        return __awaiter(this, void 0, void 0, function* () {
            for (let i = 0; i < this.interfaces.length; i++) {
                const address = this.interfaces[i].socket.address().address;
                try {
                    this.interfaces[i].socket.removeAllListeners();
                    yield new Promise((resolve, reject) => {
                        this.interfaces[i].socket.close(() => {
                            console.log('socket closed for ' + address);
                            resolve();
                        });
                    });
                }
                catch (ex) {
                    console.log('error closing ' + address);
                    console.log(ex);
                }
            }
            this.socket.disconnect();
            this.server.server.close();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGlkZS1wcm94eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy90aWRlLXByb3h5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7OztBQUFBLCtCQUErQjtBQUUvQixtREFBbUQ7QUFDbkQsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQ25DLE1BQU0sR0FBRyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUMzQixNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUMsRUFBRSxXQUFXLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztBQUN4RCxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekIsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDLGlCQUFpQixFQUFFLENBQUM7QUFDdEMsTUFBTSxFQUFFLE9BQU8sRUFBRSxHQUFHLE9BQU8sQ0FBQyxjQUFjLENBQUMsQ0FBQztBQUU1QyxNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUM7QUFDM0IsTUFBTSxJQUFJLEdBQUcsS0FBSyxDQUFDO0FBR25CLE1BQU0sUUFBUSxHQUFHLEdBQUcsQ0FBQztBQUNyQixNQUFNLGVBQWUsR0FBRyxHQUFHLENBQUM7QUFFNUIsTUFBTSxVQUFVLEdBQUcsR0FBRyxDQUFDO0FBY3ZCLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxZQUFZLENBQUM7SUFDaEMsS0FBSyxFQUFFLE1BQU07SUFDYixNQUFNLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxNQUFNLEVBQUU7SUFDL0IsVUFBVSxFQUFFLEVBS1g7Q0FDSixDQUFDLENBQUM7QUFFSCxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxJQUFJLFlBQVksRUFBRTtJQUN0QyxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksT0FBTyxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUMsRUFBRSxNQUFNLEVBQUUsT0FBTyxD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
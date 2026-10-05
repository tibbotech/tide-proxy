/**
 * Platform-agnostic core of the Tibbo UDP device protocol (PCODE over UDP
 * broadcast, port 65535). Contains the device registry, the pending-message
 * retry queue, discovery/info/state handling, and the application/firmware
 * upload state machine.
 *
 * Everything platform-specific is injected through {@link UDPCoreHost}:
 * - `send` transmits a datagram (Node dgram on desktop, react-native-udp on
 *   mobile). The optional `route` is an opaque handle for the network
 *   interface a device was last seen on; the core stores it per device and
 *   hands it back on every send.
 * - `emit` receives the protocol events (TIBBO_PROXY_MESSAGE channels) that
 *   the desktop proxy forwards to its Socket.IO clients.
 * - `resolveFirmware` supplies TiOS firmware images for the QF reflash path
 *   (filesystem lookup on desktop, unavailable on mobile).
 */

const RETRY_TIMEOUT = 50;
export const TIBBO_UDP_PORT = 65535;

const REPLY_OK = 'A';
const NOTIFICATION_OK = 'J';

const BLOCK_SIZE = 128;
const MAX_UPLOAD_RETRIES = 5;
const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_FILE_SIZE = 65535 * BLOCK_SIZE; // 16-bit block index cap
const UPLOAD_STALL_TIMEOUT_MS = 9000;
const UPLOAD_BLOCK_TIMEOUT = 200;

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

export enum PCODE_COMMANDS {
    STATE = 'PC',
    RUN = 'PR',
    PAUSE = 'PB',
    BREAKPOINT = 'CB',
    GET_MEMORY = 'GM',
    GET_PROPERTY = 'GP',
    SET_PROPERTY = 'SR',
    SET_MEMORY = 'SM',
    STEP = 'PO',
    SET_POINTER = 'SP',
    DISCOVER = '_?',
    INFO = 'X',
    RESET_PROGRAMMING = 'Q',
    RESET_PROGRAMMING_FIRMWARE = 'QF',
    UPLOAD = 'D',
    APPUPLOADFINISH = 'T',
    BUZZ = 'B',
    REBOOT = 'EC',
}

export enum TIBBO_PROXY_MESSAGE {
    REFRESH = 'refresh',
    DEVICE = 'device',
    BUZZ = 'buzz',
    REBOOT = 'reboot',
    UPLOAD = 'upload',
    REGISTER = 'register',
    APPLICATION_UPLOAD = 'application',
    FIRMWARE_UPLOAD = 'firmware',
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

export interface TaikoMessage {
    mac: string;
    command: PCODE_COMMANDS;
    data: string;
    nonce?: string;
    timestamp: number;
}

export interface TaikoReply {
    mac: string;
    data: string;
    replyFor?: string;
    reply?: string;
    nonce?: string;
}

export interface UDPMessage {
    deviceInterface: any;
    message: string;
    nonce: string;
    tries: number;
    timestamp: number;
    timeout: number;
}

export interface TibboDevice {
    ip: string;
    mac: string;
    messageQueue: Array<TaikoMessage>;
    tios: string;
    app: string;
    appVersion: string;
    type: string;
    file?: Uint8Array;
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
    uploadWatchdog?: ReturnType<typeof setInterval>;
    verificationTimer?: ReturnType<typeof setInterval>;
    uploadAttempts?: number;
    deviceDefinition?: any;
    resetProgrammingToken?: Deferred;
    infoToken?: Deferred;
}

export type UDPCoreLogLevel = 'info' | 'warn' | 'error';

export interface UDPCoreHost {
    /** Transmit a UDP broadcast datagram, optionally via a specific route (network interface). */
    send(data: Uint8Array, route?: any): void;
    /** Whether a stored route can still be used for retries. Unset routes are rejected like the desktop proxy does. */
    isValidRoute?(route: any): boolean;
    /** Protocol event sink (TIBBO_PROXY_MESSAGE channel names). */
    emit(channel: string, content: any): void;
    log?(level: UDPCoreLogLevel, message: any): void;
    /** Resolve TiOS firmware bytes for the QF reflash path. Throw to report a read error. */
    resolveFirmware?(deviceDefinition: any): Uint8Array | undefined | Promise<Uint8Array | undefined>;
    /** Called once when a device is first discovered, before its info is queried. */
    onDeviceDiscovered?(device: TibboDevice): void;
}

/** Minimal replacement for await-notify's Subject, usable on any platform. */
export class Deferred {
    command?: PCODE_COMMANDS;
    message?: any;
    private promise: Promise<void>;
    private resolveFn: () => void = () => undefined;

    constructor() {
        this.promise = new Promise<void>((resolve) => {
            this.resolveFn = resolve;
        });
    }

    notify(): void {
        this.resolveFn();
    }

    wait(timeoutMs: number): Promise<void> {
        return Promise.race([
            this.promise,
            new Promise<void>((resolve) => {
                setTimeout(resolve, timeoutMs);
            }),
        ]);
    }
}

export function binaryStringToBytes(str: string): Uint8Array {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i) & 0xff;
    }
    return bytes;
}

/**
 * Upload payloads arrive either as a binary string or, when the client sends
 * raw bytes over socket.io, as a Buffer/ArrayBuffer (or a JSON-serialized
 * Buffer `{ type: 'Buffer', data: [...] }`).
 */
export type UploadData = string | Uint8Array | ArrayBuffer | ArrayBufferView | number[] | { type: 'Buffer'; data: number[] };

export function uploadDataToBytes(data: UploadData | null | undefined): Uint8Array {
    if (!data) {
        return new Uint8Array(0);
    }
    if (typeof data === 'string') {
        return binaryStringToBytes(data);
    }
    if (data instanceof Uint8Array) {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (Array.isArray(data)) {
        return Uint8Array.from(data);
    }
    if (Array.isArray((data as any).data)) {
        return Uint8Array.from((data as any).data);
    }
    throw new TypeError(`Unsupported upload data type: ${Object.prototype.toString.call(data)}`);
}

export function bytesToBinaryString(bytes: Uint8Array): string {
    let result = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        result += String.fromCharCode.apply(null, Array.prototype.slice.call(chunk));
    }
    return result;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

export class TibboUDPCore {
    devices: Array<TibboDevice> = [];
    pendingMessages: Array<UDPMessage> = [];
    timer?: ReturnType<typeof setInterval>;
    memoryCalls: { [key: string]: Deferred | undefined } = {};
    discoveredDevices: { [key: string]: string } = {};

    private host: UDPCoreHost;

    constructor(host: UDPCoreHost) {
        this.host = host;
    }

    private log(level: UDPCoreLogLevel, message: any): void {
        if (this.host.log) {
            this.host.log(level, message);
        }
    }

    private emit(channel: string, content: any): void {
        this.host.emit(channel, content);
    }

    handleRefresh(): void {
        this.discoveredDevices = {};
        this.host.send(binaryStringToBytes(PCODE_COMMANDS.DISCOVER));
    }

    setPDBAddress(message: TaikoMessage): void {
        if (message.mac) {
            const device = this.getDevice(message.mac);
            device.pdbStorageAddress = Number(message.data);
        }
    }

    pollDevice(mac: string): void {
        const device = this.getDevice(mac);
        device.lastPoll = new Date().getTime();
        this.sendToDevice(mac, PCODE_COMMANDS.STATE, '');
    }

    handleMessage(data: Uint8Array, fromIp: string, route?: any): void {
        const message = bytesToBinaryString(data);
        const parts = message.substring(message.indexOf('[') + 1, message.indexOf(']')).split('.');
        if (message.substr(0, 1) == '_') {
            return;
        }
        this.log('info', `${new Date().toLocaleTimeString()} recv: ${message}`);
        for (let i = 0; i < parts.length; i++) {
            parts[i] = Number(parts[i]).toString();
        }

        const mac = parts.join('.');
        const ip = fromIp;
        const device = this.getDevice(mac);
        if (device.ip == '') {
            device.ip = ip;
        }
        device.deviceInterface = route;

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
                this.pendingMessages.splice(i, 1);
                i--;
            }
        }
        const reply = message.substring(message.indexOf(']') + 1, message.indexOf(']') + 2);

        if (this.discoveredDevices[mac] == undefined) {
            this.discoveredDevices[mac] = mac;
            device.ip = ip;
            device.mac = mac;
            if (this.host.onDeviceDiscovered) {
                this.host.onDeviceDiscovered(device);
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
                    const memoryCall = this.memoryCalls[address];
                    if (memoryCall != undefined) {
                        if (value != undefined) {
                            memoryCall.message = value.split(',');
                            memoryCall.notify();
                        }
                    }
                }
            }

            switch (replyForCommand) {
                case PCODE_COMMANDS.INFO:
                    {
                        const infoParts = messagePart.split('/');
                        device.tios = infoParts[0];
                        device.app = infoParts[2];
                        device.appVersion = infoParts[1];
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
                    const fileIndex = 0xff00 & data[data.length - 2] << 8 | 0x00ff & data[data.length - 1];
                    for (let i = 0; i < device.messageQueue.length; i++) {
                        if (device.messageQueue[i].command == PCODE_COMMANDS.UPLOAD) {
                            const entryData = device.messageQueue[i].data;
                            const tmpFileIndex = 0xff00 & entryData.charCodeAt(0) << 8 | 0x00ff & entryData.charCodeAt(1);
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
                        this.log('warn', `upload block ${device.fileIndex} failed for ${mac}`);
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
                        this.log('info', `finished upload to ${mac}`);
                        this.clearDeviceMessageQueue(mac);
                        // if is app upload, send app upload finish (starts with TBIN)
                        if (device.file != null
                            && bytesToBinaryString(device.file.subarray(0, 4)) === 'TBIN') {
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
                    break;
                }
                case 'N': // tios firmware upload
                    this.sendToDevice(mac, PCODE_COMMANDS.REBOOT, '', false);
                    break;
                case PCODE_COMMANDS.APPUPLOADFINISH: {
                    let verifyCount = 0;
                    this.log('info', `${mac}, resetting...`);
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

                    const fileString = verifyDevice.file != null
                        ? bytesToBinaryString(verifyDevice.file)
                        : '';
                    verifyDevice.verificationTimer = setInterval(() => {
                        this.sendToDevice(mac, PCODE_COMMANDS.INFO, '');
                        const dev = this.getDevice(mac);
                        if (dev.appVersion != '' && dev.file) {
                            if (fileString.indexOf(dev.appVersion) >= 0) {
                                this.log('info', `${mac}, upload complete`);
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
                                this.log('warn', `Retrying upload for ${mac} (attempt ${dev.uploadAttempts}/${MAX_UPLOAD_ATTEMPTS})`);
                                this.clearDeviceMessageQueue(mac);
                                this.startApplicationUpload(mac, bytesToBinaryString(dev.file), dev.deviceDefinition);
                            } else {
                                this.log('error', `Upload verification failed for ${mac} after ${dev.uploadAttempts} attempts`);
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

    async handleDebugPrint(device: TibboDevice, state: string): Promise<void> {
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
            const start = Date.now();
            const val = await this.getVariable(address, device.mac);
            const end = Date.now();
            this.log('info', `getVariable ${val} took ${end - start}ms`);
            this.emit(TIBBO_PROXY_MESSAGE.DEBUG_PRINT, {
                data: JSON.stringify({
                    data: val,
                    state
                }),
                mac: device.mac
            });
            const deviceState: PCODEMachineState = <PCODEMachineState>state.substring(0, 3);
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

    removeDeviceMessage(mac: string, nonce: string): void {
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

    clearDeviceMessageQueue(mac: string): void {
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

    stopApplicationUpload(address: string): void {
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

    /**
     * UDP (TiOS) application upload. A plain TBIN streams directly; anything
     * else goes through the firmware path, optionally prepending a TiOS image
     * from the host's firmware resolver when the device refuses `Q`.
     */
    async startApplicationUpload(mac: string, fileString: UploadData, deviceDefinition?: any, resetAttempts = false): Promise<void> {
        if (!mac && !deviceDefinition) {
            return;
        }

        const bytes = uploadDataToBytes(fileString);

        // Reset upload attempt counter on a fresh upload from the client
        if (resetAttempts) {
            const dev = this.getDevice(mac);
            dev.uploadAttempts = 0;
        }

        const isPlainTpc = bytes.length >= 12
            && bytesToBinaryString(bytes.subarray(0, 4)) === 'TBIN'
            && bytesToBinaryString(bytes.subarray(bytes.length - 4)) === 'TBIN';

        if (!isPlainTpc) {
            await this.startFirmwareUpload(mac, bytes, deviceDefinition);
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

        // We can only skip Q when QF is going to run immediately after (loader
        // case below); otherwise Q is needed to reset the device's upload state
        // before streaming D blocks.
        const deviceInfo = await this.getDeviceInfo(mac);
        const inLoader = deviceInfo.tios.indexOf('TiOS-32 Loader') >= 0;
        let qAcked = false;
        if (!inLoader) {
            device.resetProgrammingToken = new Deferred();
            device.resetProgrammingToken.command = PCODE_COMMANDS.RESET_PROGRAMMING;
            this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING, '', true);
            await device.resetProgrammingToken.wait(5000);
            qAcked = !!device.resetProgrammingToken
                && device.resetProgrammingToken.message === REPLY_OK;
            device.resetProgrammingToken = undefined;
        }

        if (qAcked) {
            // Running TIOS accepted Q — stream the TPC alone, no firmware reflash.
            this.beginUploadStream(mac);
            return;
        }

        // Loader or Q refused: reflash firmware + TPC via QF.
        let firmwareBytes: Uint8Array | undefined;
        try {
            firmwareBytes = this.host.resolveFirmware
                ? await this.host.resolveFirmware(deviceDefinition)
                : undefined;
        } catch (e: any) {
            this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                data: `Could not read TIOS firmware: ${e && e.message ? e.message : e}`,
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
        if (!deviceDefinition || !firmwareBytes) {
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
        const combined = concatBytes(firmwareBytes, bytes);
        await this.startFirmwareUpload(mac, bytesToBinaryString(combined), deviceDefinition);
    }

    async startFirmwareUpload(mac: string, fileString: UploadData, deviceDefinition?: any): Promise<void> {
        const bytes = uploadDataToBytes(fileString);

        this.log('info', 'starting firmware upload for ' + mac);
        const device: TibboDevice = this.getDevice(mac);

        const isZephyr = !(bytes.length >= 8
            && bytesToBinaryString(bytes.subarray(bytes.length - 4)) === 'TBIN');

        // Guard against concurrent uploads: cancel any in-progress upload first
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

        // Skip QF when the device is already in the loader — it's ready for firmware blocks.
        const deviceInfo = await this.getDeviceInfo(mac);
        const inLoader = deviceInfo.tios.indexOf('TiOS-32 Loader') >= 0;
        if (!inLoader) {
            device.resetProgrammingToken = new Deferred();
            device.resetProgrammingToken.command = PCODE_COMMANDS.RESET_PROGRAMMING_FIRMWARE;
            this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING_FIRMWARE, '', true);

            let qfRetry: ReturnType<typeof setTimeout> | undefined;
            if (isZephyr) {
                qfRetry = setTimeout(() => {
                    if (device.resetProgrammingToken
                        && device.resetProgrammingToken.message !== REPLY_OK) {
                        this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING_FIRMWARE, '', true);
                    }
                }, 3000);
            }
            await device.resetProgrammingToken.wait(10000);
            if (qfRetry) clearTimeout(qfRetry);

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
    }

    private beginUploadStream(mac: string): void {
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
            } else {
                stallCount = 0;
                lastFileIndex = dev.fileIndex;
            }
            if (stallCount >= 3) {
                this.log('error', `Upload stalled for ${mac} at block ${dev.fileIndex} for ${stallCount * (UPLOAD_STALL_TIMEOUT_MS / 3)}ms`);
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

    sendBlock(mac: string, blockIndex: number): void {
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
            const currentBlock = blockIndex + i;
            const fileBlock = device.file.subarray(
                (device.fileIndex + i) * BLOCK_SIZE,
                (device.fileIndex + i) * BLOCK_SIZE + BLOCK_SIZE
            );

            const fullBlockSize = BLOCK_SIZE + 2;
            const block = new Uint8Array(fullBlockSize); // zero-filled like the Buffer.alloc filler
            block[0] = (0xff00 & currentBlock) >> 8;
            block[1] = 0x00ff & currentBlock;
            block.set(fileBlock, 2);

            const blockString = bytesToBinaryString(block);
            this.sendToDevice(mac, PCODE_COMMANDS.UPLOAD, blockString, true);
            this.sendToDevice(mac, PCODE_COMMANDS.UPLOAD, blockString, true);
            this.sendToDevice(mac, PCODE_COMMANDS.UPLOAD, blockString, true);
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
            this.log('info', `${new Date().toLocaleTimeString()} sent: ${message}`);
            this.host.send(binaryStringToBytes(`${message}|${pnum}`), device.deviceInterface);

            if (this.timer == undefined) {
                this.timer = setInterval(this.checkMessageQueue.bind(this), 10);
            }
        }
        catch (ex) {
            this.log('error', ex);
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
                    this.log('warn', `Discarding message after ${pendingMessage.tries} attempts: ${pendingMessage.message}`);
                    this.pendingMessages.splice(i, 1);
                    this.handleUploadMessageTimeout(pendingMessage);
                    continue;
                }

                // Check if the route is still valid before retrying
                if (this.host.isValidRoute && !this.host.isValidRoute(pendingMessage.deviceInterface)) {
                    this.log('warn', `Interface no longer valid, discarding message: ${pendingMessage.message}`);
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
                    this.log('info', `Retrying message (attempt ${pendingMessage.tries}): ${pendingMessage.message}`);
                    this.host.send(
                        binaryStringToBytes(`${pendingMessage.message}|${pendingMessage.nonce}`),
                        pendingMessage.deviceInterface
                    );
                } catch (err: any) {
                    this.log('error', `Error retrying message: ${err.message}`);
                    // Remove the message if we can't retry it
                    this.pendingMessages.splice(i, 1);
                    // Don't increment i since we removed an item
                    continue;
                }
            }

            // Only increment if we didn't remove an item
            i++;
        }

        if (this.pendingMessages.length === 0 && this.timer != undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private handleUploadMessageTimeout(pendingMessage: UDPMessage): void {
        const macMatch = pendingMessage.message.match(/\[([^\]]+)\]/);
        if (!macMatch) return;

        const mac = macMatch[1];
        const device = this.getDevice(mac);
        if (!device.file) return;

        const commandStart = pendingMessage.message.indexOf(']') + 1;
        const msgAfterBracket = pendingMessage.message.substring(commandStart);

        const isUploadBlock = msgAfterBracket.indexOf(PCODE_COMMANDS.UPLOAD) === 0;
        // QF starts with 'Q' so test it first; otherwise it'd be misclassified as plain Q.
        const isResetProgrammingFirmware = msgAfterBracket.indexOf(PCODE_COMMANDS.RESET_PROGRAMMING_FIRMWARE) === 0;
        const isResetProgramming = !isResetProgrammingFirmware
            && msgAfterBracket.indexOf(PCODE_COMMANDS.RESET_PROGRAMMING) === 0;
        const isAppUploadFinish = msgAfterBracket.indexOf(PCODE_COMMANDS.APPUPLOADFINISH) === 0;

        if (!isUploadBlock && !isResetProgramming && !isResetProgrammingFirmware && !isAppUploadFinish) return;

        for (let i = 0; i < device.messageQueue.length; i++) {
            if (device.messageQueue[i].nonce === pendingMessage.nonce) {
                device.messageQueue.splice(i, 1);
                break;
            }
        }

        device.uploadRetries = (device.uploadRetries || 0) + 1;

        if (device.uploadRetries > MAX_UPLOAD_RETRIES) {
            this.log('error', `Upload failed for ${mac} after ${device.uploadRetries} block-level retries`);
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

        this.log('info', `Upload message timed out for ${mac}, retrying (attempt ${device.uploadRetries}/${MAX_UPLOAD_RETRIES})`);
        this.clearDeviceMessageQueue(mac);

        if (isResetProgrammingFirmware) {
            this.sendToDevice(mac, PCODE_COMMANDS.RESET_PROGRAMMING_FIRMWARE, '', true);
        } else if (isResetProgramming) {
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

    private async getVariable(address: number, mac: string): Promise<string> {
        const COMMAND_WAIT_TIME = 3000;
        const READ_BLOCK_SIZE = 16;
        const TRIES = 3;
        let outputString = '';
        for (let t = 0; t < TRIES; t++) {
            try {
                const tmpAddress = address.toString(16).padStart(4, '0');
                const sizeCall = new Deferred();
                this.memoryCalls[tmpAddress] = sizeCall;
                this.sendToDevice(mac, PCODE_COMMANDS.GET_MEMORY, tmpAddress + ',02', true);
                await sizeCall.wait(COMMAND_WAIT_TIME);
                if (!sizeCall.message) {
                    throw new Error('timeout for getting string length');
                }
                const stringSize = parseInt(sizeCall.message[0], 16);
                const startAddress = address + 2;
                let blocks = Math.floor(stringSize / READ_BLOCK_SIZE);
                if (stringSize % READ_BLOCK_SIZE != 0) {
                    blocks++;
                }
                const blockRequests = [...Array(blocks).keys()];
                await Promise.all(
                    blockRequests.map(async (block) => {
                        let count = READ_BLOCK_SIZE;
                        const blockIndex = (block * READ_BLOCK_SIZE);
                        if (blockIndex + count > stringSize) {
                            count = stringSize - blockIndex;
                        }
                        const strAddress = (startAddress + block * READ_BLOCK_SIZE).toString(16).padStart(4, '0');
                        const blockCall = new Deferred();
                        this.memoryCalls[strAddress] = blockCall;
                        this.log('info', `started getting block ${block}`);
                        this.sendToDevice(mac, PCODE_COMMANDS.GET_MEMORY, strAddress + ',' + count.toString(16).padStart(2, '0'), true);
                        await blockCall.wait(COMMAND_WAIT_TIME);
                        this.log('info', `finished getting block ${block}`);
                    }).map((p) => p.catch((e) => e))
                );
                for (let i = 0; i < blocks; i++) {
                    const block = i;
                    let count = READ_BLOCK_SIZE;
                    const blockIndex = (block * READ_BLOCK_SIZE);
                    if (blockIndex + count > stringSize) {
                        count = stringSize - blockIndex;
                    }
                    const strAddress = (startAddress + block * READ_BLOCK_SIZE).toString(16).padStart(4, '0');
                    const blockCall = this.memoryCalls[strAddress];
                    if (!blockCall || !blockCall.message) {
                        throw new Error('timeout for getting string value at ' + blockIndex);
                    }
                    for (let k = 0; k < blockCall.message.length; k++) {
                        const charCode = parseInt(blockCall.message[k], 16);
                        outputString += String.fromCharCode(charCode);
                    }
                    delete this.memoryCalls[strAddress];
                }
                return outputString;
            }
            catch (ex) {
                this.log('error', ex);
            }
        }
        return outputString;
    }

    async getDeviceInfo(mac: string): Promise<TibboDevice> {
        const device = this.getDevice(mac);
        device.infoToken = new Deferred();
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

        const device: TibboDevice = {
            ip: '',
            mac: mac,
            messageQueue: [],
            tios: '',
            app: '',
            appVersion: '',
            fileIndex: 0,
            fileBlocksTotal: 0,
            type: 'tios',
            // -1 = state unknown until the first PC reply (newer TS versions
            // disallow bare numeric literals on enum-typed fields)
            pcode: -1 as PCODE_STATE,
            blockSize: 1,
            state: PCODEMachineState.STOPPED,
        };

        this.devices.push(device);
        return device;
    }

    getDevices(): Array<TibboDevice> {
        return this.devices;
    }

    /** Stop all timers and clear protocol state. */
    dispose(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        for (const device of this.devices) {
            this.stopApplicationUpload(device.mac);
        }
        this.pendingMessages = [];
        this.devices = [];
        this.discoveredDevices = {};
        this.memoryCalls = {};
    }
}

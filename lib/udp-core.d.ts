export declare const TIBBO_UDP_PORT = 65535;
export declare enum PCODEMachineState {
    STOPPED = "***",
    RUN = "*R*",
    PAUSED = "**B",
    DEBUG_PRINT_AND_STOP = "**P",
    DEBUG_PRINT_AND_CONTINUE = "*P*"
}
export declare enum PCODE_STATE {
    STOPPED = 0,
    PAUSED = 1,
    RUNNING = 2
}
export declare enum PCODE_COMMANDS {
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
    DISCOVER = "_?",
    INFO = "X",
    RESET_PROGRAMMING = "Q",
    RESET_PROGRAMMING_FIRMWARE = "QF",
    UPLOAD = "D",
    APPUPLOADFINISH = "T",
    BUZZ = "B",
    REBOOT = "EC"
}
export declare enum TIBBO_PROXY_MESSAGE {
    REFRESH = "refresh",
    DEVICE = "device",
    BUZZ = "buzz",
    REBOOT = "reboot",
    UPLOAD = "upload",
    REGISTER = "register",
    APPLICATION_UPLOAD = "application",
    FIRMWARE_UPLOAD = "firmware",
    UPLOAD_COMPLETE = "upload_complete",
    STATE = "state",
    COMMAND = "command",
    REPLY = "reply",
    SET_PDB_STORAGE_ADDRESS = "set_pdb_storage_address",
    DEBUG_PRINT = "debug_print",
    HTTP = "http",
    HTTP_RESPONSE = "http_response",
    ATTACH_SERIAL = "attach_serial",
    DETACH_SERIAL = "detach_serial",
    GPIO_SET = "gpio_set",
    WIEGAND_SEND = "wiegand_send",
    UPLOAD_ERROR = "upload_error",
    MESSAGE = "message",
    POLL_DEVICE = "poll_device",
    START_GDB = "start_gdb",
    STOP_GDB = "stop_gdb",
    GDB_STARTED = "gdb_started",
    GDB_CONSOLE = "gdb_console"
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
    deviceId?: string;
    resetProgrammingToken?: Deferred;
    infoToken?: Deferred;
}
export declare type UDPCoreLogLevel = 'info' | 'warn' | 'error';
export interface UDPCoreHost {
    send(data: Uint8Array, route?: any): void;
    isValidRoute?(route: any): boolean;
    emit(channel: string, content: any): void;
    log?(level: UDPCoreLogLevel, message: any): void;
    resolveFirmware?(deviceDefinition: any, deviceId?: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
    onDeviceDiscovered?(device: TibboDevice): void;
}
export declare class Deferred {
    command?: PCODE_COMMANDS;
    message?: any;
    private promise;
    private resolveFn;
    constructor();
    notify(): void;
    wait(timeoutMs: number): Promise<void>;
}
export declare function binaryStringToBytes(str: string): Uint8Array;
export declare type UploadData = string | Uint8Array | ArrayBuffer | ArrayBufferView | number[] | {
    type: 'Buffer';
    data: number[];
};
export declare function uploadDataToBytes(data: UploadData | null | undefined): Uint8Array;
export declare function extractDeviceIdFromBinary(bytes: Uint8Array): string | undefined;
export declare function bytesToBinaryString(bytes: Uint8Array): string;
export declare class TibboUDPCore {
    devices: Array<TibboDevice>;
    pendingMessages: Array<UDPMessage>;
    timer?: ReturnType<typeof setInterval>;
    memoryCalls: {
        [key: string]: Deferred | undefined;
    };
    discoveredDevices: {
        [key: string]: string;
    };
    private host;
    constructor(host: UDPCoreHost);
    private log;
    private emit;
    handleRefresh(): void;
    setPDBAddress(message: TaikoMessage): void;
    pollDevice(mac: string): void;
    handleMessage(data: Uint8Array, fromIp: string, route?: any): void;
    handleDebugPrint(device: TibboDevice, state: string): Promise<void>;
    removeDeviceMessage(mac: string, nonce: string): void;
    clearDeviceMessageQueue(mac: string): void;
    stopApplicationUpload(address: string): void;
    startApplicationUpload(mac: string, fileString: UploadData, deviceDefinition?: any, resetAttempts?: boolean): Promise<void>;
    startFirmwareUpload(mac: string, fileString: UploadData, deviceDefinition?: any): Promise<void>;
    private beginUploadStream;
    sendBlock(mac: string, blockIndex: number): void;
    sendToDevice(mac: string, command: string, data: string, reply?: boolean, nonce?: string | undefined): void;
    checkMessageQueue(): void;
    private handleUploadMessageTimeout;
    makeid(length: number): string;
    private getVariable;
    getDeviceInfo(mac: string): Promise<TibboDevice>;
    getDevice(mac: string): TibboDevice;
    getDevices(): Array<TibboDevice>;
    dispose(): void;
}

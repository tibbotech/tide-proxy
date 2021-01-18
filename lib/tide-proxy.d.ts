/// <reference types="node" />
import * as dgram from 'dgram';
interface UDPMessage {
    message: string;
    nonce: string;
    tries: number;
    timestamp: number;
}
interface TBNetworkInterface {
    socket: dgram.Socket;
    netInterface: any;
}
export declare class TIDEProxy {
    devices: Array<TibboDevice>;
    pendingMessages: Array<UDPMessage>;
    timer?: NodeJS.Timeout;
    interfaces: Array<TBNetworkInterface>;
    currentInterface: TBNetworkInterface | undefined;
    socket: any;
    memoryCalls: {
        [key: string]: any;
    };
    constructor(serverAddress: string | undefined, proxyName: string, port?: number);
    setPDBAddress(message: TaikoMessage): void;
    handleMessage(msg: Buffer, info: any, socket: TBNetworkInterface): Promise<void>;
    handleDebugPrint(device: TibboDevice, deviceState: PCODEMachineState): Promise<void>;
    startApplicationUpload(mac: string, fileString: string): void;
    sendBlock(mac: string, fileBlock: Buffer, blockIndex: number): void;
    sendToDevice(mac: string, command: string, data: string, reply?: boolean, nonce?: string | undefined): void;
    checkMessageQueue(): void;
    makeid(length: number): string;
    send(message: Buffer): void;
    getBroadcastAddress(address: string, netmask: string): string;
    private getVariable;
    getDevice(mac: string): TibboDevice;
}
export interface TibboDevice {
    ip: string;
    mac: string;
    messageQueue: Array<TaikoMessage>;
    tios: string;
    app: string;
    file?: Buffer;
    fileIndex: number;
    fileBlocksTotal: number;
    pcode: PCODE_STATE;
    lastRunCommand?: TaikoMessage;
    state: PCODEMachineState;
    pdbStorageAddress?: number;
}
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
    UPLOAD = "D",
    APPUPLOADFINISH = "T",
    BUZZ = "B",
    REBOOT = "E"
}
export declare enum TIBBO_PROXY_MESSAGE {
    REFRESH = "refresh",
    DEVICE = "device",
    BUZZ = "buzz",
    REBOOT = "reboot",
    UPLOAD = "upload",
    REGISTER = "register",
    APPLICATION_UPLOAD = "application",
    UPLOAD_COMPLETE = "upload_complete",
    STATE = "state",
    COMMAND = "command",
    REPLY = "reply",
    SET_PDB_STORAGE_ADDRESS = "set_pdb_storage_address",
    DEBUG_PRINT = "debug_print"
}
export {};

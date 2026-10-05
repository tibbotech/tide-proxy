/// <reference types="node" />
import * as dgram from 'dgram';
import SerialDevice from './NodeSerialPort';
import { GdbProxyServer } from './gdb-server';
import { TaikoMessage, TibboDevice, TibboUDPCore, UDPMessage, UploadData } from './udp-core';
export * from './udp-core';
export interface TIDEProxyToolPaths {
    openocd?: string;
    bossac?: string;
    jlink?: string;
    nrfutil?: string;
}
export interface TIDEProxyOptions {
    serverAddress?: string;
    proxyName?: string;
    port?: number;
    targetInterface?: string;
    toolPaths?: TIDEProxyToolPaths;
}
interface TBNetworkInterface {
    socket: dgram.Socket;
    netInterface: any;
}
export interface JLinkProbe {
    index: number;
    connection: string;
    serialNumber: string;
    productName: string;
    nickname: string;
    address: string;
}
export declare function parseJLinkEmuList(output: string): JLinkProbe[];
export interface NrfutilDevice {
    serialNumber: string;
    boardVersion: string;
    deviceFamily: string;
    traits: string[];
    serialPorts: string[];
}
export declare function parseNrfutilDeviceList(output: string): NrfutilDevice[];
export declare function nrfutilProgressPercentage(event: any): number | undefined;
export declare function binToIntelHex(bytes: Buffer, baseAddress?: number, recordLength?: number): string;
export declare class TIDEProxy {
    core: TibboUDPCore;
    interfaces: Array<TBNetworkInterface>;
    currentInterface: TBNetworkInterface | undefined;
    socket: any;
    server: any;
    id: string;
    clients: any[];
    listenPort: number;
    serialDevices: {
        [key: string]: SerialDevice;
    };
    adks: any[];
    networkWatcherTimer?: NodeJS.Timeout;
    lastInterfaceState: string;
    toolPaths: TIDEProxyToolPaths;
    gdbProxyServer?: GdbProxyServer;
    get devices(): Array<TibboDevice>;
    set devices(value: Array<TibboDevice>);
    get pendingMessages(): Array<UDPMessage>;
    set pendingMessages(value: Array<UDPMessage>);
    get discoveredDevices(): {
        [key: string]: string;
    };
    set discoveredDevices(value: {
        [key: string]: string;
    });
    get memoryCalls(): {
        [key: string]: any;
    };
    constructor(serverAddress: string, proxyName: string, port?: number, targetInterface?: string, options?: TIDEProxyOptions);
    constructor(options: TIDEProxyOptions);
    initInterfaces(targetInterface?: any): void;
    private clearPendingOperations;
    private cleanupOldInterfaces;
    private getInterfaceState;
    private startNetworkWatcher;
    private stopNetworkWatcher;
    setInterface(targetInterface: string): void;
    registerListeners(socket: any): void;
    startGdbServer(mac: string, withConsole?: boolean): Promise<number>;
    stopGdbServer(): void;
    setServer(serverAddress: string, proxyName: string): void;
    setADKS(adks: any[]): void;
    handleRefresh(debuggerType?: string): void;
    setPDBAddress(message: TaikoMessage): void;
    handleMessage(msg: Buffer, info: any, socket: TBNetworkInterface): void;
    handleDebugPrint(device: TibboDevice, state: string): Promise<void>;
    removeDeviceMessage(mac: string, nonce: string): void;
    clearDeviceMessageQueue(mac: string): void;
    stopApplicationUpload(address: string): void;
    private resolveTiosFirmwarePath;
    startApplicationUpload(mac: string, fileString: UploadData, deviceDefinition?: any, method?: string, files?: any[], baudRate?: number): Promise<void>;
    startFirmwareUpload(mac: string, fileString: UploadData, deviceDefinition?: any): Promise<void>;
    uploadESP32(mac: string, bytes: Buffer, deviceDefinition: any, baudRate: number): void;
    uploadBossac(mac: string, bytes: Buffer, deviceDefinition: any): void;
    uploadOpenOCD(mac: string, bytes: Buffer, deviceDefinition: any): void;
    uploadJLink(mac: string, bytes: Buffer, deviceDefinition: any): void;
    uploadTeensy(mac: string, bytes: Buffer, deviceDefinition: any): void;
    startUploadMicropython(mac: string, files: any[], baudRate: number): Promise<void>;
    startUploadEsp32(mac: string, files: any[], baudRate: number): Promise<void>;
    sendBlock(mac: string, blockIndex: number): void;
    sendToDevice(mac: string, command: string, data: string, reply?: boolean, nonce?: string | undefined): void;
    checkMessageQueue(): void;
    private isValidInterface;
    makeid(length: number): string;
    private getBroadcastAddress;
    private isSocketActive;
    private sendToSocket;
    send(message: Buffer, netInterface?: any, targetIP?: string): void;
    private sendToSingleInterface;
    private sendToAllInterfaces;
    getDeviceInfo(mac: string): Promise<TibboDevice>;
    getDevice(mac: string): TibboDevice;
    handleHTTPProxy(message: HTTPMessage): Promise<void>;
    emit(channel: string, content: any): void;
    close(): void;
    getDevices(): Array<TibboDevice>;
    stop(): Promise<void>;
    getSerialPorts(): Promise<void>;
    getJLinkDevices(): Promise<void>;
    getNrfutilDevices(): Promise<void>;
    uploadNrfutil(mac: string, bytes: Buffer, deviceDefinition: any): void;
    attachSerial(port: string, baudRate?: number, reset?: boolean): Promise<boolean>;
    detachSerial(port: string): Promise<void>;
}
export interface HTTPMessage {
    url: string;
    data: any;
    method: string;
    headers: any;
    nonce?: string;
}

/// <reference types="node" />
import * as dgram from 'dgram';
import SerialDevice from './NodeSerialPort';
import { TaikoMessage, TibboDevice, TibboUDPCore, UDPMessage } from './udp-core';
export * from './udp-core';
export interface TIDEProxyToolPaths {
    openocd?: string;
    bossac?: string;
    jlink?: string;
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
    setServer(serverAddress: string, proxyName: string): void;
    setADKS(adks: any[]): void;
    handleRefresh(): void;
    setPDBAddress(message: TaikoMessage): void;
    handleMessage(msg: Buffer, info: any, socket: TBNetworkInterface): void;
    handleDebugPrint(device: TibboDevice, state: string): Promise<void>;
    removeDeviceMessage(mac: string, nonce: string): void;
    clearDeviceMessageQueue(mac: string): void;
    stopApplicationUpload(address: string): void;
    private resolveTiosFirmwarePath;
    startApplicationUpload(mac: string, fileString: string, deviceDefinition?: any, method?: string, files?: any[], baudRate?: number): Promise<void>;
    startFirmwareUpload(mac: string, fileString: string, deviceDefinition?: any): Promise<void>;
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

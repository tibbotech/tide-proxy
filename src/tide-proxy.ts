import * as dgram from 'dgram';
import { SerialPort } from 'serialport';
import { NodeESP32Serial as ESP32Serial } from './ESP32Serial/node';
import { MicropythonSerial } from './MicropythonSerial';
import SerialDevice from './NodeSerialPort';
import { GdbProxyServer } from './gdb-server';

import axios, { Method } from 'axios';
import { io as socketIOClient } from 'socket.io-client';
import {
    PCODE_COMMANDS,
    PCODEMachineState,
    TaikoMessage,
    TIBBO_PROXY_MESSAGE,
    TIBBO_UDP_PORT,
    TibboDevice,
    TibboUDPCore,
    UDPMessage,
    UploadData,
    uploadDataToBytes,
} from './udp-core';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const url = require('url');
const io = require("socket.io")({ serveClient: false, cors: { origin: "*" }, maxHttpBufferSize: 1e10 });
const os = require('os');
const http = require('http');

// The platform-agnostic protocol engine (device registry, retry queue,
// upload state machine) lives in udp-core and is shared with other hosts
// (e.g. the mobile app). Types and enums are re-exported for compatibility.
export * from './udp-core';

const PORT = TIBBO_UDP_PORT;


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
    socket: dgram.Socket,
    netInterface: any
}

const LOG_SILENT = process.env.TIDE_PROXY_VERBOSE ? false : true;
const logger = {
    info: (...args: any[]) => { if (!LOG_SILENT) console.info('info:', ...args); },
    warn: (...args: any[]) => { if (!LOG_SILENT) console.warn('warn:', ...args); },
    error: (...args: any[]) => { if (!LOG_SILENT) console.error('error:', ...args); },
};

const PROJECT_OUTPUT_FOLDER = process.env.TIDE_PROXY_OUTPUT_DIR
    || path.join(os.tmpdir(), 'tide-proxy', 'project_output');

export interface JLinkProbe {
    index: number;
    connection: string;
    serialNumber: string;
    productName: string;
    nickname: string;
    address: string;
}

/**
 * Parse the output of the J-Link Commander `ShowEmuList` command, e.g.
 * `J-Link[0]: Connection: USB, Serial number: 260103158, ProductName: J-Link EDU Mini`
 */
export function parseJLinkEmuList(output: string): JLinkProbe[] {
    const probes: JLinkProbe[] = [];
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
        const match = line.trim().match(/^J-Link\[(\d+)\]:\s*(.*)$/);
        if (!match) {
            continue;
        }
        const probe: JLinkProbe = {
            index: Number(match[1]),
            connection: '',
            serialNumber: '',
            productName: '',
            nickname: '',
            address: '',
        };
        // fields are comma separated `key: value` pairs
        for (const field of match[2].split(',')) {
            const separator = field.indexOf(':');
            if (separator === -1) {
                continue;
            }
            const key = field.substring(0, separator).trim().toLowerCase().replace(/[\s-]/g, '');
            let value = field.substring(separator + 1).trim();
            if (value === '<not set>') {
                value = '';
            }
            switch (key) {
                case 'connection':
                    // USB connections are plain, IP ones may read `IP (192.168.1.5)`
                    const address = value.match(/\(([^)]+)\)/);
                    probe.connection = value.replace(/\s*\([^)]*\)/, '');
                    if (address) {
                        probe.address = address[1];
                    }
                    break;
                case 'serialnumber':
                    probe.serialNumber = value;
                    break;
                case 'productname':
                    probe.productName = value;
                    break;
                case 'nickname':
                    probe.nickname = value;
                    break;
                case 'ipaddr':
                    probe.address = value;
                    break;
            }
        }
        probes.push(probe);
    }
    return probes;
}

export interface NrfutilDevice {
    serialNumber: string;
    boardVersion: string;
    deviceFamily: string;
    traits: string[];
    serialPorts: string[];
}

/**
 * Parse the newline delimited JSON `nrfutil device list --json` writes. The
 * device list shows up in several events (`task_end`, `info`); the last one
 * carrying a `devices` array wins.
 */
export function parseNrfutilDeviceList(output: string): NrfutilDevice[] {
    let devices: any[] | undefined = undefined;
    for (const line of output.split(/\r?\n/)) {
        if (line.trim() === '') {
            continue;
        }
        let event: any;
        try {
            event = JSON.parse(line);
        } catch {
            // nrfutil reports early failures as plain text, even with --json
            continue;
        }
        const list = event?.data?.devices;
        if (Array.isArray(list)) {
            devices = list;
        }
    }
    if (devices === undefined) {
        return [];
    }
    return devices.map((device: any) => ({
        serialNumber: String(device?.serialNumber ?? ''),
        boardVersion: device?.devkit?.boardVersion || '',
        deviceFamily: device?.devkit?.deviceFamily || '',
        traits: Object.keys(device?.traits || {}).filter((trait: string) => device.traits[trait] === true),
        serialPorts: (device?.serialPorts || []).map((port: any) => port?.path).filter((path: any) => !!path),
    }));
}

/**
 * Pull a progress percentage out of an `nrfutil --json` event. The percentage
 * moved around between nrfutil versions, so search the event for it instead of
 * relying on one path.
 */
export function nrfutilProgressPercentage(event: any): number | undefined {
    if (event === null || typeof event !== 'object') {
        return undefined;
    }
    for (const key of Object.keys(event)) {
        const value = event[key];
        if (key === 'progressPercentage' && typeof value === 'number') {
            return value;
        }
        const nested = nrfutilProgressPercentage(value);
        if (nested !== undefined) {
            return nested;
        }
    }
    return undefined;
}

/**
 * Convert a raw binary image into Intel HEX starting at `baseAddress`.
 * `nrfutil device program` only takes IntelHex (or zip) firmware, while device
 * definitions may well hand us a `.bin`.
 */
export function binToIntelHex(bytes: Buffer, baseAddress = 0, recordLength = 16): string {
    const record = (type: number, address: number, data: number[]): string => {
        const bytesOut = [data.length, (address >> 8) & 0xff, address & 0xff, type, ...data];
        const sum = bytesOut.reduce((total, byte) => total + byte, 0);
        bytesOut.push((0x100 - (sum & 0xff)) & 0xff);
        return ':' + bytesOut.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join('');
    };

    const lines: string[] = [];
    let upperAddress = -1;
    for (let offset = 0; offset < bytes.length; offset += recordLength) {
        const address = baseAddress + offset;
        const upper = (address >>> 16) & 0xffff;
        if (upper !== upperAddress) {
            lines.push(record(0x04, 0, [(upper >> 8) & 0xff, upper & 0xff]));
            upperAddress = upper;
        }
        lines.push(record(0x00, address & 0xffff, [...bytes.slice(offset, offset + recordLength)]));
    }
    lines.push(record(0x01, 0, []));
    return lines.join('\n') + '\n';
}

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
    return path.join(__dirname, '..', 'platforms');
}

export class TIDEProxy {
    core: TibboUDPCore;
    interfaces: Array<TBNetworkInterface> = [];
    currentInterface: TBNetworkInterface | undefined = undefined;
    socket: any;
    server: any;
    id: string;
    clients: any[];
    listenPort: number;
    serialDevices: { [key: string]: SerialDevice } = {};
    adks: any[] = [];
    networkWatcherTimer?: NodeJS.Timeout;
    lastInterfaceState: string = '';
    toolPaths: TIDEProxyToolPaths;
    gdbProxyServer?: GdbProxyServer;

    // Device/protocol state lives in the shared UDP core; exposed here for API compatibility.
    get devices(): Array<TibboDevice> {
        return this.core.devices;
    }
    set devices(value: Array<TibboDevice>) {
        this.core.devices = value;
    }
    get pendingMessages(): Array<UDPMessage> {
        return this.core.pendingMessages;
    }
    set pendingMessages(value: Array<UDPMessage>) {
        this.core.pendingMessages = value;
    }
    get discoveredDevices(): { [key: string]: string } {
        return this.core.discoveredDevices;
    }
    set discoveredDevices(value: { [key: string]: string }) {
        this.core.discoveredDevices = value;
    }
    get memoryCalls(): { [key: string]: any } {
        return this.core.memoryCalls;
    }

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
            nrfutil: toolPaths.nrfutil || (isWindows ? 'nrfutil.exe' : 'nrfutil'),
        };

        this.core = new TibboUDPCore({
            send: (data: Uint8Array, route?: any) => {
                this.send(Buffer.from(data), route);
            },
            isValidRoute: (route: any) => this.isValidInterface(route),
            emit: (channel: string, content: any) => this.emit(channel, content),
            log: (level: 'info' | 'warn' | 'error', message: any) => logger[level](message),
            resolveFirmware: (deviceDefinition: any, deviceId?: string) => {
                const firmwarePath = this.resolveTiosFirmwarePath(deviceDefinition, deviceId);
                if (!firmwarePath) {
                    return undefined;
                }
                try {
                    return fs.readFileSync(firmwarePath);
                } catch (e: any) {
                    throw new Error(`${firmwarePath}: ${e && e.message ? e.message : e}`);
                }
            },
            onDeviceDiscovered: (device: TibboDevice) => {
                const adk = this.adks.find((adk: any) => adk.address === device.mac);
                if (adk) {
                    device.streamURL = adk.streamURL;
                }
            },
        });

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
        if (this.core.timer) {
            clearInterval(this.core.timer);
            this.core.timer = undefined;
        }

        // Clear pending messages to prevent retries on closed sockets
        this.core.pendingMessages = [];
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

        socket.on(TIBBO_PROXY_MESSAGE.REFRESH, (debuggerType?: string) => {
            this.handleRefresh(debuggerType);
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
        socket.on(TIBBO_PROXY_MESSAGE.FIRMWARE_UPLOAD, (message: any) => {
            this.startFirmwareUpload(message.mac, message.data, message.deviceDefinition);
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

        socket.on(TIBBO_PROXY_MESSAGE.START_GDB, async (message: any, ack?: (response: any) => void) => {
            try {
                const port = await this.startGdbServer(message.mac, message.console);
                if (typeof ack === 'function') {
                    ack({ port });
                }
                this.emit(TIBBO_PROXY_MESSAGE.GDB_STARTED, { mac: message.mac, port });
            } catch (ex: any) {
                logger.error(`failed to start GDB server: ${ex?.message ?? ex}`);
                if (typeof ack === 'function') {
                    ack({ error: ex?.message ?? String(ex) });
                }
            }
        });
        socket.on(TIBBO_PROXY_MESSAGE.STOP_GDB, () => {
            this.stopGdbServer();
        });
    }

    /**
     * Start (or reuse) the in-process GDB RSP server and point it at `mac`.
     * Resolves with the local TCP port GDB should connect to
     * (`target remote localhost:<port>`). When `withConsole` is set, device
     * console output (printk, etc.) is forwarded to clients as GDB_CONSOLE
     * messages.
     */
    async startGdbServer(mac: string, withConsole = false): Promise<number> {
        if (this.gdbProxyServer === undefined) {
            this.gdbProxyServer = new GdbProxyServer(this.listenPort);
        }
        const port = await this.gdbProxyServer.start();
        this.gdbProxyServer.setTarget(mac);
        if (withConsole) {
            this.gdbProxyServer.onConsoleOutput((text: string) => {
                this.emit(TIBBO_PROXY_MESSAGE.GDB_CONSOLE, { mac, data: text });
            });
        } else {
            this.gdbProxyServer.detachConsoleOutput();
        }
        return port;
    }

    /** Tear down the GDB RSP server, if running. */
    stopGdbServer(): void {
        if (this.gdbProxyServer) {
            this.gdbProxyServer.dispose();
            this.gdbProxyServer = undefined;
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
        this.registerListeners(this.socket);
    }

    setADKS(adks: any[]) {
        this.adks = adks;
    }

    handleRefresh(debuggerType?: string) {
        this.core.handleRefresh();
        this.getSerialPorts();
        const type = typeof debuggerType === 'string' ? debuggerType.toLowerCase() : '';
        if (type === 'nrfutil') {
            // nrfutil list devices
            this.getNrfutilDevices();
        } else if (type) {
            // jlink list devices
            this.getJLinkDevices();
        }
    }

    setPDBAddress(message: TaikoMessage): void {
        this.core.setPDBAddress(message);
    }

    handleMessage(msg: Buffer, info: any, socket: TBNetworkInterface) {
        this.core.handleMessage(msg, info.address.toString(), socket);
    }

    handleDebugPrint(device: TibboDevice, state: string): Promise<void> {
        return this.core.handleDebugPrint(device, state);
    }

    removeDeviceMessage(mac: string, nonce: string) {
        this.core.removeDeviceMessage(mac, nonce);
    }

    clearDeviceMessageQueue(mac: string) {
        this.core.clearDeviceMessageQueue(mac);
    }

    stopApplicationUpload(address: string) {
        this.core.stopApplicationUpload(address);
    }

    private resolveTiosFirmwarePath(deviceDefinition: any, deviceId?: string): string | undefined {
        if (typeof deviceDefinition?.tiosFirmwarePath === 'string'
            && fs.existsSync(deviceDefinition.tiosFirmwarePath)) {
            return deviceDefinition.tiosFirmwarePath;
        }

        const root = deviceDefinition?.platformsDir
            || process.env.TIDE_PLATFORMS_DIR
            || resolveAtPlatformsPackageRoot();
        const platform = deviceId || deviceDefinition?.platform || deviceDefinition?.id;
        if (!root || !platform) {
            return undefined;
        }

        const firmwareDir = path.join(root, 'Platforms', platform, 'firmware');
        if (fs.existsSync(firmwareDir) && fs.statSync(firmwareDir).isDirectory()) {
            const explicit = deviceDefinition?.tiosFirmware || deviceDefinition?.firmwareFile;
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

        const legacyName = deviceDefinition?.tiosFirmware || deviceDefinition?.firmwareFile || 'firmware.bin';
        const legacy = path.join(root, platform, 'firmware', legacyName);
        if (fs.existsSync(legacy)) {
            return legacy;
        }
        return undefined;
    }

    async startApplicationUpload(mac: string, fileString: UploadData, deviceDefinition?: any, method?: string, files?: any[], baudRate = 115200): Promise<void> {
        if (!mac && !deviceDefinition) {
            return;
        }

        const raw = uploadDataToBytes(fileString);
        const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);

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
            } else if (method === 'nrfutil') {
                this.uploadNrfutil(mac, bytes, deviceDefinition);
                return;
            } else if (method === 'teensy') {
                this.uploadTeensy(mac, bytes, deviceDefinition);
                return;
            }
        } else {
            // UDP (TiOS) upload path is handled by the shared core.
            await this.core.startApplicationUpload(mac, fileString, deviceDefinition);
        }
    }

    startFirmwareUpload(mac: string, fileString: UploadData, deviceDefinition?: any): Promise<void> {
        return this.core.startFirmwareUpload(mac, fileString, deviceDefinition);
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
        this.core.sendBlock(mac, blockIndex);
    }

    sendToDevice(mac: string, command: string, data: string, reply = true, nonce: string | undefined = undefined): void {
        this.core.sendToDevice(mac, command, data, reply, nonce);
    }

    checkMessageQueue(): void {
        this.core.checkMessageQueue();
    }

    private isValidInterface(deviceInterface: any): boolean {
        if (!deviceInterface || !deviceInterface.socket) {
            return false;
        }

        // Check if this interface still exists in our current interfaces
        return this.interfaces.some(int => int === deviceInterface) &&
            this.isSocketActive(deviceInterface.socket);
    }

    makeid(length: number): string {
        return this.core.makeid(length);
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

    getDeviceInfo(mac: string): Promise<TibboDevice> {
        return this.core.getDeviceInfo(mac);
    }

    getDevice(mac: string): TibboDevice {
        return this.core.getDevice(mac);
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

        // Tear down the GDB RSP server, if running
        this.stopGdbServer();

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

    /**
     * Enumerate the J-Link probes attached to this machine by running the
     * J-Link Commander `ShowEmuList` command, and announce each one as a
     * device (type `jlink`, mac = probe serial number).
     */
    async getJLinkDevices(): Promise<void> {
        const jlinkPath = this.toolPaths.jlink!;
        const scriptPath = path.join(PROJECT_OUTPUT_FOLDER, `${this.makeid(8)}.jlink`);
        try {
            fs.mkdirSync(PROJECT_OUTPUT_FOLDER, { recursive: true });
            fs.writeFileSync(scriptPath, 'ShowEmuList\nExit\n');

            const result = await new Promise<{ output: string, code: number | null }>((resolve, reject) => {
                const ccmd = `${jlinkPath} -nogui 1 -CommanderScript ${scriptPath}`;
                const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 15000, shell: true });
                let output = '';
                exec.stdout.on('data', (data: any) => output += data.toString());
                exec.stderr.on('data', (data: any) => output += data.toString());
                exec.on('error', (error: Error) => reject(error));
                exec.on('close', (code: number | null) => resolve({ output, code }));
            });

            const probes = parseJLinkEmuList(result.output);
            if (probes.length === 0 && result.code !== 0) {
                // the shell swallows a missing binary, so report it from the exit code
                logger.error(`failed to list jlink devices: ${jlinkPath} exited with ${result.code}`);
                this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                    data: `${jlinkPath} not found`,
                    format: 'markdown',
                });
                return;
            }

            for (const probe of probes) {
                const mac = probe.serialNumber || `jlink-${probe.index}`;
                let found = false;
                for (let i = 0; i < this.devices.length; i++) {
                    if (this.devices[i].mac == mac) {
                        found = true;
                        break;
                    }
                }
                const device = {
                    ip: probe.address,
                    mac: mac,
                    messageQueue: [],
                    tios: '',
                    app: probe.productName,
                    appVersion: '',
                    fileIndex: 0,
                    fileBlocksTotal: 0,
                    type: 'jlink',
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
        } catch (ex: any) {
            logger.error(`failed to list jlink devices: ${ex?.message ?? ex}`);
            this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                data: `${jlinkPath} not found`,
                format: 'markdown',
            });
        } finally {
            if (fs.existsSync(scriptPath)) {
                fs.unlinkSync(scriptPath);
            }
        }
    }

    /**
     * Enumerate the devices `nrfutil` can see (J-Link probes, MCUboot/DFU
     * targets) and announce each one as a device (type `nrfutil`,
     * mac = probe serial number).
     */
    async getNrfutilDevices(): Promise<void> {
        const nrfutilPath = this.toolPaths.nrfutil!;
        try {
            const result = await new Promise<{ output: string, code: number | null }>((resolve, reject) => {
                const ccmd = `${nrfutilPath} device list --json`;
                const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30000, shell: true });
                let output = '';
                exec.stdout.on('data', (data: any) => output += data.toString());
                exec.stderr.on('data', (data: any) => output += data.toString());
                exec.on('error', (error: Error) => reject(error));
                exec.on('close', (code: number | null) => resolve({ output, code }));
            });

            if (result.code !== 0) {
                // the shell swallows a missing binary, so report it from the exit code
                logger.error(`failed to list nrfutil devices: ${nrfutilPath} exited with ${result.code}`);
                this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                    data: `${nrfutilPath} not found`,
                    format: 'markdown',
                });
                return;
            }

            for (const nrfDevice of parseNrfutilDeviceList(result.output)) {
                const mac = nrfDevice.serialNumber;
                if (!mac) {
                    continue;
                }
                let found = false;
                for (let i = 0; i < this.devices.length; i++) {
                    if (this.devices[i].mac == mac) {
                        found = true;
                        break;
                    }
                }
                const device = {
                    ip: '',
                    mac: mac,
                    messageQueue: [],
                    tios: '',
                    app: nrfDevice.boardVersion || nrfDevice.deviceFamily,
                    appVersion: '',
                    fileIndex: 0,
                    fileBlocksTotal: 0,
                    type: 'nrfutil',
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
        } catch (ex: any) {
            logger.error(`failed to list nrfutil devices: ${ex?.message ?? ex}`);
            this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                data: `${nrfutilPath} not found`,
                format: 'markdown',
            });
        }
    }

    /**
     * Flash a device with `nrfutil device program`. Recognised upload method
     * options: `--serial-number=`, `--family=`, `--core=`, `--traits=`,
     * `--options=` (raw nrfutil program options) and `--timeout=` (ms).
     * The probe defaults to `mac`, which is how J-Link/nrfutil probes are
     * registered by a debugger refresh.
     */
    uploadNrfutil(mac: string, bytes: Buffer, deviceDefinition: any): void {
        const nrfutilMethod = deviceDefinition.uploadMethods.find((method: any) => method.name === 'nrfutil');
        const nrfutilPath = this.toolPaths.nrfutil!;
        const fileBase = this.makeid(8);
        let serialNumber = mac;
        let family = '';
        let core = '';
        let traits = '';
        let programOptions = 'chip_erase_mode=ERASE_ALL,reset=RESET_SYSTEM';
        let timeout = 120000;
        let filePath = '';
        try {
            for (let i = 0; i < (nrfutilMethod?.options?.length || 0); i++) {
                let option = nrfutilMethod.options[i];
                if (option.indexOf('"') === 0) {
                    option = option.substring(1, option.length - 1);
                }
                const value = option.substring(option.indexOf('=') + 1);
                if (option.indexOf('--serial-number=') === 0 || option.indexOf('--serial=') === 0) {
                    serialNumber = value;
                }
                if (option.indexOf('--family=') === 0) {
                    family = value;
                }
                if (option.indexOf('--core=') === 0) {
                    core = value;
                }
                if (option.indexOf('--traits=') === 0) {
                    traits = value;
                }
                if (option.indexOf('--options=') === 0) {
                    programOptions = value;
                }
                if (option.indexOf('--timeout=') === 0) {
                    timeout = Number(value) || timeout;
                }
            }

            // nrfutil programs IntelHex, so convert a raw binary image
            const isElf = bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
            if (isElf) {
                this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                    data: 'nrfutil cannot program ELF firmware, build a .hex or .bin image',
                    mac: mac,
                });
                return this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                    method: 'nrfutil',
                    code: 'unsupported_format',
                    mac,
                });
            }

            fs.mkdirSync(PROJECT_OUTPUT_FOLDER, { recursive: true });
            filePath = path.join(PROJECT_OUTPUT_FOLDER, `${fileBase}.hex`);
            if (openocdFirmwareExtension(bytes) === 'hex') {
                fs.writeFileSync(filePath, bytes);
            } else {
                const flashAddress = Number(deviceDefinition.flashAddress || 0);
                fs.writeFileSync(filePath, binToIntelHex(bytes, flashAddress));
            }

            const cleanup = () => {
                if (filePath && fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }

            let ccmd = `${nrfutilPath} device program --firmware ${filePath} --json`;
            if (serialNumber) {
                ccmd += ` --serial-number ${serialNumber}`;
            }
            if (family) {
                ccmd += ` --family ${family}`;
            }
            if (core) {
                ccmd += ` --core ${core}`;
            }
            if (traits) {
                ccmd += ` --traits ${traits}`;
            }
            if (programOptions) {
                ccmd += ` --options ${programOptions}`;
            }
            logger.info(ccmd);
            const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout, shell: true });
            if (!exec.pid) {
                cleanup();
                return;
            }
            let cmdOutput = '';
            const handleOutput = (data: any) => {
                const text = data.toString();
                cmdOutput += text;
                logger.info(text);
                for (const line of text.split(/\r?\n/)) {
                    if (line.trim() === '') {
                        continue;
                    }
                    let event: any;
                    try {
                        event = JSON.parse(line);
                    } catch {
                        continue;
                    }
                    const percentage = nrfutilProgressPercentage(event);
                    if (percentage !== undefined) {
                        this.emit(TIBBO_PROXY_MESSAGE.UPLOAD, {
                            data: percentage / 100,
                            mac: mac,
                        });
                    }
                }
            };
            exec.stdout.on('data', handleOutput);
            exec.stderr.on('data', handleOutput);
            exec.on('error', (error: Error) => {
                cleanup();
                this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                    data: `${nrfutilPath} failed: ${error.message}`,
                    mac: mac,
                });
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                    method: 'nrfutil',
                    code: 'not_found',
                    mac,
                });
            });
            exec.on('exit', (code: number | null) => {
                cleanup();
                if (code === 127) {
                    // the shell swallows a missing binary, so report it from the exit code
                    this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                        data: `${nrfutilPath} not found`,
                        format: 'markdown',
                        mac: mac,
                    });
                    return this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                        method: 'nrfutil',
                        code: 'not_found',
                        mac,
                    });
                }
                if (code !== 0) {
                    this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                        data: `nrfutil exited with code ${code} \n${cmdOutput}`,
                        mac: mac,
                    });
                    return this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                        method: 'nrfutil',
                        code: 'error',
                        mac,
                    });
                }
                this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_COMPLETE, {
                    method: 'nrfutil',
                    mac: mac,
                });
            });
        } catch (ex: any) {
            if (filePath && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            this.emit(TIBBO_PROXY_MESSAGE.MESSAGE, {
                data: ex.toString(),
                mac,
            });
            this.emit(TIBBO_PROXY_MESSAGE.UPLOAD_ERROR, {
                method: 'nrfutil',
                mac,
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

export interface HTTPMessage {
    url: string;
    data: any;
    method: string;
    headers: any;
    nonce?: string;
}


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
const serialport_1 = require("serialport");
const { TextEncoder, TextDecoder } = require('util');
const events_1 = require("events");
const { createHash } = require('node:crypto');
class NodeSerialPort extends events_1.EventEmitter {
    constructor(portPath) {
        super();
        this.port = null;
        this.baudRate = 115200;
        this.portPath = '';
        this.flowingMode = true;
        this.portPath = portPath;
        this.sendDebug = this.sendDebug.bind(this);
    }
    connect(baudRate) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                try {
                    this.baudRate = baudRate;
                    const serialPort = new serialport_1.SerialPort({
                        path: this.portPath,
                        baudRate: this.baudRate,
                    });
                    this.port = serialPort,
                        this.flowingMode = true;
                    this.port.on('open', (err) => {
                        if (err) {
                            reject(false);
                        }
                        resolve(true);
                    });
                    this.port.on('data', (data) => {
                        if (!this.flowingMode) {
                            return;
                        }
                        this.emit('data', data);
                        const text = new TextDecoder().decode(data);
                    });
                    this.port.on('error', (err) => {
                        this.sendDebug(`Error: ${err.message}`);
                        err.message = `Error: ${err.message}`;
                        this.emit('error', err);
                        reject(false);
                    });
                    this.port.on('close', (err) => {
                        if (err) {
                            this.emit('error', err);
                        }
                    });
                }
                catch (e) {
                    reject(false);
                }
            });
        });
    }
    disconnect() {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                try {
                    let serialPort = this.port;
                    if (!serialPort || serialPort.path !== this.portPath) {
                        serialPort = new serialport_1.SerialPort({
                            path: this.portPath,
                            baudRate: this.baudRate,
                            autoOpen: false,
                        });
                    }
                    serialPort.close((err) => {
                        if (this.port && this.port.path === this.portPath) {
                            this.port = null;
                        }
                        resolve();
                    });
                }
                catch (e) {
                    reject(e);
                }
            });
        });
    }
    getPort() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.port) {
                yield this.connect(this.baudRate);
            }
            return this.port;
        });
    }
    sendDebug(data) {
        return __awaiter(this, void 0, void 0, function* () {
            return;
        });
    }
    read(raw = false, size = 1) {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            const data = yield ((_a = this.port) === null || _a === void 0 ? void 0 : _a.read(size));
            if (!data) {
                return '';
            }
            if (raw) {
                return data;
            }
            const text = new TextDecoder().decode(data);
            return text;
        });
    }
    write(data) {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            const encoder = new TextEncoder();
            (_a = this.port) === null || _a === void 0 ? void 0 : _a.write(encoder.encode(data));
        });
    }
    setFlowingMode(mode) {
        var _a, _b;
        this.flowingMode = mode;
        if (this.flowingMode) {
            (_a = this.port) === null || _a === void 0 ? void 0 : _a.resume();
        }
        else {
            (_b = this.port) === null || _b === void 0 ? void 0 : _b.pause();
        }
    }
    getChecksum(data) {
        return __awaiter(this, void 0, void 0, function* () {
            return createHash('sha256').update(data).digest('hex');
        });
    }
}
exports.default = NodeSerialPort;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTm9kZVNlcmlhbFBvcnQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvTm9kZVNlcmlhbFBvcnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7QUFBQSwyQ0FBdUM7QUFDdkMsTUFBTSxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUUsR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUM7QUFHckQsbUNBQXNDO0FBQ3RDLE1BQU0sRUFBRSxVQUFVLEVBQUUsR0FBRyxPQUFPLENBQUMsYUFBYSxDQUFDLENBQUM7QUFFOUMsTUFBcUIsY0FBZSxTQUFRLHFCQUFZO0lBTXBELFlBQVksUUFBZ0I7UUFDeEIsS0FBSyxFQUFFLENBQUM7UUFOWixTQUFJLEdBQXNCLElBQUksQ0FBQztRQUMvQixhQUFRLEdBQUcsTUFBTSxDQUFDO1FBQ2xCLGFBQVEsR0FBVyxFQUFFLENBQUM7UUFDdEIsZ0JBQVcsR0FBRyxJQUFJLENBQUM7UUFJZixJQUFJLENBQUMsUUFBUSxHQUFHLFFBQVEsQ0FBQztRQUN6QixJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQy9DLENBQUM7SUFFSyxPQUFPLENBQUMsUUFBZ0I7O1lBQzFCLE9BQU8sSUFBSSxPQUFPLENBQVUsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7Z0JBQzVDLElBQUk7b0JBQ0EsSUFBSSxDQUFDLFFBQVEsR0FBRyxRQUFRLENBQUM7b0JBQ3pCLE1BQU0sVUFBVSxHQUFHLElBQUksdUJBQVUsQ0FBQzt3QkFDOUIsSUFBSSxFQUFFLElBQUksQ0FBQyxRQUFRO3dCQUNuQixRQUFRLEVBQUUsSUFBSSxDQUFDLFFBQVE7cUJBQzFCLENBQUMsQ0FBQztvQkFDSCxJQUFJLENBQUMsSUFBSSxHQUFFLFVBQVU7d0JBQ3JCLElBQUksQ0FBQyxXQUFXLEdBQUcsSUFBSSxDQUFDO29CQUN4QixJQUFJLENBQUMsSUFBSSxD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
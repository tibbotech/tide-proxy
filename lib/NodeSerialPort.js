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
    connect(baudRate, reset = false) {
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
                    this.port.on('open', () => {
                        if (reset) {
                            serialPort.write('\x03');
                            serialPort.write('\x04');
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
                        reject(false);
                    });
                    this.port.on('close', function () {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTm9kZVNlcmlhbFBvcnQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvTm9kZVNlcmlhbFBvcnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7QUFBQSwyQ0FBdUM7QUFDdkMsTUFBTSxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUUsR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUM7QUFHckQsbUNBQXNDO0FBQ3RDLE1BQU0sRUFBRSxVQUFVLEVBQUUsR0FBRyxPQUFPLENBQUMsYUFBYSxDQUFDLENBQUM7QUFFOUMsTUFBcUIsY0FBZSxTQUFRLHFCQUFZO0lBTXBELFlBQVksUUFBZ0I7UUFDeEIsS0FBSyxFQUFFLENBQUM7UUFOWixTQUFJLEdBQXNCLElBQUksQ0FBQztRQUMvQixhQUFRLEdBQUcsTUFBTSxDQUFDO1FBQ2xCLGFBQVEsR0FBVyxFQUFFLENBQUM7UUFDdEIsZ0JBQVcsR0FBRyxJQUFJLENBQUM7UUFJZixJQUFJLENBQUMsUUFBUSxHQUFHLFFBQVEsQ0FBQztRQUN6QixJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQy9DLENBQUM7SUFFSyxPQUFPLENBQUMsUUFBZ0IsRUFBRSxLQUFLLEdBQUcsS0FBSzs7WUFDekMsT0FBTyxJQUFJLE9BQU8sQ0FBVSxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtnQkFDNUMsSUFBSTtvQkFDQSxJQUFJLENBQUMsUUFBUSxHQUFHLFFBQVEsQ0FBQztvQkFDekIsTUFBTSxVQUFVLEdBQUcsSUFBSSx1QkFBVSxDQUFDO3dCQUM5QixJQUFJLEVBQUUsSUFBSSxDQUFDLFFBQVE7d0JBQ25CLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUTtxQkFDMUIsQ0FBQyxDQUFDO29CQUNILElBQUksQ0FBQyxJQUFJLEdBQUUsVUFBVTt3QkFDckIsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUM7b0JB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
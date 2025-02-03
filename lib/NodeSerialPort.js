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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const serialport_1 = require("serialport");
const { TextEncoder, TextDecoder } = require('util');
const events_1 = require("events");
const crypto_js_1 = __importDefault(require("crypto-js"));
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
                            this.emit('close', err);
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
            return crypto_js_1.default.SHA256(data).toString();
        });
    }
}
exports.default = NodeSerialPort;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTm9kZVNlcmlhbFBvcnQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvTm9kZVNlcmlhbFBvcnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7QUFBQSwyQ0FBdUM7QUFDdkMsTUFBTSxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUUsR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUM7QUFHckQsbUNBQXNDO0FBQ3RDLDBEQUFpQztBQUVqQyxNQUFxQixjQUFlLFNBQVEscUJBQVk7SUFNcEQsWUFBWSxRQUFnQjtRQUN4QixLQUFLLEVBQUUsQ0FBQztRQU5aLFNBQUksR0FBc0IsSUFBSSxDQUFDO1FBQy9CLGFBQVEsR0FBRyxNQUFNLENBQUM7UUFDbEIsYUFBUSxHQUFXLEVBQUUsQ0FBQztRQUN0QixnQkFBVyxHQUFHLElBQUksQ0FBQztRQUlmLElBQUksQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDO1FBQ3pCLElBQUksQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDL0MsQ0FBQztJQUVLLE9BQU8sQ0FBQyxRQUFnQjs7WUFDMUIsT0FBTyxJQUFJLE9BQU8sQ0FBVSxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtnQkFDNUMsSUFBSTtvQkFDQSxJQUFJLENBQUMsUUFBUSxHQUFHLFFBQVEsQ0FBQztvQkFDekIsTUFBTSxVQUFVLEdBQUcsSUFBSSx1QkFBVSxDQUFDO3dCQUM5QixJQUFJLEVBQUUsSUFBSSxDQUFDLFFBQVE7d0JBQ25CLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUTtxQkFDMUIsQ0FBQyxDQUFDO29CQUNILElBQUksQ0FBQyxJQUFJLEdBQUUsVUFBVTt3QkFDckIsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUM7b0JBQ3hCLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLE1BQU0sRUFBRSxDQUFDLEdBQUcsRUFBRSxF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
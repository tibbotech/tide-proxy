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
const crypto_js_1 = __importDefault(require("crypto-js"));
const events_1 = require("events");
let readerTimeout;
class BrowserSerialPort extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.baudRate = 115200;
        this.flowingMode = true;
    }
    maybeGetPort() {
        return __awaiter(this, void 0, void 0, function* () {
            const ports = yield navigator.serial.getPorts();
            if (ports.length === 1) {
                const port = ports[0];
                const portInfo = port.getInfo();
                return port;
            }
            return undefined;
        });
    }
    connect(baudRate = 115200) {
        return __awaiter(this, void 0, void 0, function* () {
            this.baudRate = baudRate;
            yield this.disconnect();
            const port = yield this.getPort();
            if (port === undefined) {
                return false;
            }
            if (this.flowingMode) {
                this.dataTimer = setInterval(this.readData.bind(this), 100);
            }
            yield port.open({ baudRate: this.baudRate });
            return true;
        });
    }
    disconnect() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const port = yield this.maybeGetPort();
                if (port === undefined) {
                    return;
                }
                if (this.dataTimer !== undefined) {
                    clearInterval(this.dataTimer);
                    this.dataTimer = undefined;
                }
                yield port.forget();
                yield port.close();
            }
            catch (e) {
            }
        });
    }
    getPort() {
        return __awaiter(this, void 0, void 0, function* () {
            this.port = (yield this.maybeGetPort()) || (yield this.forceReselectPort());
            if (this.port !== undefined) {
                this.port.addEventListener('disconnect', () => __awaiter(this, void 0, void 0, function* () {
                    this.port = undefined;
                }));
            }
            return this.port;
        });
    }
    read(raw = false) {
        return __awaiter(this, void 0, void 0, function* () {
            let reader = this.port.readable.getReader();
            readerTimeout = setTimeout(() => {
                readerTimeout = undefined;
                try {
                    reader.cancel();
                    reader.releaseLock();
                }
                catch (e) {
                }
            }, 1);
            const result = yield reader.read();
            clearTimeout(readerTimeout);
            readerTimeout = undefined;
            reader.releaseLock();
            reader = undefined;
            if (raw) {
                return result.value;
            }
            return new TextDecoder().decode(result.value);
        });
    }
    write(data) {
        const encoder = new TextEncoder();
        const writer = this.port.writable.getWriter();
        writer.write(encoder.encode(data));
        writer.releaseLock();
    }
    forceReselectPort() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.disconnect();
            if (navigator.serial) {
                const chosen = yield navigator.serial.requestPort({ filters: [] });
                return chosen;
            }
            return undefined;
        });
    }
    getChecksum(buf) {
        return __awaiter(this, void 0, void 0, function* () {
            const blob = new Blob([buf], {
                type: 'application/octet-stream',
            });
            const reader = new FileReader();
            reader.readAsArrayBuffer(blob);
            const data = yield new Promise((resolve) => {
                reader.onload = () => {
                    resolve(reader.result);
                };
            });
            const wordArray = crypto_js_1.default.lib.WordArray.create(data);
            const fileChecksum = crypto_js_1.default.SHA256(wordArray).toString();
            return fileChecksum;
        });
    }
    setFlowingMode(mode) {
        this.flowingMode = mode;
        if (this.flowingMode) {
            if (this.dataTimer === undefined) {
                this.dataTimer = setInterval(this.readData.bind(this), 100);
            }
        }
        else {
            if (this.dataTimer !== undefined) {
                clearInterval(this.dataTimer);
                this.dataTimer = undefined;
            }
        }
    }
    readData() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.port.readable || this.port.readable.locked) {
                return;
            }
            const data = yield this.read(true);
            if (data) {
                this.emit('data', data);
            }
        });
    }
}
exports.default = BrowserSerialPort;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQnJvd3NlclNlcmlhbFBvcnQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvQnJvd3NlclNlcmlhbFBvcnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7QUFDQSwwREFBaUM7QUFDakMsbUNBQXNDO0FBRXRDLElBQUksYUFBa0IsQ0FBQztBQUd2QixNQUFxQixpQkFBa0IsU0FBUSxxQkFBWTtJQUEzRDs7UUFHSSxhQUFRLEdBQUcsTUFBTSxDQUFDO1FBQ2xCLGdCQUFXLEdBQUcsSUFBSSxDQUFDO0lBcUl2QixDQUFDO0lBbElTLFlBQVk7O1lBQ2QsTUFBTSxLQUFLLEdBQUcsTUFBTSxTQUFTLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ2hELElBQUksS0FBSyxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUU7Z0JBQ3BCLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDdEIsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO2dCQUNoQyxPQUFPLElBQUksQ0FBQzthQUNmO1lBQ0QsT0FBTyxTQUFTLENBQUM7UUFDckIsQ0FBQztLQUFBO0lBRUssT0FBTyxDQUFDLFdBQW1CLE1BQU07O1lBQ25DLElBQUksQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDO1lBQ3pCLE1BQU0sSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ3hCLE1BQU0sSUFBSSxHQUFHLE1BQU0sSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1lBQ2xDLElBQUksSUFBSSxLQUFLLFNBQVMsRUFBRTtnQkFDcEIsT0FBTyxLQUFLLENBQUM7YUFDaEI7WUFDRCxJQUFJLElBQUksQ0FBQyxXQUFXLEVBQUU7Z0JBQ2xCLElBQUksQ0FBQyxTQUFTLEdBQUcsV0FBVyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO2FBQy9EO1lB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
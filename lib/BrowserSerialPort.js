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
    connect(baudRate = 115200, reset = true) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                this.baudRate = baudRate;
                if (reset) {
                    yield this.disconnect();
                }
                const port = yield this.getPort();
                if (port === undefined) {
                    return false;
                }
                if (this.flowingMode) {
                    this.dataTimer = setInterval(this.readData.bind(this), 100);
                }
                yield port.open({ baudRate: this.baudRate });
                return true;
            }
            catch (err) {
                this.emit('error', err);
                return false;
            }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQnJvd3NlclNlcmlhbFBvcnQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvQnJvd3NlclNlcmlhbFBvcnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7QUFDQSwwREFBaUM7QUFDakMsbUNBQXNDO0FBRXRDLElBQUksYUFBa0IsQ0FBQztBQUd2QixNQUFxQixpQkFBa0IsU0FBUSxxQkFBWTtJQUEzRDs7UUFHSSxhQUFRLEdBQUcsTUFBTSxDQUFDO1FBQ2xCLGdCQUFXLEdBQUcsSUFBSSxDQUFDO0lBNEl2QixDQUFDO0lBeklTLFlBQVk7O1lBQ2QsTUFBTSxLQUFLLEdBQUcsTUFBTSxTQUFTLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ2hELElBQUksS0FBSyxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUU7Z0JBQ3BCLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDdEIsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO2dCQUNoQyxPQUFPLElBQUksQ0FBQzthQUNmO1lBQ0QsT0FBTyxTQUFTLENBQUM7UUFDckIsQ0FBQztLQUFBO0lBRUssT0FBTyxDQUFDLFdBQW1CLE1BQU0sRUFBRSxLQUFLLEdBQUcsSUFBSTs7WUFDakQsSUFBSTtnQkFDQSxJQUFJLENBQUMsUUFBUSxHQUFHLFFBQVEsQ0FBQztnQkFDekIsSUFBSSxLQUFLLEVBQUU7b0JBQ1AsTUFBTSxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7aUJBQzNCO2dCQUNELE1BQU0sSUFBSSxHQUFHLE1BQU0sSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO2dCQUNsQyxJQUFJLElBQUksS0FBSyxTQUFTLEVBQUU7b0JBQ3BCLE9BQU8sS0FBSyxDQUFDO2lCQUNoQjtnQkFDRCxJQUFJLElBQUksQ0FBQyxXQUFXLEVBQUU7b0JBQ2xCLElBQUksQ0FBQyxTQUFTLEdBQUcsV0FBVyxDQUFDLElBQUks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
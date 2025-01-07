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
var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i;
    function verb(n) { if (g[n]) i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeTransport = void 0;
const index_js_1 = require("esptool-js/lib/index.js");
class NodeTransport extends index_js_1.Transport {
    constructor(device, tracing = false, enableSlipReader = true) {
        super(device, tracing, enableSlipReader);
        this.device = device;
        this.tracing = tracing;
        this.setupDataListener();
    }
    getInfo() {
        return `SerialPort path: ${this.device.path}`;
    }
    getPid() {
        return undefined;
    }
    write(data) {
        return __awaiter(this, void 0, void 0, function* () {
            const outData = this.slipWriter(data);
            if (this.tracing) {
                console.log("Write bytes");
                this.trace(`Write ${outData.length} bytes: ${this.hexConvert(outData)}`);
            }
            return new Promise((resolve, reject) => {
                this.device.write(outData, (err) => {
                    if (err) {
                        return reject(err);
                    }
                    this.device.drain((drainErr) => {
                        if (drainErr) {
                            return reject(drainErr);
                        }
                        resolve();
                    });
                });
            });
        });
    }
    inWaiting() {
        return this.buffer.length;
    }
    read(timeout) {
        return __asyncGenerator(this, arguments, function* read_1() {
            let partialPacket = null;
            let isEscaping = false;
            let successfulSlip = false;
            while (true) {
                const waitingBytes = this.inWaiting();
                const readBytes = yield __await(this.newRead(waitingBytes > 0 ? waitingBytes : 1, timeout));
                if (!readBytes || readBytes.length === 0) {
                    const msg = partialPacket === null
                        ? successfulSlip
                            ? "Serial data stream stopped: Possible serial noise or corruption."
                            : "No serial data received."
                        : `Packet content transfer stopped`;
                    this.trace(msg);
                    throw new Error(msg);
                }
                this.trace(`Read ${readBytes.length} bytes: ${this.hexConvert(readBytes)}`);
                let i = 0;
                while (i < readBytes.length) {
                    const byte = readBytes[i++];
                    if (partialPacket === null) {
                        if (byte === this.SLIP_END) {
                            partialPacket = new Uint8Array(0);
                        }
                        else {
                            this.trace(`Read invalid data: ${this.hexConvert(readBytes)}`);
                            const remainingData = yield __await(this.newRead(this.inWaiting(), timeout));
                            this.trace(`Remaining data in serial buffer: ${this.hexConvert(remainingData)}`);
                            this.detectPanicHandler(new Uint8Array([...readBytes, ...(remainingData || [])]));
                            throw new Error(`Invalid head of packet (0x${byte.toString(16)}): Possible serial noise or corruption.`);
                        }
                    }
                    else if (isEscaping) {
                        isEscaping = false;
                        if (byte === this.SLIP_ESC_END) {
                            partialPacket = this.appendArray(partialPacket, new Uint8Array([this.SLIP_END]));
                        }
                        else if (byte === this.SLIP_ESC_ESC) {
                            partialPacket = this.appendArray(partialPacket, new Uint8Array([this.SLIP_ESC]));
                        }
                        else {
                            this.trace(`Read invalid data: ${this.hexConvert(readBytes)}`);
                            const remainingData = yield __await(this.newRead(this.inWaiting(), timeout));
                            this.trace(`Remaining data in serial buffer: ${this.hexConvert(remainingData)}`);
                            this.detectPanicHandler(new Uint8Array([...readBytes, ...(remainingData || [])]));
                            throw new Error(`Invalid SLIP escape (0xdb, 0x${byte.toString(16)})`);
                        }
                    }
                    else if (byte === this.SLIP_ESC) {
                        isEscaping = true;
                    }
                    else if (byte === this.SLIP_END) {
                        this.trace(`Received full packet: ${this.hexConvert(partialPacket)}`);
                        this.buffer = this.appendArray(this.buffer, readBytes.slice(i));
                        yield yield __await(partialPacket);
                        partialPacket = null;
                        successfulSlip = true;
                    }
                    else {
                        partialPacket = this.appendArray(partialPacket, new Uint8Array([byte]));
                    }
                }
            }
        });
    }
    rawRead() {
        return __asyncGenerator(this, arguments, function* rawRead_1() {
            try {
                while (true) {
                    const readBytes = yield __await(this.newRead(1, 1000));
                    if (readBytes.length === 0)
                        break;
                    if (this.tracing) {
                        console.log("Raw Read bytes");
                        this.trace(`Read ${readBytes.length} bytes: ${this.hexConvert(readBytes)}`);
                    }
                    yield yield __await(readBytes);
                }
            }
            catch (error) {
                console.error("Error reading from serial port:", error);
            }
            finally {
                this.buffer = new Uint8Array(0);
            }
        });
    }
    setupDataListener() {
        this.device.on("data", (data) => {
            const newData = new Uint8Array(data);
            this.buffer = this.appendArray(this.buffer, newData);
            if (this.tracing) {
                this.trace(`Received ${newData.length} bytes: ${this.hexConvert(newData)}`);
            }
        });
    }
    newRead(numBytes, timeout) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = Date.now();
            while (this.buffer.length < numBytes) {
                if (Date.now() - startTime > timeout) {
                    throw new Error("Read timeout exceeded");
                }
                yield this.sleep(10);
            }
            const output = this.buffer.slice(0, numBytes);
            this.buffer = this.buffer.slice(numBytes);
            return output;
        });
    }
    flushInput() {
        return __awaiter(this, void 0, void 0, function* () {
            this.buffer = new Uint8Array(0);
        });
    }
    flushOutput() {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                this.device.flush((err) => {
                    if (err)
                        return reject(err);
                    resolve();
                });
            });
        });
    }
    setRTS(state) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                this.device.set({ rts: state }, (err) => {
                    if (err)
                        return reject(err);
                    this.setDTR(this._DTR_state).then(resolve, reject);
                });
            });
        });
    }
    setDTR(state) {
        return __awaiter(this, void 0, void 0, function* () {
            this._DTR_state = state;
            return new Promise((resolve, reject) => {
                this.device.set({ dtr: state }, (err) => {
                    if (err)
                        return reject(err);
                    resolve();
                });
            });
        });
    }
    connect(baud = 115200, serialOptions = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.device.isOpen) {
                return new Promise((resolve, reject) => {
                    this.device.open((err) => {
                        if (err)
                            return reject(err);
                        this.baudrate = baud;
                        resolve();
                    });
                });
            }
            else {
                this.baudrate = baud;
            }
        });
    }
    sleep(ms) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve) => setTimeout(resolve, ms));
        });
    }
    waitForUnlock(timeout) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.sleep(timeout);
        });
    }
    disconnect() {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                if (!this.device.isOpen)
                    return resolve();
                this.device.close((err) => {
                    if (err)
                        return reject(err);
                    resolve();
                });
            });
        });
    }
}
exports.NodeTransport = NodeTransport;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTm9kZVRyYW5zcG9ydC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9Ob2RlVHJhbnNwb3J0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLHNEQUFtRDtBQWFqRCxNQUFNLGFBQWMsU0FBUSxvQkFBUztJQUNuQyxZQUFtQixNQUFXLEVBQVMsVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLEdBQUcsSUFBSTtRQUMzRSxLQUFLLENBQUMsTUFBYSxFQUFFLE9BQU8sRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO1FBRGpDLFdBQU0sR0FBTixNQUFNLENBQUs7UUFBUyxZQUFPLEdBQVAsT0FBTyxDQUFRO1FBRWxELElBQUksQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO0lBQzdCLENBQUM7SUFNRCxPQUFPO1FBQ0wsT0FBTyxvQkFBb0IsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUNoRCxDQUFDO0lBRUQsTUFBTTtRQUVKLE9BQU8sU0FBUyxDQUFDO0lBQ25CLENBQUM7SUFFSyxLQUFLLENBQUMsSUFBZ0I7O1lBQzFCLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUM7WUFFdEMsSUFBSSxJQUFJLENBQUMsT0FBTyxFQUFFO2dCQUNoQixPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxDQUFDO2dCQUMzQixJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsT0FBTyxDQUFDLE1BQU0sV0FBVyxJQUFJLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsQ0FBQzthQUMxRTtZQUVELE9BQU8sSUFBSSxPQUFPLENBQU8sQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7Z0JBQzNDLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLE9BQU8sRUFBRSxDQUFDLEdBQVEsRUFBRSxFQUFFO29CQUN0QyxJQUFJLEdBQUcsRUFBRTt3QkFDUCxPQUFPLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztxQkFDcEI7b0JBQ0QsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxRQUFhLEVBQUUsRUFBRTt3QkFDbEMsSUFBSSxRQUFRLEVBQUU7NEJBQ1osT0FBTyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7eUJBQ3pCO3dCQUNELE9BQU8sRUFBRSxDQUFDO29CQUNaLENBQUMsQ0FBQyxDQUFDO2dCQUNMLENBQUMsQ0FBQyxDQUFDO1lBQ0wsQ0FBQyxDQUFDLENBQUM7UUFDTCxDQUFDO0tBQUE7SUFFRCxTQUFTO1FBQ1AsT0FBUSxJQUFZLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNyQyxDQUFDO0lBUUksSUFBSSxDQUFDLE9BQWU7O1lBQ3pCLElBQUksYUFBYSxHQUFzQixJQUFJLENBQUM7WUFDNUMsSUFBSSxVQUFVLEdBQUcsS0FBSyxDQUFDO1lBQ3ZCLElBQUksY0FBYyxHQUFHLEtBQUssQ0FBQztZQUUzQixPQUFPLElBQUksRUFBRTtnQkFDWCxNQUFNLFlBQVksR0FBRyxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7Z0JBQ3RDLE1BQU0sU0FBUyxHQUFHLGNBQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxZQUFZLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxPQUFPLENBQUMsQ0FBQSxDQUFDO2dCQUVuRixJQUFJLENBQUMsU0FBUyxJQUFJLFNBQVMsQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFO29CQUN4QyxNQUFNLEdBQUcsR0FDUCxhQUFhLEtBQUssSUFBSTt3QkFDcEIsQ0FBQyxDQUFDLGNBQWM7NEJBQ2QsQ0FBQyxDQUFDLGtFQUFrRTs0QkFDcEUsQ0FBQyxDQUFDLDBCQUEwQjt3QkFDOUIsQ0FBQyxDQUFDLGlDQUFpQyxDQUFDO29CQUN4QyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO29CQUNoQixNQUFNLElBQUksS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2lCQUN0QjtnQkFFRCxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsU0FBUyxDQUFDLE1BQU0sV0FBVyxJQUFJLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQztnQkFFNUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNWLE9BQU8sQ0FBQyxHQUFHLFNBQVMsQ0FBQyxNQUFNLEVBQUU7b0JBQzNCLE1BQU0sSUFBSSxHQUFHLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDO29CQUM1QixJQUFJLGFBQWEsS0FBSyxJQUFJLEVBQUU7d0JBQzFCLElBQUksSUFBSSxLQUFNLElBQVksQ0FBQyxRQUFRLEVBQUU7NEJBQ25DLGFBQWEsR0FBRyxJQUFJLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQzt5QkFDbkM7NkJBQU07NEJBQ0wsSUFBSSxDQUFDLEtBQUssQ0FBQyxzQkFBc0IsSUFBSSxDQUFDLFVBQVUsQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDLENBQUM7NEJBQy9ELE1BQU0sYUFBYSxHQUFHLGNBQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLEVBQUUsT0FBTyxDQUFDLENBQUEsQ0FBQzs0QkFDcEUsSUFBSSxDQUFDLEtBQUssQ0FBQyxvQ0FBb0MsSUFBSSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsRUFBRSxDQUFDLENBQUM7NEJBQ2hGLElBQVksQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLFVBQVUsQ0FBQyxDQUFDLEdBQUcsU0FBUyxFQUFFLEdBQUcsQ0FBQyxhQUFhLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7NEJBQzNGLE1BQU0sSUFBSSxLQUFLLENBQUMsNkJBQTZCLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLHlDQUF5QyxDQUFDLENBQUM7eUJBQzFHO3FCQUNGO3lCQUFNLElBQUksVUFBVSxFQUFFO3dCQUNyQixVQUFVLEdBQUcsS0FBSyxDQUFDO3dCQUNuQixJQUFJLElBQUksS0FBTSxJQUFZLENBQUMsWUFBWSxFQUFFOzRCQUN2QyxhQUFhLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxhQUFhLEVBQUUsSUFBSSxVQUFVLENBQUMsQ0FBRSxJQUFZLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO3lCQUMzRjs2QkFBTSxJQUFJLElBQUksS0FBTSxJQUFZLENBQUMsWUFBWSxFQUFFOzRCQUM5QyxhQUFhLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxhQUFhLEVBQUUsSUFBSSxVQUFVLENBQUMsQ0FBRSxJQUFZLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO3lCQUMzRjs2QkFBTTs0QkFDTCxJQUFJLENBQUMsS0FBSyxDQUFDLHNCQUFzQixJQUFJLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQzs0QkFDL0QsTUFBTSxhQUFhLEdBQUcsY0FBTSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsRUFBRSxPQUFPLENBQUMsQ0FBQSxDQUFDOzRCQUNwRSxJQUFJLENBQUMsS0FBSyxDQUFDLG9DQUFvQyxJQUFJLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxFQUFFLENBQUMsQ0FBQzs0QkFDaEYsSUFBWSxDQUFDLGtCQUFrQixDQUFDLElBQUksVUFBVSxDQUFDLENBQUMsR0FBRyxTQUFTLEVBQUUsR0FBRyxDQUFDLGFBQWEsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQzs0QkFDM0YsTUFBTSxJQUFJLEtBQUssQ0FBQyxnQ0FBZ0MsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUM7eUJBQ3ZFO3FCQUNGO3lCQUFNLElBQUksSUFBSSxLQUFNLElBQVksQ0FBQyxRQUFRLEVBQUU7d0JBQzFDLFVBQVUsR0FBRyxJQUFJLENBQUM7cUJBQ25CO3lCQUFNLElBQUksSUFBSSxLQUFNLElBQVksQ0FBQyxRQUFRLEVBQUU7d0JBQzFDLElBQUksQ0FBQyxLQUFLLENBQUMseUJBQXlCLElBQUksQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLEVBQUUsQ0FBQyxDQUFDO3dCQUNyRSxJQUFZLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUUsSUFBWSxDQUFDLE1BQU0sRUFBRSxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7d0JBQ2xGLG9CQUFNLGFBQWEsQ0FBQSxDQUFDO3dCQUNwQixhQUFhLEdBQUcsSUFBSSxDQUFDO3dCQUNyQixjQUFjLEdBQUcsSUFBSSxDQUFDO3FCQUN2Qjt5QkFBTTt3QkFDTCxhQUFhLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxhQUFhLEVBQUUsSUFBSSxVQUFVLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7cUJBQ3pFO2lCQUNGO2FBQ0Y7UUFDSCxDQUFDO0tBQUE7SUFNTSxPQUFPOztZQUNaLElBQUk7Z0JBQ0YsT0FBTyxJQUFJLEVBQUU7b0JBQ1gsTUFBTSxTQUFTLEdBQUcsY0FBTSxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQSxDQUFDO29CQUM5QyxJQUFJLFNBQVMsQ0FBQyxNQUFNLEtBQUssQ0FBQzt3QkFBRSxNQUFNO29CQUNsQyxJQUFJLElBQUksQ0FBQyxPQUFPLEVBQUU7d0JBQ2hCLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUMsQ0FBQzt3QkFDOUIsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLFNBQVMsQ0FBQyxNQUFNLFdBQVcsSUFBSSxDQUFDLFVBQVUsQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDLENBQUM7cUJBQzdFO29CQUNELG9CQUFNLFNBQVMsQ0FBQSxDQUFDO2lCQUNqQjthQUNGO1lBQUMsT0FBTyxLQUFLLEVBQUU7Z0JBQ2QsT0FBTyxDQUFDLEtBQUssQ0FBQyxpQ0FBaUMsRUFBRSxLQUFLLENBQUMsQ0FBQzthQUN6RDtvQkFBUztnQkFDTCxJQUFZLENBQUMsTUFBTSxHQUFHLElBQUksVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDO2FBQzVDO1FBQ0gsQ0FBQztLQUFBO0lBRVMsaUJBQWlCO1FBQ3ZCLElBQUksQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLE1BQU0sRUFBRSxDQUFDLElBQVksRUFBRSxFQUFFO1lBQ3RDLE1BQU0sT0FBTyxHQUFHLElBQUksVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3BDLElBQVksQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBRSxJQUFZLENBQUMsTUFBTSxFQUFFLE9BQU8sQ0FBQyxDQUFDO1lBQ3ZFLElBQUksSUFBSSxDQUFDLE9BQU8sRUFBRTtnQkFDaEIsSUFBSSxDQUFDLEtBQUssQ0FBQyxZQUFZLE9BQU8sQ0FBQyxNQUFNLFdBQVcsSUFBSSxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLENBQUM7YUFDN0U7UUFDSCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFSyxPQUFPLENBQUMsUUFBZ0IsRUFBRSxPQUFlOztZQUM3QyxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDN0IsT0FBUSxJQUFZLENBQUMsTUFBTSxDQUFDLE1BQU0sR0FBRyxRQUFRLEVBQUU7Z0JBQzdDLElBQUksSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLFNBQVMsR0FBRyxPQUFPLEVBQUU7b0JBQ3BDLE1BQU0sSUFBSSxLQUFLLENBQUMsdUJBQXVCLENBQUMsQ0FBQztpQkFDMUM7Z0JBQ0QsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDO2FBQ3RCO1lBRUQsTUFBTSxNQUFNLEdBQUksSUFBWSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBQ3RELElBQVksQ0FBQyxNQUFNLEdBQUksSUFBWSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUM7WUFDNUQsT0FBTyxNQUFNLENBQUM7UUFDaEIsQ0FBQztLQUFBO0lBRUssVUFBVTs7WUFFYixJQUFZLENBQUMsTUFBTSxHQUFHLElBQUksVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzNDLENBQUM7S0FBQTtJQUVLLFdBQVc7O1lBQ2YsT0FBTyxJQUFJLE9BQU8sQ0FBTyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtnQkFDM0MsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxHQUFRLEVBQUUsRUFBRTtvQkFDN0IsSUFBSSxHQUFHO3dCQUFFLE9BQU8sTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO29CQUM1QixPQUFPLEVBQUUsQ0FBQztnQkFDWixDQUFDLENBQUMsQ0FBQztZQUNMLENBQUMsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztLQUFBO0lBRUssTUFBTSxDQUFDLEtBQWM7O1lBQ3pCLE9BQU8sSUFBSSxPQUFPLENBQU8sQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7Z0JBQzNDLElBQUksQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLEVBQUUsR0FBRyxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUMsR0FBUSxFQUFFLEVBQUU7b0JBQzNDLElBQUksR0FBRzt3QkFBRSxPQUFPLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztvQkFFNUIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsQ0FBQztnQkFDckQsQ0FBQyxDQUFDLENBQUM7WUFDTCxDQUFDLENBQUMsQ0FBQztRQUNMLENBQUM7S0FBQTtJQUVLLE1BQU0sQ0FBQyxLQUFjOztZQUN6QixJQUFJLENBQUMsVUFBVSxHQUFHLEtBQUssQ0FBQztZQUN4QixPQUFPLElBQUksT0FBTyxDQUFPLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO2dCQUMzQyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDLEdBQVEsRUFBRSxFQUFFO29CQUMzQyxJQUFJLEdBQUc7d0JBQUUsT0FBTyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7b0JBQzVCLE9BQU8sRUFBRSxDQUFDO2dCQUNaLENBQUMsQ0FBQyxDQUFDO1lBQ0wsQ0FBQyxDQUFDLENBQUM7UUFDTCxDQUFDO0tBQUE7SUFFSyxPQUFPLENBQUMsSUFBSSxHQUFHLE1BQU0sRUFBRSxnQkFBK0IsRUFBRTs7WUFHNUQsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFO2dCQUN2QixPQUFPLElBQUksT0FBTyxDQUFPLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO29CQUMzQyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQVEsRUFBRSxFQUFFO3dCQUM1QixJQUFJLEdBQUc7NEJBQUUsT0FBTyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7d0JBQzVCLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDO3dCQUNyQixPQUFPLEVBQUUsQ0FBQztvQkFDWixDQUFDLENBQUMsQ0FBQztnQkFDTCxDQUFDLENBQUMsQ0FBQzthQUNKO2lCQUFNO2dCQUdMLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDO2FBQ3RCO1FBQ0gsQ0FBQztLQUFBO0lBRUssS0FBSyxDQUFDLEVBQVU7O1lBQ3BCLE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLFVBQVUsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUMzRCxDQUFDO0tBQUE7SUFFSyxhQUFhLENBQUMsT0FBZTs7WUFFakMsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQzVCLENBQUM7S0FBQTtJQUVLLFVBQVU7O1lBQ2QsT0FBTyxJQUFJLE9BQU8sQ0FBTyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtnQkFDM0MsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTTtvQkFBRSxPQUFPLE9BQU8sRUFBRSxDQUFDO2dCQUMxQyxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQVEsRUFBRSxFQUFFO29CQUM3QixJQUFJLEdBQUc7d0JBQUUsT0FBTyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7b0JBQzVCLE9BQU8sRUFBRSxDQUFDO2dCQUNaLENBQUMsQ0FBQyxDQUFDO1lBQ0wsQ0FBQyxDQUFDLENBQUM7UUFDTCxDQUFDO0tBQUE7Q0FDRjtBQUVRLHNDQUFhIn0=
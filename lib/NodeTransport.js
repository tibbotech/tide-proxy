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
                    return new Uint8Array(0);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTm9kZVRyYW5zcG9ydC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9Ob2RlVHJhbnNwb3J0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLHNEQUFtRDtBQWFuRCxNQUFNLGFBQWMsU0FBUSxvQkFBUztJQUNqQyxZQUFtQixNQUFXLEVBQVMsVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLEdBQUcsSUFBSTtRQUMzRSxLQUFLLENBQUMsTUFBYSxFQUFFLE9BQU8sRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO1FBRGpDLFdBQU0sR0FBTixNQUFNLENBQUs7UUFBUyxZQUFPLEdBQVAsT0FBTyxDQUFRO1FBRWxELElBQUksQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO0lBQzdCLENBQUM7SUFNRCxPQUFPO1FBQ0gsT0FBTyxvQkFBb0IsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUNsRCxDQUFDO0lBRUQsTUFBTTtRQUVGLE9BQU8sU0FBUyxDQUFDO0lBQ3JCLENBQUM7SUFFSyxLQUFLLENBQUMsSUFBZ0I7O1lBQ3hCLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUM7WUFFdEMsSUFBSSxJQUFJLENBQUMsT0FBTyxFQUFFO2dCQUNkLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLENBQUM7Z0JBQzNCLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxPQUFPLENBQUMsTUFBTSxXQUFXLElBQUksQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxDQUFDO2FBQzVFO1lBRUQsT0FBTyxJQUFJLE9BQU8sQ0FBTyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtnQkFDekMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsT0FBTyxFQUFFLENBQUMsR0FBUSxFQUFFLEVBQUU7b0JBQ3BDLElBQUksR0FBRyxFQUFFO3dCQUNMLE9B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
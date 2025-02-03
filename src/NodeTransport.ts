import { Transport } from 'esptool-js/lib/index.js'

/* global SerialPort, ParityType, FlowControlType */

export interface SerialOptions {
    baudRate?: number | undefined;
    dataBits?: number | undefined;
    stopBits?: number | undefined;
    parity?: any | undefined;
    bufferSize?: number | undefined;
    flowControl?: any | undefined;
}

class NodeTransport extends Transport {
    constructor(public device: any, public tracing = false, enableSlipReader = true) {
        super(device as any, tracing, enableSlipReader);
        this.setupDataListener();
    }

    /**
     * Since node-serialport does not provide USB Vendor/Product IDs, we return
     * some basic info (like path).
     */
    getInfo(): string {
        return `SerialPort path: ${this.device.path}`;
    }

    getPid(): number | undefined {
        // Not available in node-serialport
        return undefined;
    }

    async write(data: Uint8Array) {
        const outData = this.slipWriter(data);

        if (this.tracing) {
            console.log("Write bytes");
            this.trace(`Write ${outData.length} bytes: ${this.hexConvert(outData)}`);
        }

        return new Promise<void>((resolve, reject) => {
            this.device.write(outData, (err: any) => {
                if (err) {
                    return reject(err);
                }
                this.device.drain((drainErr: any) => {
                    if (drainErr) {
                        return reject(drainErr);
                    }
                    resolve();
                });
            });
        });
    }

    inWaiting(): number {
        return (this as any).buffer.length;
    }

    /**
   * Take a data array and return the first well formed packet after
   * replacing the escape sequence. Reads at least 8 bytes.
   * @param {number} timeout Timeout read data.
   * @yields {Uint8Array} Formatted packet using SLIP escape sequences.
   */
    async *read(timeout: number): AsyncGenerator<Uint8Array> {
        let partialPacket: Uint8Array | null = null;
        let isEscaping = false;
        let successfulSlip = false;

        while (true) {
            const waitingBytes = this.inWaiting();
            const readBytes = await this.newRead(waitingBytes > 0 ? waitingBytes : 1, timeout);

            if (!readBytes || readBytes.length === 0) {
                const msg =
                    partialPacket === null
                        ? successfulSlip
                            ? "Serial data stream stopped: Possible serial noise or corruption."
                            : "No serial data received."
                        : `Packet content transfer stopped`;
                this.trace(msg);
                throw new Error(msg);
            }

            this.trace(`Read ${readBytes.length} bytes: ${this.hexConvert(readBytes)}`);

            let i = 0; // Track position in readBytes
            while (i < readBytes.length) {
                const byte = readBytes[i++];
                if (partialPacket === null) {
                    if (byte === (this as any).SLIP_END) {
                        partialPacket = new Uint8Array(0); // Start of a new packet
                    } else {
                        this.trace(`Read invalid data: ${this.hexConvert(readBytes)}`);
                        const remainingData = await this.newRead(this.inWaiting(), timeout);
                        this.trace(`Remaining data in serial buffer: ${this.hexConvert(remainingData)}`);
                        (this as any).detectPanicHandler(new Uint8Array([...readBytes, ...(remainingData || [])]));
                        throw new Error(`Invalid head of packet (0x${byte.toString(16)}): Possible serial noise or corruption.`);
                    }
                } else if (isEscaping) {
                    isEscaping = false;
                    if (byte === (this as any).SLIP_ESC_END) {
                        partialPacket = this.appendArray(partialPacket, new Uint8Array([(this as any).SLIP_END]));
                    } else if (byte === (this as any).SLIP_ESC_ESC) {
                        partialPacket = this.appendArray(partialPacket, new Uint8Array([(this as any).SLIP_ESC]));
                    } else {
                        this.trace(`Read invalid data: ${this.hexConvert(readBytes)}`);
                        const remainingData = await this.newRead(this.inWaiting(), timeout);
                        this.trace(`Remaining data in serial buffer: ${this.hexConvert(remainingData)}`);
                        (this as any).detectPanicHandler(new Uint8Array([...readBytes, ...(remainingData || [])]));
                        throw new Error(`Invalid SLIP escape (0xdb, 0x${byte.toString(16)})`);
                    }
                } else if (byte === (this as any).SLIP_ESC) {
                    isEscaping = true;
                } else if (byte === (this as any).SLIP_END) {
                    this.trace(`Received full packet: ${this.hexConvert(partialPacket)}`);
                    (this as any).buffer = this.appendArray((this as any).buffer, readBytes.slice(i));
                    yield partialPacket;
                    partialPacket = null;
                    successfulSlip = true;
                } else {
                    partialPacket = this.appendArray(partialPacket, new Uint8Array([byte]));
                }
            }
        }
    }

    /**
     * Read from serial device without slip formatting.
     * @yields {Uint8Array} The next number in the Fibonacci sequence.
     */
    async *rawRead(): AsyncGenerator<Uint8Array> {
        try {
            while (true) {
                const readBytes = await this.newRead(1, 1000);
                if (readBytes.length === 0) break;
                if (this.tracing) {
                    console.log("Raw Read bytes");
                    this.trace(`Read ${readBytes.length} bytes: ${this.hexConvert(readBytes)}`);
                }
                yield readBytes; // Yield each data chunk
            }
        } catch (error) {
            console.error("Error reading from serial port:", error);
        } finally {
            (this as any).buffer = new Uint8Array(0);
        }
    }

    private setupDataListener() {
        this.device.on("data", (data: Buffer) => {
            const newData = new Uint8Array(data);
            (this as any).buffer = this.appendArray((this as any).buffer, newData);
            if (this.tracing) {
                this.trace(`Received ${newData.length} bytes: ${this.hexConvert(newData)}`);
            }
        });
    }

    async newRead(numBytes: number, timeout: number): Promise<Uint8Array> {
        const startTime = Date.now();
        while ((this as any).buffer.length < numBytes) {
            if (Date.now() - startTime > timeout) {
                // throw new Error("Read timeout exceeded");
                return new Uint8Array(0);
            }
            await this.sleep(10);
        }

        const output = (this as any).buffer.slice(0, numBytes);
        (this as any).buffer = (this as any).buffer.slice(numBytes);
        return output;
    }

    async flushInput() {
        // Clear local buffer
        (this as any).buffer = new Uint8Array(0);
    }

    async flushOutput() {
        return new Promise<void>((resolve, reject) => {
            this.device.flush((err: any) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    async setRTS(state: boolean) {
        return new Promise<void>((resolve, reject) => {
            this.device.set({ rts: state }, (err: any) => {
                if (err) return reject(err);
                // Work-around: also re-toggle DTR to ensure line-state updates
                this.setDTR(this._DTR_state).then(resolve, reject);
            });
        });
    }

    async setDTR(state: boolean) {
        this._DTR_state = state;
        return new Promise<void>((resolve, reject) => {
            this.device.set({ dtr: state }, (err: any) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    async connect(baud = 115200, serialOptions: SerialOptions = {}) {
        // If port is not open, we can change options by reopening
        // Node serialport opens on constructor, if it's already open we can just update.
        if (!this.device.isOpen) {
            return new Promise<void>((resolve, reject) => {
                this.device.open((err: any) => {
                    if (err) return reject(err);
                    this.baudrate = baud;
                    resolve();
                });
            });
        } else {
            // If needed, we can change baud rate by re-opening the port (not supported by all drivers)
            // For simplicity, do nothing if already open.
            this.baudrate = baud;
        }
    }

    async sleep(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async waitForUnlock(timeout: number) {
        // Not needed in node-serialport, but we can just wait
        await this.sleep(timeout);
    }

    async disconnect() {
        return new Promise<void>((resolve, reject) => {
            if (!this.device.isOpen) return resolve();
            this.device.close((err: any) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }
}

export { NodeTransport };

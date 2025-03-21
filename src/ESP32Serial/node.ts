/* eslint-disable no-await-in-loop */
import ESP32Serial from './base';
import {
    ESPLoader,
    FlashOptions,
    LoaderOptions,
} from 'esptool-js/lib/index.js';
import { ClassicReset, UsbJtagSerialReset } from 'esptool-js/lib/reset';
import { NodeTransport as Transport } from '../NodeTransport'

import crypto from 'crypto';


export class UnixTightReset {
    resetDelay: number;
    transport: any;
    constructor(transport: any, resetDelay: number) {
        this.resetDelay = resetDelay;
        this.transport = transport;
    }
    async reset() {
        await this.transport.setDTR(false);
        await this.transport.setRTS(true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await this.transport.setDTR(true);
        await this.transport.setRTS(false);
        await new Promise((resolve) => setTimeout(resolve, this.resetDelay));
        await this.transport.setDTR(false);
        await this.transport.setRTS(false);
    }
}

export class WindowsReset {
    resetDelay: number;
    transport: any;
    constructor(transport: any, resetDelay: number) {
        this.resetDelay = resetDelay;
        this.transport = transport;
    }

    async reset() {
        await this.transport.device.set({ rts: true, dtr: false, })
        await new Promise((resolve) => setTimeout(resolve, 100));
        await this.transport.device.set({ rts: false, dtr: true, })
        await new Promise((resolve) => setTimeout(resolve, this.resetDelay));
        await this.transport.device.set({ rts: false, dtr: false, })
    }
}


export class NodeESP32Serial extends ESP32Serial {
    async writeFilesToDevice(files: any[]) {
        if (this.serialPort === null) {
            return;
        }
        try {
            const port = await this.serialPort.getPort();
            const transport = new Transport(port, true);
            const loaderOptions = {
                transport: transport as unknown,
                baudrate: port.baudRate,
                debugLogging: false,
                enableTracing: false,
            } as LoaderOptions;

            const esploader = new ESPLoader(loaderOptions);
            esploader.constructResetSequency = () => {
                if (esploader.transport.getPid() === 0x1001) {
                    // Custom reset sequence, which is required when the device
                    // is connecting via its USB-JTAG-Serial peripheral
                    // this.debug("using USB JTAG Serial Reset");
                    return [new UsbJtagSerialReset(transport)];
                }
                else {
                    const DEFAULT_RESET_DELAY = 50;
                    const EXTRA_DELAY = DEFAULT_RESET_DELAY + 500;
                    // this.debug("using Classic Serial Reset");
                    if (process.platform !== 'win32') {
                        return [
                            new UnixTightReset(transport, DEFAULT_RESET_DELAY),
                            new UnixTightReset(transport, EXTRA_DELAY),
                            new ClassicReset(transport, DEFAULT_RESET_DELAY),
                            new ClassicReset(transport, EXTRA_DELAY),
                        ];
                    }

                    return [
                        new WindowsReset(transport, DEFAULT_RESET_DELAY),
                        new WindowsReset(transport, EXTRA_DELAY),
                        new ClassicReset(transport, DEFAULT_RESET_DELAY),
                        new ClassicReset(transport, EXTRA_DELAY),
                    ];
                }
            }
            const chip = await esploader.main();
            console.log(chip);
            const filesArray: { address: number, data: string }[] = [];
            for (let i = 0; i < files.length; i++) {
                const data = files[i].data.toString('binary');
                filesArray.push({
                    address: files[i].address,
                    data,
                });
            }
            const flashOptions: FlashOptions = {
                fileArray: filesArray,
                flashSize: 'keep',
                eraseAll: false,
                compress: true,
                // reportProgress: (fileIndex, written, total) => {
                //     progressBars[fileIndex].value = (written / total) * 100;
                // },
                calculateMD5Hash: (image) => {
                    const hash = crypto.createHash('md5').update(image).digest("hex");
                    return hash;
                },
                flashMode: 'dio',
                flashFreq: '40m',
                reportProgress: (fileIndex: number, written: number, total: number) => {
                    this.emit('progress', (written / total));
                },
            };
            await esploader.writeFlash(flashOptions);
            port.set({ rts: false, dtr: false });
            await transport.sleep(20);
            port.set({ rts: true, dtr: false });
            await transport.sleep(20);
            port.set({ rts: false, dtr: false });
        } catch (e) {
            throw (e);
            // term.writeln(`Error: ${e.message}`);
        } finally {
            // Hide progress bars and show erase buttons
            // for (let index = 1; index < table.rows.length; index++) {
            //     table.rows[index].cells[2].style.display = "none";
            //     table.rows[index].cells[3].style.display = "initial";
            // }
        }
    }
}
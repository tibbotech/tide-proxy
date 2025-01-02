/* eslint-disable no-await-in-loop */
import ESP32Serial from './base';
import {
    ESPLoader, FlashOptions, LoaderOptions,
} from 'esptool-js/lib/index.js';
import CryptoJS from 'crypto-js';
import { NodeTransport as Transport } from '../NodeTransport'


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
                baudrate: this.baudRate,
            } as LoaderOptions;
    
            const esploader = new ESPLoader(loaderOptions);
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
                calculateMD5Hash: (image) => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)).toString(),
                flashMode: 'dio',
                flashFreq: '40m',
            };
            await esploader.writeFlash(flashOptions);
            port.set({ rts: false, dtr: false });
            await transport.sleep(20);
            port.set({ rts: true, dtr: false });
            await transport.sleep(20);
            port.set({ rts: false, dtr: false });
        } catch (e) {
            console.error(e);
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
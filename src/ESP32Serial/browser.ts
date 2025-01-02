/* eslint-disable no-await-in-loop */
import ESP32Serial from './base';
import {
    ESPLoader, FlashOptions, LoaderOptions, Transport,
} from 'esptool-js/lib/index.js';
import CryptoJS from 'crypto-js';

export class BrowserESP32Serial extends ESP32Serial {
    async writeFilesToDevice(files: any[], espLoaderTerminal: any) {
        if (this.serialPort === null) {
            return;
        }
        try {
            const port = await this.serialPort.getPort();
            const transport = new Transport(port, true);
            const loaderOptions = {
                transport,
                baudrate: this.baudRate,
                terminal: espLoaderTerminal,
            } as LoaderOptions;
    
            const esploader = new ESPLoader(loaderOptions);
            const chip = await esploader.main();
            console.log(chip);
            const filesArray: { address: number, data: string }[]= [];
            for (let i = 0; i < files.length; i++) {
                const reader = new FileReader();
                const blob = new Blob([files[i].data]);
                reader.readAsBinaryString(blob);
                const data: string = await new Promise((resolve) => {
                    reader.onload = () => {
                        resolve(reader.result as string);
                    };
                });
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
            port.setSignals({
                requestToSend: false,
                dataTerminalReady: false,
            });
            await transport.sleep(20);
            port.setSignals({
                requestToSend: true,
                dataTerminalReady: false,
            });
            await transport.sleep(20);
            port.setSignals({
                requestToSend: false,
                dataTerminalReady: false,
            });
            await transport.disconnect();
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
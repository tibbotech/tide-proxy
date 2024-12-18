/* eslint-disable no-await-in-loop */
import { Buffer } from 'buffer';
import { ISerialPort } from './ISerialPort';
import {
    ESPLoader, FlashOptions, LoaderOptions, Transport,
} from 'esptool-js/lib/index.js';
import CryptoJS from 'crypto-js';

// // Import required Node.js type
// import { TextEncoder as NodeTextEncoder } from 'util';

// // Check for TextEncoder in the global scope or fallback to Node.js's util.TextEncoder
// const TextEncoder: typeof globalThis.TextEncoder =
//   typeof globalThis.TextEncoder !== 'undefined'
//     ? globalThis.TextEncoder
//     : NodeTextEncoder;

const BaudRate = 460800;


const debugLogging = true;

const debugLog = (message: string) => {
    if (!debugLogging) {
        return;
    }
    console.log(message);
};

export class ZephyrSerial {
    serialPort: ISerialPort | null;


    constructor (serialPort: ISerialPort | null = null) {
        this.serialPort = serialPort;
    }

    async getPort() {
        if (this.serialPort) {
            return this.serialPort.getPort();
        }
    }

    setSerialPort(port: ISerialPort | null) {
        this.serialPort = port;
    }

    async writeFilesToDevice(files: any[], espLoaderTerminal: any) {
        if (this.serialPort === null) {
            return;
        }
        try {
            const port = await this.serialPort.getPort();
            const transport = new Transport(port, true);
            const loaderOptions = {
                transport,
                baudrate: BaudRate,
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
            await esploader.flashFinish(false);
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
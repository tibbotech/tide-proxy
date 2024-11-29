/* eslint-disable no-await-in-loop */
import { Buffer } from 'buffer';
import SerialPort from './SerialPort';

const { Blob } = require('node:buffer');
const { createHash } = require('node:crypto');

const { TextEncoder, TextDecoder } = require('util');

const debugLogging = false;

const debugLog = (message: string) => {
    if (!debugLogging) {
        return;
    }
    console.log(message);
};

const Control = {
    enterPasteMode: '\u0005',
    enterRawMode: '\x01',
    reset: '\u0004',
    interrupt: '\u0003',
} as const;

const PicoUSBIds = {
    usbVendorId: 0x2E8A,
    usbProductId: 0x0005,
} as const;

const PicoBaudRate = 115200;

let currentPort: any;
let readerTimeout: any;

export async function getPort() {
    return SerialPort.getPort();
}

async function sendToDevice(content: string) {
    const port = await getPort();
    if (!port) {
        return;
    }
    const encoder = new TextEncoder();
    debugLog(`sending ${content}`);
    port.write(encoder.encode(content));
    await new Promise(resolve => setTimeout(resolve, 50));
}

export async function stopRunning() {
    await sendToDevice(`\r${Control.interrupt}`);
}

export async function runFileOnDevice(code: string) {
    await stopRunning();
    await sendToDevice(`${Control.interrupt}${Control.reset}${Control.enterPasteMode}${code}${Control.reset}`);
}

export async function readUntil(prompt: string, timeout = 1): Promise<string> {
    return new Promise(async (resolve, reject) => {
        let result = '';
        const start = new Date().getTime();
        let endTime = new Date().getTime() + timeout * 1000;
        while (result.indexOf(prompt) < 0) {
            if (new Date().getTime() > endTime) {
                debugLog(`expecting ${prompt}, read ${result.toString()}`);
                reject(new Error('Timeout reading response'));
                return;
            }
            const readResult = await read();
            if (readResult !== '') {
                endTime += 1000;
            }
            result += readResult;
        }
        resolve(result);
    });
}

export async function read(timeout = 1) {
    if (!SerialPort.getPort() || readerTimeout) {
        return '';
    }
    readerTimeout = setTimeout(() => {
        readerTimeout = undefined;
        try {
        } catch (e) {
            // do nothing
        }
    }, timeout);
    const text = await SerialPort.read();
    clearTimeout(readerTimeout);
    readerTimeout = undefined;
    if (text !== '') {
        debugLog(`recv ${text}`);
    }
    return text;
}

async function execRaw(code: string, timeout = 1.5): Promise<string> {
    if (code !== '') {
        for (let i = 0; i < 3; i++) {
            try {
                await sendToDevice(`${code}${Control.reset}`);
                const result = await readUntil('OK', timeout);
                return result;
            } catch (e) {
                //
            }
        }
    }
    return '';
}

export async function enterRawMode(reset = false) {
    // await getPort();
    SerialPort.setFlowingMode(false);
    if (reset) {
        await stopRunning();
        await sendToDevice(`${Control.reset}`);
        await read(2000);
        await sendToDevice(`\r${Control.enterRawMode}`);
        let enteredRawMode = false;
        for (let i = 0; i < 5; i++) {
            try {
                await stopRunning();
                await sendToDevice(`\r${Control.enterRawMode}`);
                const str = await readUntil('>', 1);
                if (str[str.length - 1] === '>') {
                    enteredRawMode = true;
                    break;
                }
            } catch (e) {
                // timeout
            }
        }
        if (!enteredRawMode) {
            throw new Error('Failed to enter raw mode');
        }
        await stopRunning();
        const cmd = `
import gc
gc.collect()
import os, hashlib, binascii
def ___calculate_checksum(file_name):
    if file_name not in os.listdir():
        print(file_name + " not found")
        print('done')
        return
    f=open(file_name,'rb')
    m=hashlib.sha256()
    size=os.stat(file_name)[6]
    index=0
    while index < size:
        chunk = f.read(256)
        index += len(chunk)
        m.update(chunk)
    f.close()
    print(binascii.hexlify(m.digest()))
    print('done')
`;
        await execRaw(cmd, 3);
    } else {
        await stopRunning();
        await sendToDevice(`\r${Control.enterRawMode}`);
        // await readUntil('raw REPL; CTRL-B to exit\r\n>', 5);
        await readUntil('>', 5);
    }
}

export async function exitRawMode() {
    await sendToDevice('\r\x02');
    SerialPort.setFlowingMode(true);
    // await sendToDevice(`${Control.reset}`);
}

async function getFileChecksum(fileName: string, fileChecksum: string): Promise<string> {
    let existingFileChecksum = '';
    let tmp = '';
    debugLog(`Checking existing file checksum of ${fileName}`);
    for (let i = 0; i < 3; i++) {
        try {
            tmp += await execRaw(`___calculate_checksum('${fileName}')`);
            if (tmp.indexOf('done') < 0) {
                tmp += await readUntil('done');
            }
            if (tmp.indexOf('not found') >= 0) {
                break;
            }
            const resultMarker = 'b\'';
            const resultIndex = tmp.indexOf(resultMarker);
            if (resultIndex >= 0) {
                existingFileChecksum = tmp.substring(
                    resultIndex + resultMarker.length,
                    resultIndex + resultMarker.length + 64,
                );
                if (existingFileChecksum === fileChecksum) {
                    break;
                } else {
                    tmp = '';
                }
            } else {
                debugLog(tmp);
            }
        } catch (e: any) {
            debugLog(e.toString());
            // timeout or error
        }
    }
    return existingFileChecksum;
}

export async function writeFileToDevice(file: any, blockSize = 256) {
    const code = file.contents;
    const binaryCode = file.contents.data ? file.contents.data : new TextEncoder().encode(code);
    let length = binaryCode.length;
    const fileParts = file.name.split('.');
    const fileExtensions = ['py', 'json', '565', 'gz', 'html', 'der'];
    if (!fileExtensions.includes(fileParts[fileParts.length - 1])) {
        return;
    }
    if (file.name === 'cody.json') {
        return;
    }
    let fileChecksum;
    const buf = Buffer.from(binaryCode);
    fileChecksum = createHash('sha256').update(buf).digest('hex');
    let existingFileChecksum = await getFileChecksum(file.name, fileChecksum);
    let tries = 3;

    while (fileChecksum !== existingFileChecksum && tries > 0) {

        if (fileChecksum === existingFileChecksum) {
            debugLog(`File ${file.name} already exists, skipping upload`);
            return;
        }
        debugLog(`Uploading file ${file.name}`);
        const fileName = file.name;
        const start = new Date().getTime();
        await enterRawMode(false);
        if (fileName.indexOf('/') >= 0) {
            const parts = fileName.split('/');
            parts.pop();
            for (let i = 0; i < parts.length; i += 1) {
                let dir = '';
                for (let j = 0; j <= i; j += 1) {
                    // eslint-disable-next-line prefer-template
                    dir += '/' + parts[j];
                }

                await execRaw(`
import os
os.mkdir('${dir}')`);
                    }
        }
        await execRaw(`
gc.collect()
f=open('${fileName}','wb')
w=f.write`);
        let index = 0;
        while (index < length) {
            let chunk = '';
            let increment = blockSize;
            for (let i = 0; i < increment; i += 1) {
                if (index + i < length) {
                    chunk += `\\x${binaryCode[index + i].toString(16).padStart(2, '0')}`;
                }
            }
            try {
                await execRaw(`w(b"${chunk}")`, blockSize);
                debugLog(`Uploaded chunk ${index} of ${length} for file ${file.name}`);
            } catch (e) {
            }
            index += increment;
        }
        await execRaw('f.close()');
        const end = new Date().getTime();

        debugLog(`Uploaded file ${file.name} in ${end - start}ms`);

        existingFileChecksum = await getFileChecksum(file.name, fileChecksum);

        if (fileChecksum === existingFileChecksum) {
            debugLog(`File ${file.name} uploaded successfully`);
        } else {
            debugLog(`Failed to upload file ${file.name}`);
        }

        tries -= 1;
    }
}
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MicropythonSerial = void 0;
const buffer_1 = require("buffer");
const util_1 = require("util");
const TextEncoder = typeof globalThis.TextEncoder !== 'undefined'
    ? globalThis.TextEncoder
    : util_1.TextEncoder;
const debugLogging = false;
const debugLog = (message) => {
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
};
const PicoUSBIds = {
    usbVendorId: 0x2E8A,
    usbProductId: 0x0005,
};
const PicoBaudRate = 115200;
let currentPort;
class MicropythonSerial {
    constructor(serialPort = null) {
        this.serialPort = serialPort;
    }
    getPort() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.serialPort) {
                return this.serialPort.getPort();
            }
        });
    }
    sendToDevice(content) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.serialPort) {
                return;
            }
            debugLog(`sending ${content}`);
            this.serialPort.write(content);
            yield new Promise(resolve => setTimeout(resolve, 50));
        });
    }
    stopRunning() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.sendToDevice(`\r${Control.interrupt}`);
        });
    }
    runFileOnDevice(code) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.stopRunning();
            yield this.sendToDevice(`${Control.interrupt}${Control.reset}${Control.enterPasteMode}${code}${Control.reset}`);
        });
    }
    read(timeout = 1) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.serialPort) {
                return '';
            }
            const text = yield this.serialPort.read(false, 1);
            if (text !== '') {
                debugLog(`recv ${text}`);
            }
            return text;
        });
    }
    readUntil(prompt, timeout = 1) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
                let result = '';
                const start = new Date().getTime();
                let endTime = new Date().getTime() + timeout * 1000;
                while (result.indexOf(prompt) < 0) {
                    if (new Date().getTime() > endTime) {
                        debugLog(`expecting ${prompt}, read ${result.toString()}`);
                        reject(new Error('Timeout reading response'));
                        return;
                    }
                    const readResult = yield this.read();
                    if (readResult !== '') {
                        endTime += 1000;
                    }
                    result += readResult;
                }
                resolve(result);
            }));
        });
    }
    execRaw(code, timeout = 1.5) {
        return __awaiter(this, void 0, void 0, function* () {
            if (code !== '') {
                for (let i = 0; i < 3; i++) {
                    try {
                        yield this.sendToDevice(`${code}${Control.reset}`);
                        const result = yield this.readUntil('OK', timeout);
                        return result;
                    }
                    catch (e) {
                    }
                }
            }
            return '';
        });
    }
    enterRawMode(reset = false) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.serialPort) {
                return;
            }
            if (this.serialPort.setFlowingMode) {
                this.serialPort.setFlowingMode(false);
            }
            if (reset) {
                yield this.stopRunning();
                yield this.sendToDevice(`${Control.reset}`);
                yield this.read(2000);
                yield this.sendToDevice(`\r${Control.enterRawMode}`);
                let enteredRawMode = false;
                for (let i = 0; i < 5; i++) {
                    try {
                        yield this.stopRunning();
                        yield this.sendToDevice(`\r${Control.enterRawMode}`);
                        const str = yield this.readUntil('>', 1);
                        if (str[str.length - 1] === '>') {
                            enteredRawMode = true;
                            break;
                        }
                    }
                    catch (e) {
                    }
                }
                if (!enteredRawMode) {
                    throw new Error('Failed to enter raw mode');
                }
                yield this.stopRunning();
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
                yield this.execRaw(cmd, 3);
            }
            else {
                yield this.stopRunning();
                yield this.sendToDevice(`\r${Control.enterRawMode}`);
                yield this.readUntil('>', 5);
            }
        });
    }
    exitRawMode() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.serialPort) {
                return;
            }
            yield this.sendToDevice('\x02');
            yield this.sendToDevice(`${Control.reset}`);
            if (this.serialPort.setFlowingMode) {
                this.serialPort.setFlowingMode(true);
            }
        });
    }
    getFileChecksum(fileName, fileChecksum) {
        return __awaiter(this, void 0, void 0, function* () {
            let existingFileChecksum = '';
            let tmp = '';
            debugLog(`Checking existing file checksum of ${fileName}`);
            for (let i = 0; i < 3; i++) {
                try {
                    tmp += yield this.execRaw(`___calculate_checksum('${fileName}')`);
                    if (tmp.indexOf('done') < 0) {
                        tmp += yield this.readUntil('done');
                    }
                    if (tmp.indexOf('not found') >= 0) {
                        break;
                    }
                    const resultMarker = 'b\'';
                    const resultIndex = tmp.indexOf(resultMarker);
                    if (resultIndex >= 0) {
                        existingFileChecksum = tmp.substring(resultIndex + resultMarker.length, resultIndex + resultMarker.length + 64);
                        if (existingFileChecksum === fileChecksum) {
                            break;
                        }
                        else {
                            tmp = '';
                        }
                    }
                    else {
                        debugLog(tmp);
                    }
                }
                catch (e) {
                    debugLog(e.toString());
                }
            }
            return existingFileChecksum;
        });
    }
    writeFileToDevice(file, blockSize = 256) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.serialPort) {
                return;
            }
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
            const buf = buffer_1.Buffer.from(binaryCode);
            fileChecksum = yield this.serialPort.getChecksum(buf);
            let existingFileChecksum = yield this.getFileChecksum(file.name, fileChecksum);
            let tries = 3;
            while (fileChecksum !== existingFileChecksum && tries > 0) {
                if (fileChecksum === existingFileChecksum) {
                    debugLog(`File ${file.name} already exists, skipping upload`);
                    return;
                }
                debugLog(`Uploading file ${file.name}`);
                const fileName = file.name;
                const start = new Date().getTime();
                yield this.enterRawMode(false);
                if (fileName.indexOf('/') >= 0) {
                    const parts = fileName.split('/');
                    parts.pop();
                    for (let i = 0; i < parts.length; i += 1) {
                        let dir = '';
                        for (let j = 0; j <= i; j += 1) {
                            dir += '/' + parts[j];
                        }
                        yield this.execRaw(`
import os
os.mkdir('${dir}')`);
                    }
                }
                yield this.execRaw(`
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
                        yield this.execRaw(`w(b"${chunk}")`, blockSize);
                        debugLog(`Uploaded chunk ${index} of ${length} for file ${file.name}`);
                    }
                    catch (e) {
                    }
                    index += increment;
                }
                yield this.execRaw('f.close()');
                const end = new Date().getTime();
                debugLog(`Uploaded file ${file.name} in ${end - start}ms`);
                existingFileChecksum = yield this.getFileChecksum(file.name, fileChecksum);
                if (fileChecksum === existingFileChecksum) {
                    debugLog(`File ${file.name} uploaded successfully`);
                }
                else {
                    debugLog(`Failed to upload file ${file.name}`);
                }
                tries -= 1;
            }
        });
    }
}
exports.MicropythonSerial = MicropythonSerial;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTWljcm9weXRob25TZXJpYWwuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvTWljcm9weXRob25TZXJpYWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7O0FBQ0EsbUNBQWdDO0FBS2hDLCtCQUFzRDtBQUd0RCxNQUFNLFdBQVcsR0FDZixPQUFPLFVBQVUsQ0FBQyxXQUFXLEtBQUssV0FBVztJQUMzQyxDQUFDLENBQUMsVUFBVSxDQUFDLFdBQVc7SUFDeEIsQ0FBQyxDQUFDLGtCQUFlLENBQUM7QUFHdEIsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDO0FBRTNCLE1BQU0sUUFBUSxHQUFHLENBQUMsT0FBZSxFQUFFLEVBQUU7SUFDakMsSUFBSSxDQUFDLFlBQVksRUFBRTtRQUNmLE9BQU87S0FDVjtJQUNELE9BQU8sQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDekIsQ0FBQyxDQUFDO0FBRUYsTUFBTSxPQUFPLEdBQUc7SUFDWixjQUFjLEVBQUUsUUFBUTtJQUN4QixZQUFZLEVBQUUsTUFBTTtJQUNwQixLQUFLLEVBQUUsUUFBUTtJQUNmLFNBQVMsRUFBRSxRQUFRO0NBQ2IsQ0FBQztBQUVYLE1BQU0sVUFBVSxHQUFHO0lBQ2YsV0FBVyxFQUFFLE1BQU07SUFDbkIsWUFBWSxFQUFFLE1BQU07Q0FDZCxDQUFDO0FBRVgsTUFBTSxZQUFZLEdBQUcsTUFBTSxDQUFDO0FBRTVCLElBQUksV0FBZ0IsQ0FBQztBQUVyQixNQUFhLGlCQUFpQjtJQUcxQixZQUFhLGFBQWlDLElBQUk7UUFDOUMsSUFBSSxDQUFDLFVBQVUsR0FBRyxVQUFVLENBQUM7SUFDakMsQ0FBQztJQUVLLE9BQU87O1lBQ1QsSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFO2dCQUNqQixPQUFPLElBQUksQ0FBQyxVQUFVLENBQUMsT0FBTyxFQUFFLENBQUM7YUFDcEM7UUFDTCxDQUFDO0tBQUE7SUFFSyxZQUFZLENBQUMsT0FBZTs7WUFDOUIsSUFB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
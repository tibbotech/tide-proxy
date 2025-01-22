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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTWljcm9weXRob25TZXJpYWwuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvTWljcm9weXRob25TZXJpYWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7O0FBQ0EsbUNBQWdDO0FBSWhDLE1BQU0sWUFBWSxHQUFHLEtBQUssQ0FBQztBQUUzQixNQUFNLFFBQVEsR0FBRyxDQUFDLE9BQWUsRUFBRSxFQUFFO0lBQ2pDLElBQUksQ0FBQyxZQUFZLEVBQUU7UUFDZixPQUFPO0tBQ1Y7SUFDRCxPQUFPLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ3pCLENBQUMsQ0FBQztBQUVGLE1BQU0sT0FBTyxHQUFHO0lBQ1osY0FBYyxFQUFFLFFBQVE7SUFDeEIsWUFBWSxFQUFFLE1BQU07SUFDcEIsS0FBSyxFQUFFLFFBQVE7SUFDZixTQUFTLEVBQUUsUUFBUTtDQUNiLENBQUM7QUFFWCxNQUFNLFVBQVUsR0FBRztJQUNmLFdBQVcsRUFBRSxNQUFNO0lBQ25CLFlBQVksRUFBRSxNQUFNO0NBQ2QsQ0FBQztBQUVYLE1BQU0sWUFBWSxHQUFHLE1BQU0sQ0FBQztBQUU1QixJQUFJLFdBQWdCLENBQUM7QUFFckIsTUFBYSxpQkFBaUI7SUFHMUIsWUFBYSxhQUFpQyxJQUFJO1FBQzlDLElBQUksQ0FBQyxVQUFVLEdBQUcsVUFBVSxDQUFDO0lBQ2pDLENBQUM7SUFFSyxPQUFPOztZQUNULElBQUksSUFBSSxDQUFDLFVBQVUsRUFBRTtnQkFDakIsT0FBTyxJQUFJLENBQUMsVUFBVSxDQUFDLE9BQU8sRUFBRSxDQUFDO2FBQ3BDO1FBQ0wsQ0FBQztLQUFBO0lBRUssWUFBWSxDQUFDLE9BQWU7O1lBQzlCLElBQUksQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFO2dCQUNsQixPQUFPO2FBQ1Y7WUFDRCxRQUFRLENBQUMsV0FBVyxPQUFPLEVBQUUsQ0FBQyxDQUFDO1lBQy9CLElBQUksQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLE9B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
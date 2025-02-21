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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserESP32Serial = void 0;
const base_1 = __importDefault(require("./base"));
const index_js_1 = require("esptool-js/lib/index.js");
const crypto_js_1 = __importDefault(require("crypto-js"));
class BrowserESP32Serial extends base_1.default {
    writeFilesToDevice(files, espLoaderTerminal) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.serialPort === null) {
                return;
            }
            try {
                const port = yield this.serialPort.getPort();
                const transport = new index_js_1.Transport(port, true);
                const loaderOptions = {
                    transport,
                    baudrate: this.baudRate,
                    terminal: espLoaderTerminal,
                    debugLogging: false,
                    enableTracing: false,
                };
                const esploader = new index_js_1.ESPLoader(loaderOptions);
                const chip = yield esploader.main();
                console.log(chip);
                const filesArray = [];
                for (let i = 0; i < files.length; i++) {
                    const reader = new FileReader();
                    const blob = new Blob([files[i].data]);
                    reader.readAsBinaryString(blob);
                    const data = yield new Promise((resolve) => {
                        reader.onload = () => {
                            resolve(reader.result);
                        };
                    });
                    filesArray.push({
                        address: files[i].address,
                        data,
                    });
                }
                const flashOptions = {
                    fileArray: filesArray,
                    flashSize: 'keep',
                    eraseAll: false,
                    compress: true,
                    calculateMD5Hash: (image) => crypto_js_1.default.MD5(crypto_js_1.default.enc.Latin1.parse(image)).toString(),
                    flashMode: 'dio',
                    flashFreq: '40m',
                };
                yield esploader.writeFlash(flashOptions);
                port.setSignals({
                    requestToSend: false,
                    dataTerminalReady: false,
                });
                yield transport.sleep(20);
                port.setSignals({
                    requestToSend: true,
                    dataTerminalReady: false,
                });
                yield transport.sleep(20);
                port.setSignals({
                    requestToSend: false,
                    dataTerminalReady: false,
                });
                yield transport.disconnect();
            }
            catch (e) {
                console.error(e);
            }
            finally {
            }
        });
    }
}
exports.BrowserESP32Serial = BrowserESP32Serial;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnJvd3Nlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9FU1AzMlNlcmlhbC9icm93c2VyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7OztBQUNBLGtEQUFpQztBQUNqQyxzREFFaUM7QUFDakMsMERBQWlDO0FBRWpDLE1BQWEsa0JBQW1CLFNBQVEsY0FBVztJQUN6QyxrQkFBa0IsQ0FBQyxLQUFZLEVBQUUsaUJBQXNCOztZQUN6RCxJQUFJLElBQUksQ0FBQyxVQUFVLEtBQUssSUFBSSxFQUFFO2dCQUMxQixPQUFPO2FBQ1Y7WUFDRCxJQUFJO2dCQUNBLE1BQU0sSUFBSSxHQUFHLE1BQU0sSUFBSSxDQUFDLFVBQVUsQ0FBQyxPQUFPLEVBQUUsQ0FBQztnQkFDN0MsTUFBTSxTQUFTLEdBQUcsSUFBSSxvQkFBUyxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQztnQkFDNUMsTUFBTSxhQUFhLEdBQUc7b0JBQ2xCLFNBQVM7b0JBQ1QsUUFBUSxFQUFFLElBQUksQ0FBQyxRQUFRO29CQUN2QixRQUFRLEVBQUUsaUJBQWlCO29CQUMzQixZQUFZLEVBQUUsS0FBSztvQkFDbkIsYUFBYSxFQUFFLEtBQUs7aUJBQ04sQ0FBQztnQkFFbkIsTUFBTSxTQUFTLEdBQUcsSUFBSSxvQkFBUyxDQUFDLGFBQWEsQ0FBQyxDQUFDO2dCQUMvQyxNQUFNLElBQUksR0FBRyxNQUFNLFNBQVMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztnQkFDcEMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDbEIsTUFBTSxVQUFVLEdBQXVDLEVBQUUsQ0FBQztnQkFDMUQsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUU7b0JBQ25DLE1BQU0sTUFBTSxHQUFHLElBQUksVUFBVSxFQUFFLENBQUM7b0JBQ2hDLE1BQU0sSUFBSSxHQUFHLElBQUksSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7b0JBQ3ZDLE1BQU0sQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsQ0FBQztvQkFDaEMsTUFBTSxJQUFJLEdBQVcsTUFBTSxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFO3dCQUMvQyxNQUFNLENBQUMsTUFBTSxHQUFHLEdBQUcsRUFBRTs0QkFDakIsT0FBTyxDQUFDLE1BQU0sQ0FBQyxNQUFnQixDQUFDLENBQUM7d0JBQ3JDLENBQUMsQ0FBQztvQkFDTixDQUFDLENBQUMsQ0FBQztvQkFDSCxVQUFVLENBQUMsSUFBSSxDQUFDO3dCQUNaLE9BQU8sRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTzt3QkFDekIsSUFBSTtxQkFDUCxDQUFDLENBQUM7aUJBQ047Z0JBQ0QsTUFBTSxZQUFZLEdBQWlCO29CQUMvQixTQUFTLEVBQUUsVUFBVTtvQkFDckIsU0FBUyxFQUFFLE1BQU07b0JBQ2pCLFFBQVEsRUFBRSxLQUFLO29CQUNmLFFBQVEsRUFBRSxJQUFJO29CQUlkLGdCQUFnQixFQUFFLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxtQkFBUSxDQUFDLEdBQUcsQ0FBQyxtQkFBUSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsUUFBUSxFQUFFO29CQUN0RixTQUFTLEVBQUUsS0FBSztvQkFDaEIsU0FBUyxFQUFFLEtBQUs7aUJBQ25CLENBQUM7Z0JBQ0YsTUFBTSxTQUFTLENBQUMsVUFBVSxDQUFDLFlBQVksQ0FBQyxDQUFDO2dCQUN6QyxJQUFJLENBQUMsVUFBVSxDQUFDO29CQUNaLGFBQWEsRUFBRSxLQUFLO29CQUNwQixpQkFBaUIsRUFBRSxLQUFLO2lCQUMzQixDQUFDLENBQUM7Z0JBQ0gsTUFBTSxTQUFTLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDO2dCQUMxQixJQUFJLENBQUMsVUFBVSxDQUFDO29CQUNaLGFBQWEsRUFBRSxJQUFJO29CQUNuQixpQkFBaUIsRUFBRSxLQUFLO2lCQUMzQixDQUFDLENBQUM7Z0JBQ0gsTUFBTSxTQUFTLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDO2dCQUMxQixJQUFJLENBQUMsVUFBVSxDQUFDO29CQUNaLGFBQWEsRUFBRSxLQUFLO29CQUNwQixpQkFBaUIsRUFBRSxLQUFLO2lCQUMzQixDQUFDLENBQUM7Z0JBQ0gsTUFBTSxTQUFTLENBQUMsVUFBVSxFQUFFLENBQUM7YUFDaEM7WUFBQyxPQUFPLENBQUMsRUFBRTtnQkFDUixPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO2FBRXBCO29CQUFTO2FBTVQ7UUFDTCxDQUFDO0tBQUE7Q0FDSjtBQXpFRCxnREF5RUMifQ==
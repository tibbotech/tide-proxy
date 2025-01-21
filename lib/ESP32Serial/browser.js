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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnJvd3Nlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9FU1AzMlNlcmlhbC9icm93c2VyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7OztBQUNBLGtEQUFpQztBQUNqQyxzREFFaUM7QUFDakMsMERBQWlDO0FBRWpDLE1BQWEsa0JBQW1CLFNBQVEsY0FBVztJQUN6QyxrQkFBa0IsQ0FBQyxLQUFZLEVBQUUsaUJBQXNCOztZQUN6RCxJQUFJLElBQUksQ0FBQyxVQUFVLEtBQUssSUFBSSxFQUFFO2dCQUMxQixPQUFPO2FBQ1Y7WUFDRCxJQUFJO2dCQUNBLE1BQU0sSUFBSSxHQUFHLE1BQU0sSUFBSSxDQUFDLFVBQVUsQ0FBQyxPQUFPLEVBQUUsQ0FBQztnQkFDN0MsTUFBTSxTQUFTLEdBQUcsSUFBSSxvQkFBUyxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQztnQkFDNUMsTUFBTSxhQUFhLEdBQUc7b0JBQ2xCLFNBQVM7b0JBQ1QsUUFBUSxFQUFFLElBQUksQ0FBQyxRQUFRO29CQUN2QixRQUFRLEVBQUUsaUJBQWlCO2lCQUNiLENBQUM7Z0JBRW5CLE1BQU0sU0FBUyxHQUFHLElBQUksb0JBQVMsQ0FBQyxhQUFhLENBQUMsQ0FBQztnQkFDL0MsTUFBTSxJQUFJLEdBQUcsTUFBTSxTQUFTLENBQUMsSUFBSSxFQUFFLENBQUM7Z0JBQ3BDLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ2xCLE1BQU0sVUFBVSxHQUF1QyxFQUFFLENBQUM7Z0JBQzFELEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO29CQUNuQyxNQUFNLE1BQU0sR0FBRyxJQUFJLFVBQVUsRUFBRSxDQUFDO29CQUNoQyxNQUFNLElBQUksR0FBRyxJQUFJLElBQUksQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO29CQUN2QyxNQUFNLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLENBQUM7b0JBQ2hDLE1BQU0sSUFBSSxHQUFXLE1BQU0sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRTt3QkFDL0MsTUFBTSxDQUFDLE1BQU0sR0FBRyxHQUFHLEVBQUU7NEJBQ2pCLE9BQU8sQ0FBQyxNQUFNLENBQUMsTUFBZ0IsQ0FBQyxDQUFDO3dCQUNyQyxDQUFDLENBQUM7b0JBQ04sQ0FBQyxDQUFDLENBQUM7b0JBQ0gsVUFBVSxDQUFDLElBQUksQ0FBQzt3QkFDWixPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU87d0JBQ3pCLElBQUk7cUJBQ1AsQ0FBQyxDQUFDO2lCQUNOO2dCQUNELE1BQU0sWUFBWSxHQUFpQjtvQkFDL0IsU0FBUyxFQUFFLFVBQVU7b0JBQ3JCLFNBQVMsRUFBRSxNQUFNO29CQUNqQixRQUFRLEVBQUUsS0FBSztvQkFDZixRQUFRLEVBQUUsSUFBSTtvQkFJZCxnQkFBZ0IsRUFBRSxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsbUJBQVEsQ0FBQyxHQUFHLENBQUMsbUJBQVEsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFFBQVEsRUFBRTtvQkFDdEYsU0FBUyxFQUFFLEtBQUs7b0JBQ2hCLFNBQVMsRUFBRSxLQUFLO2lCQUNuQixDQUFDO2dCQUNGLE1BQU0sU0FBUyxDQUFDLFVBQVUsQ0FBQyxZQUFZLENBQUMsQ0FBQztnQkFDekMsSUFBSSxDQUFDLFVBQVUsQ0FBQztvQkFDWixhQUFhLEVBQUUsS0FBSztvQkFDcEIsaUJBQWlCLEVBQUUsS0FBSztpQkFDM0IsQ0FBQyxDQUFDO2dCQUNILE1BQU0sU0FBUyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQztnQkFDMUIsSUFBSSxDQUFDLFVBQVUsQ0FBQztvQkFDWixhQUFhLEVBQUUsSUFBSTtvQkFDbkIsaUJBQWlCLEVBQUUsS0FBSztpQkFDM0IsQ0FBQyxDQUFDO2dCQUNILE1BQU0sU0FBUyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQztnQkFDMUIsSUFBSSxDQUFDLFVBQVUsQ0FBQztvQkFDWixhQUFhLEVBQUUsS0FBSztvQkFDcEIsaUJBQWlCLEVBQUUsS0FBSztpQkFDM0IsQ0FBQyxDQUFDO2dCQUNILE1BQU0sU0FBUyxDQUFDLFVBQVUsRUFBRSxDQUFDO2FBQ2hDO1lBQUMsT0FBTyxDQUFDLEVBQUU7Z0JBQ1IsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQzthQUVwQjtvQkFBUzthQU1UO1FBQ0wsQ0FBQztLQUFBO0NBQ0o7QUF2RUQsZ0RBdUVDIn0=
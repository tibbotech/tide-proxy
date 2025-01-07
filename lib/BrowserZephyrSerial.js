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
exports.ZephyrSerial = void 0;
const index_js_1 = require("esptool-js/lib/index.js");
const crypto_js_1 = __importDefault(require("crypto-js"));
const BaudRate = 460800;
const debugLogging = true;
const debugLog = (message) => {
    if (!debugLogging) {
        return;
    }
    console.log(message);
};
class ZephyrSerial {
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
    setSerialPort(port) {
        this.serialPort = port;
    }
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
                    baudrate: BaudRate,
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
                yield esploader.flashFinish(false);
            }
            catch (e) {
                console.error(e);
            }
            finally {
            }
        });
    }
}
exports.ZephyrSerial = ZephyrSerial;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQnJvd3NlclplcGh5clNlcmlhbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9Ccm93c2VyWmVwaHlyU2VyaWFsLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7OztBQUdBLHNEQUVpQztBQUNqQywwREFBaUM7QUFXakMsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDO0FBR3hCLE1BQU0sWUFBWSxHQUFHLElBQUksQ0FBQztBQUUxQixNQUFNLFFBQVEsR0FBRyxDQUFDLE9BQWUsRUFBRSxFQUFFO0lBQ2pDLElBQUksQ0FBQyxZQUFZLEVBQUU7UUFDZixPQUFPO0tBQ1Y7SUFDRCxPQUFPLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ3pCLENBQUMsQ0FBQztBQUVGLE1BQWEsWUFBWTtJQUlyQixZQUFhLGFBQWlDLElBQUk7UUFDOUMsSUFBSSxDQUFDLFVBQVUsR0FBRyxVQUFVLENBQUM7SUFDakMsQ0FBQztJQUVLLE9BQU87O1lBQ1QsSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFO2dCQUNqQixPQUFPLElBQUksQ0FBQyxVQUFVLENBQUMsT0FBTyxFQUFFLENBQUM7YUFDcEM7UUFDTCxDQUFDO0tBQUE7SUFFRCxhQUFhLENBQUMsSUFBd0I7UUFDbEMsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUM7SUFDM0IsQ0FBQztJQUVLLGtCQUFrQixDQUFDLEtBQVksRUFBRSxpQkFBc0I7O1lBQ3pELElBQUksSUFBSSxDQUFDLFVBQVUsS0FBSyxJQUFJLEVBQUU7Z0JBQzFCLE9BQU87YUFDVjtZQUNELElBQUk7Z0JBQ0EsTUFBTSxJQUFJLEdBQUcsTUFBTSxJQUFJLENBQUMsVUFBVSxDQUFDLE9BQU8sRUFBRSxDQUFDO2dCQUM3QyxNQUFNLFNBQVMsR0FBRyxJQUFJLG9CQUFTLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDO2dCQUM1QyxNQUFNLGFBQWEsR0FBRztvQkFDbEIsU0FBUztvQkFDVCxRQUFRLEVBQUUsUUFBUTtvQkFDbEIsUUFBUSxFQUFFLGlCQUFpQjtpQkFDYixDQUFDO2dCQUVuQixNQUFNLFNBQVMsR0FBRyxJQUFJLG9CQUFTLENBQUMsYUFBYSxDQUFDLENBQUM7Z0JBQy9DLE1BQU0sSUFBSSxHQUFHLE1BQU0sU0FBUyxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUNwQyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUNsQixNQUFNLFVBQVUsR0FBdUMsRUFBRSxDQUFDO2dCQUMxRCxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtvQkFDbkMsTUFBTSxNQUFNLEdBQUcsSUFBSSxVQUFVLEVBQUUsQ0FBQztvQkFDaEMsTUFBTSxJQUFJLEdBQUcsSUFBSSxJQUFJLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztvQkFDdkMsTUFBTSxDQUFDLGtCQUFrQixDQUFDLElBQUksQ0FBQyxDQUFDO29CQUNoQyxNQUFNLElBQUksR0FBVyxNQUFNLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUU7d0JBQy9DLE1BQU0sQ0FBQyxNQUFNLEdBQUcsR0FBRyxFQUFFOzRCQUNqQixPQUFPLENBQUMsTUFBTSxDQUFDLE1BQWdCLENBQUMsQ0FBQzt3QkFDckMsQ0FBQyxDQUFDO29CQUNOLENBQUMsQ0FBQyxDQUFDO29CQUNILFVBQVUsQ0FBQyxJQUFJLENBQUM7d0JBQ1osT0FBTyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPO3dCQUN6QixJQUFJO3FCQUNQLENBQUMsQ0FBQztpQkFDTjtnQkFDRCxNQUFNLFlBQVksR0FBaUI7b0JBQy9CLFNBQVMsRUFBRSxVQUFVO29CQUNyQixTQUFTLEVBQUUsTUFBTTtvQkFDakIsUUFBUSxFQUFFLEtBQUs7b0JBQ2YsUUFBUSxFQUFFLElBQUk7b0JBSWQsZ0JBQWdCLEVBQUUsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLG1CQUFRLENBQUMsR0FBRyxDQUFDLG1CQUFRLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxRQUFRLEVBQUU7b0JBQ3RGLFNBQVMsRUFBRSxLQUFLO29CQUNoQixTQUFTLEVBQUUsS0FBSztpQkFDbkIsQ0FBQztnQkFDRixNQUFNLFNBQVMsQ0FBQyxVQUFVLENBQUMsWUFBWSxDQUFDLENBQUM7Z0JBQ3pDLE1BQU0sU0FBUyxDQUFDLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQzthQUN0QztZQUFDLE9BQU8sQ0FBQyxFQUFFO2dCQUNSLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7YUFFcEI7b0JBQVM7YUFNVDtRQUNMLENBQUM7S0FBQTtDQUNKO0FBMUVELG9DQTBFQyJ9
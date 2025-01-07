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
const buffer_1 = require("buffer");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const child_process_1 = __importDefault(require("child_process"));
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
    writeFilesToDevice(files, proxy) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
                if (this.serialPort === null) {
                    return;
                }
                if (files.length !== 1) {
                    throw new Error('Only one file is supported');
                }
                const { data, address, } = files[0];
                const fileBase = proxy.makeid(8);
                let fileName = `${fileBase}.bin`;
                const bytes = buffer_1.Buffer.from(data, 'binary');
                const filePath = path_1.default.join(__dirname, fileName);
                fs_1.default.writeFileSync(filePath, bytes);
                const cleanup = () => {
                    if (filePath && fs_1.default.existsSync(filePath)) {
                        fs_1.default.unlinkSync(filePath);
                    }
                };
                const esptool = `${process.env.ZEPHYR_BASE}/../modules/hal/espressif/tools/esptool_py/esptool.py`;
                const ccmd = `python3 ${esptool} --port ${this.serialPort.portPath} write_flash ${address} ${filePath}`;
                const exec = child_process_1.default.spawn(ccmd, [], { env: Object.assign(Object.assign({}, process.env), { NODE_OPTIONS: '' }), timeout: 60000, shell: true });
                if (!exec.pid) {
                    return;
                }
                exec.on('error', () => {
                    cleanup();
                    reject();
                });
                exec.on('exit', () => {
                    cleanup();
                    resolve();
                });
                exec.on('close', (code) => {
                    console.log(`child process exited with code ${code}`);
                });
                exec.on('data', (data) => {
                    console.log(data);
                });
            }));
        });
    }
}
exports.ZephyrSerial = ZephyrSerial;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTm9kZVplcGh5clNlcmlhbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9Ob2RlWmVwaHlyU2VyaWFsLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7OztBQUNBLG1DQUFnQztBQU9oQyxnREFBd0I7QUFDeEIsNENBQW9CO0FBQ3BCLGtFQUErQjtBQVcvQixNQUFhLFlBQVk7SUFJckIsWUFBYSxhQUFpQyxJQUFJO1FBQzlDLElBQUksQ0FBQyxVQUFVLEdBQUcsVUFBVSxDQUFDO0lBQ2pDLENBQUM7SUFFSyxPQUFPOztZQUNULElBQUksSUFBSSxDQUFDLFVBQVUsRUFBRTtnQkFDakIsT0FBTyxJQUFJLENBQUMsVUFBVSxDQUFDLE9BQU8sRUFBRSxDQUFDO2FBQ3BDO1FBQ0wsQ0FBQztLQUFBO0lBRUQsYUFBYSxDQUFDLElBQXdCO1FBQ2xDLElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDO0lBQzNCLENBQUM7SUFFSyxrQkFBa0IsQ0FBQyxLQUFZLEVBQUUsS0FBVTs7WUFDN0MsT0FBTyxJQUFJLE9BQU8sQ0FBQyxDQUFPLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtnQkFDekMsSUFBSSxJQUFJLENBQUMsVUFBVSxLQUFLLElBQUksRUFBRTtvQkFDMUIsT0FBTztpQkFDVjtnQkFDRCxJQUFJLEtBQUssQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFO29CQUNwQixNQUFNLElBQUksS0FBSyxDQUFDLDRCQUE0QixDQUFDLENBQUM7aUJBQ2pEO2dCQUNELE1BQU0sRUFDRixJQUFJLEVBQ0osT0FBTyxHQUNWLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUNiLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQ2pDLElBQUksUUFBUSxHQUFHLEdBQUcsUUFBUSxNQUFNLENBQUM7Z0JBQ2pDLE1BQU0sS0FBSyxHQUFHLGVBQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO2dCQUMxQyxNQUFNLFFBQVEsR0FBRyxjQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxRQUFRLENBQUMsQ0FBQztnQkFDaEQsWUFBRSxDQUFDLGFBQWEsQ0FBQyxRQUFRLEVBQUUsS0FBSyxDQUFDLENBQUM7Z0JBQ2xDLE1BQU0sT0FBTyxHQUFHLEdBQUcsRUFBRTtvQkFDakIsSUFBSSxRQUFRLElBQUksWUFBRSxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUMsRUFBRTt3QkFDckMsWUFBRSxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUMsQ0FBQztxQkFDM0I7Z0JBQ0wsQ0FBQyxDQUFBO2dCQUVELE1BQU0sT0FBTyxHQUFHLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxXQUFXLHVEQUF1RCxDQUFDO2dCQUNsRyxNQUFNLElBQUksR0FBRyxXQUFXLE9BQU8sV0FBVyxJQUFJLENBQUMsVUFBVSxDQUFDLFFBQVEsZ0JBQWdCLE9BQU8sSUFBSSxRQUFRLEVBQUUsQ0FBQztnQkFDeEcsTUFBTSxJQUFJLEdBQUcsdUJBQUUsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLEVBQUUsRUFBRSxFQUFFLEdBQUcsa0NBQU8sT0FBTyxDQUFDLEdBQUcsS0FBRSxZQUFZLEVBQUUsRUFBRSxHQUFFLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztnQkFDNUcsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUU7b0JBQ1gsT0FBTztpQkFDVjtnQkFDRCxJQUFJLENBQUMsRUFBRSxDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUU7b0JBQ2xCLE9BQU8sRUFBRSxDQUFDO29CQUNWLE1BQU0sRUFBRSxDQUFDO2dCQUNiLENBQUMsQ0FBQyxDQUFDO2dCQUNILElBQUksQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFLEdBQUcsRUFBRTtvQkFDakIsT0FBTyxFQUFFLENBQUM7b0JBQ1YsT0FBTyxFQUFFLENBQUM7Z0JBQ2QsQ0FBQyxDQUFDLENBQUM7Z0JBQ0gsSUFBSSxDQUFDLEVBQUUsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxJQUFJLEVBQUUsRUFBRTtvQkFDdEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxrQ0FBa0MsSUFBSSxFQUFFLENBQUMsQ0FBQztnQkFDMUQsQ0FBQyxDQUFDLENBQUM7Z0JBQ0gsSUFBSSxDQUFDLEVBQUUsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxJQUFJLEVBQUUsRUFBRTtvQkFDckIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDdEIsQ0FBQyxDQUFDLENBQUM7WUFDUCxDQUFDLENBQUEsQ0FBQyxDQUFDO1FBQ1AsQ0FBQztLQUFBO0NBQ0o7QUEvREQsb0NBK0RDIn0=
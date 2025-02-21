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
const stream_1 = require("stream");
class ESP32Serial extends stream_1.EventEmitter {
    constructor(serialPort = null) {
        super();
        this.baudRate = 460800;
        this.serialPort = serialPort;
    }
    getPort() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.serialPort) {
                return this.serialPort.getPort();
            }
        });
    }
    writeFilesToDevice(files, espLoaderTerminal) {
        return __awaiter(this, void 0, void 0, function* () {
            return;
        });
    }
}
exports.default = ESP32Serial;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9FU1AzMlNlcmlhbC9iYXNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7O0FBQ0EsbUNBQXNDO0FBR3RDLE1BQXFCLFdBQVksU0FBUSxxQkFBWTtJQUtqRCxZQUFhLGFBQWlDLElBQUk7UUFDOUMsS0FBSyxFQUFFLENBQUM7UUFKWixhQUFRLEdBQVcsTUFBTSxDQUFDO1FBS3RCLElBQUksQ0FBQyxVQUFVLEdBQUcsVUFBVSxDQUFDO0lBQ2pDLENBQUM7SUFFSyxPQUFPOztZQUNULElBQUksSUFBSSxDQUFDLFVBQVUsRUFBRTtnQkFDakIsT0FBTyxJQUFJLENBQUMsVUFBVSxDQUFDLE9BQU8sRUFBRSxDQUFDO2FBQ3BDO1FBQ0wsQ0FBQztLQUFBO0lBR0ssa0JBQWtCLENBQUMsS0FBWSxFQUFFLGlCQUFzQjs7WUFDekQsT0FBTztRQUNYLENBQUM7S0FBQTtDQUNKO0FBcEJELDhCQW9CQyJ9
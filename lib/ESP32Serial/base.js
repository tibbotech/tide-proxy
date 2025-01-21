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
class ESP32Serial {
    constructor(serialPort = null) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9FU1AzMlNlcmlhbC9iYXNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7O0FBR0EsTUFBcUIsV0FBVztJQUs1QixZQUFhLGFBQWlDLElBQUk7UUFIbEQsYUFBUSxHQUFXLE1BQU0sQ0FBQztRQUl0QixJQUFJLENBQUMsVUFBVSxHQUFHLFVBQVUsQ0FBQztJQUNqQyxDQUFDO0lBRUssT0FBTzs7WUFDVCxJQUFJLElBQUksQ0FBQyxVQUFVLEVBQUU7Z0JBQ2pCLE9BQU8sSUFBSSxDQUFDLFVBQVUsQ0FBQyxPQUFPLEVBQUUsQ0FBQzthQUNwQztRQUNMLENBQUM7S0FBQTtJQUdLLGtCQUFrQixDQUFDLEtBQVksRUFBRSxpQkFBc0I7O1lBQ3pELE9BQU87UUFDWCxDQUFDO0tBQUE7Q0FDSjtBQW5CRCw4QkFtQkMifQ==
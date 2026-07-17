'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugPrintListener = void 0;
const tide_proxy_1 = require("./tide-proxy");
const debug_output_1 = require("./debug-output");
const POLL_INTERVAL_MS = 2000;
class DebugPrintListener {
    constructor(socket, onOutput, sendCommand) {
        this.socket = socket;
        this.onOutput = onOutput;
        this.sendCommand = sendCommand;
        this.handler = null;
        this.pollInterval = null;
        this.mac = '';
    }
    attach(mac) {
        this.detach();
        this.mac = mac;
        this.handler = (data) => {
            if (data.mac !== this.mac) {
                return;
            }
            try {
                const message = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
                const text = message.data != undefined ? message.data : String(message);
                this.onOutput(text);
                debug_output_1.appendDebugOutput(text);
            }
            catch (_a) {
                if (typeof data.data === 'string') {
                    this.onOutput(data.data);
                    debug_output_1.appendDebugOutput(data.data);
                }
            }
        };
        this.socket.emit(tide_proxy_1.TIBBO_PROXY_MESSAGE.REGISTER, { mac });
        this.socket.on(tide_proxy_1.TIBBO_PROXY_MESSAGE.DEBUG_PRINT, this.handler);
        this.pollInterval = setInterval(() => {
            if (this.mac === mac) {
                this.sendCommand(mac, tide_proxy_1.PCODE_COMMANDS.STATE);
            }
        }, POLL_INTERVAL_MS);
    }
    detach() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.handler) {
            this.socket.off(tide_proxy_1.TIBBO_PROXY_MESSAGE.DEBUG_PRINT, this.handler);
            this.handler = null;
        }
        this.mac = '';
    }
    get attachedMac() {
        return this.mac;
    }
}
exports.DebugPrintListener = DebugPrintListener;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVidWctcHJpbnQtbGlzdGVuZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvZGVidWctcHJpbnQtbGlzdGVuZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsWUFBWSxDQUFDOzs7QUFFYiw2Q0FBbUU7QUFDbkUsaURBQW1EO0FBRW5ELE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxDQUFDO0FBTzlCLE1BQWEsa0JBQWtCO0lBTTNCLFlBQ1ksTUFBVyxFQUNYLFFBQWdDLEVBQ2hDLFdBQWtFO1FBRmxFLFdBQU0sR0FBTixNQUFNLENBQUs7UUFDWCxhQUFRLEdBQVIsUUFBUSxDQUF3QjtRQUNoQyxnQkFBVyxHQUFYLFdBQVcsQ0FBdUQ7UUFQdEUsWUFBTyxHQUFpQyxJQUFJLENBQUM7UUFDN0MsaUJBQVksR0FBMEIsSUFBSSxDQUFDO1FBQzNDLFFBQUcsR0FBVyxFQUFFLENBQUM7SUFNckIsQ0FBQztJQUVFLE1BQU0sQ0FBQyxHQUFXO1FBQ3JCLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNkLElBQUksQ0FBQyxHQUFHLEdBQUcsR0FBRyxDQUFDO1FBRWYsSUFBSSxDQUFDLE9BQU8sR0FBRyxDQUFDLElBQVMsRUFBRSxFQUFFO1lBQ3pCLElBQUksSUFBSSxDQUFDLEdBQUcsS0FBSyxJQUFJLENBQUMsR0FBRyxFQUFFO2dCQUN2QixPQUFPO2FBQ1Y7WUFDRCxJQUFJO2dCQUNBLE1BQU0sT0FBTyxHQUFHLE9BQU8sSUFBSSxDQUFDLElBQUksS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO2dCQUNsRixNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsSUFBSSxJQUFJLFNBQVMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO2dCQUN4RSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUNwQixnQ0FBaUIsQ0FBQyxJQUFJLENBQUMsQ0FBQzthQUMzQjtZQUFDLFdBQU07Z0JBQ0osSUFBSSxPQUFPLElBQUksQ0FBQyxJQUFJLEtBQUssUUFBUSxFQUFFO29CQUMvQixJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztvQkFDekIsZ0NBQWlCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO2lCQUNoQzthQUNKO1FBQ0wsQ0FBQyxDQUFDO1FBRUYsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsZ0NBQW1CLENBQUMsUUFBUSxFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUN4RCxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxnQ0FBbUIsQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBRTlELElBQUksQ0FBQyxZQUFZLEdBQUcsV0FBVyxDQUFDLEdBQUcsRUFBRTtZQUNqQyxJQUFJLElBQUksQ0FBQyxHQUFHLEtBQUssR0FBRyxFQUFFO2dCQUNsQixJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsRUFBRSwyQkFBYyxDQUFDLEtBQUssQ0FBQyxDQUFDO2FBQy9DO1FBQ0wsQ0FBQyxFQUFFLGdCQUFnQixDQUFDLENBQUM7SUFDekIsQ0FBQztJQUVNLE1BQU07UUFDVCxJQUFJLElBQUksQ0FBQyxZQUFZLEVBQUU7WUFDbkIsYUFBYSxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztZQUNqQyxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksQ0FBQztTQUM1QjtRQUNELElBQUksSUFBSSxDQUFDLE9BQU8sRUFBRTtZQUNkLElBQUksQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLGdDQUFtQixDQUFDLFdBQVcsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7WUFDL0QsSUFBSSxDQUFDLE9BQU8sR0FBRyxJQUFJLENBQUM7U0FDdkI7UUFDRCxJQUFJLENBQUMsR0FBRyxHQUFHLEVBQUUsQ0FBQztJQUNsQixDQUFDO0lBRUQsSUFBVyxXQUFXO1FBQ2xCLE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQztJQUNwQixDQUFDO0NBQ0o7QUExREQsZ0RBMERDIn0=
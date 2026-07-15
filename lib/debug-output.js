'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearDebugOutput = exports.getDebugOutputLineCount = exports.getDebugOutput = exports.appendDebugOutput = void 0;
const MAX_LINES = 5000;
let buffer = [];
function appendDebugOutput(text) {
    if (text === undefined || text === null) {
        return;
    }
    const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    for (const line of lines) {
        buffer.push(line);
    }
    if (buffer.length > MAX_LINES) {
        buffer = buffer.slice(buffer.length - MAX_LINES);
    }
}
exports.appendDebugOutput = appendDebugOutput;
function getDebugOutput(maxLines) {
    const lines = maxLines && maxLines > 0 ? buffer.slice(Math.max(0, buffer.length - maxLines)) : buffer;
    return lines.join('\n');
}
exports.getDebugOutput = getDebugOutput;
function getDebugOutputLineCount() {
    return buffer.length;
}
exports.getDebugOutputLineCount = getDebugOutputLineCount;
function clearDebugOutput() {
    buffer = [];
}
exports.clearDebugOutput = clearDebugOutput;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVidWctb3V0cHV0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2RlYnVnLW91dHB1dC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxZQUFZLENBQUM7OztBQWViLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQztBQUV2QixJQUFJLE1BQU0sR0FBYSxFQUFFLENBQUM7QUFNMUIsU0FBZ0IsaUJBQWlCLENBQUMsSUFBWTtJQUM3QyxJQUFJLElBQUksS0FBSyxTQUFTLElBQUksSUFBSSxLQUFLLElBQUksRUFBRTtRQUN4QyxPQUFPO0tBQ1A7SUFDRCxNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQzVFLE1BQU0sS0FBSyxHQUFHLFVBQVUsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7SUFHckMsSUFBSSxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsSUFBSSxLQUFLLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7UUFDdkQsS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDO0tBQ1o7SUFDRCxLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRTtRQUN6QixNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0tBQ2xCO0lBQ0QsSUFBSSxNQUFNLENBQUMsTUFBTSxHQUFHLFNBQVMsRUFBRTtRQUM5QixNQUFNLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsTUFBTSxHQUFHLFNBQVMsQ0FBQyxDQUFDO0tBQ2pEO0FBQ0YsQ0FBQztBQWpCRCw4Q0FpQkM7QUFNRCxTQUFnQixjQUFjLENBQUMsUUFBaUI7SUFDL0MsTUFBTSxLQUFLLEdBQUcsUUFBUSxJQUFJLFFBQVEsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsTUFBTSxDQUFDLE1BQU0sR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFDdEcsT0FBTyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3pCLENBQUM7QUFIRCx3Q0FHQztBQUdELFNBQWdCLHVCQUF1QjtJQUN0QyxPQUFPLE1BQU0sQ0FBQyxNQUFNLENBQUM7QUFDdEIsQ0FBQztBQUZELDBEQUVDO0FBR0QsU0FBZ0IsZ0JBQWdCO0lBQy9CLE1BQU0sR0FBRyxFQUFFLENBQUM7QUFDYixDQUFDO0FBRkQsNENBRUMifQ==
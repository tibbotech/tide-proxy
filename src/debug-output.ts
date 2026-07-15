'use strict';

/**
 * Shared in-memory buffer of device debug-print / console output.
 *
 * The debug-print stream is produced in two places — the standalone
 * "Tibbo Debug Print" output channel (see DeviceExplorer.attachDebugPrint)
 * and the active debug session's Debug Console (see TibboDebugSession.onDebugPrint).
 * Neither surface is visible to an MCP client, so both producers also append
 * here, letting the MCP `get_console_output` tool return what the device printed.
 *
 * It is a process-wide singleton (module state) rather than an injected
 * dependency so the producers can feed it without being coupled to the MCP layer.
 */

const MAX_LINES = 5000;

let buffer: string[] = [];

/**
 * Append output to the buffer. Splits on newlines so the ring buffer is
 * line-accurate, and trims the oldest lines once MAX_LINES is exceeded.
 */
export function appendDebugOutput(text: string): void {
	if (text === undefined || text === null) {
		return;
	}
	const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const lines = normalized.split('\n');
	// A trailing newline yields an empty final element; drop it so we don't
	// accumulate blank lines on every append.
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

/**
 * Return captured output as a single string. With `maxLines`, returns only the
 * most recent N lines.
 */
export function getDebugOutput(maxLines?: number): string {
	const lines = maxLines && maxLines > 0 ? buffer.slice(Math.max(0, buffer.length - maxLines)) : buffer;
	return lines.join('\n');
}

/** Number of lines currently buffered. */
export function getDebugOutputLineCount(): number {
	return buffer.length;
}

/** Clear all captured output. */
export function clearDebugOutput(): void {
	buffer = [];
}

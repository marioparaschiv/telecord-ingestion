import type { RawData } from 'ws';

/**
 * The bytes of one WebSocket message, however `ws` delivered it.
 *
 * @param data - The message data.
 * @returns The data as one byte array.
 */
function rawDataBytes(data: RawData): Uint8Array {
	return Array.isArray(data) ? Buffer.concat(data) : new Uint8Array(data);
}

export default rawDataBytes;

import {
	TlBinaryReader,
	TlBinaryWriter,
	TlSerializationCounter,
	__tlReaderMap,
	__tlWriterMap,
} from '@mtcute/node/utils.js';
import type { tl } from '@mtcute/node';

import { TELEGRAM_FILE_LOCATIONS } from '@telecord/ingest-client/telegram';
import { asError, createTaggedLogger } from '@telecord/producer-core';

/** A file location a `MEDIA_FETCH` may name. */
export type FileLocation =
	| tl.RawInputDocumentFileLocation
	| tl.RawInputPhotoFileLocation
	| tl.RawInputPeerPhotoFileLocation;

const FILE_LOCATIONS = new Set<string>(TELEGRAM_FILE_LOCATIONS);

const logger = createTaggedLogger('Telegram TL');

/**
 * Serializes one boxed TL object at the session's layer.
 *
 * @param object - The object.
 * @returns Its bytes.
 */
export function serialize(object: tl.TlObject): Uint8Array<ArrayBuffer> {
	// The writer's view is typed over any buffer; the copy pins it to a plain `ArrayBuffer`.
	return new Uint8Array(TlBinaryWriter.serializeObject(__tlWriterMap, object));
}

/**
 * Reads one boxed TL object serialized at the session's layer.
 *
 * @param bytes - The object's bytes.
 * @returns The object.
 * @throws When the bytes are not a boxed object.
 */
export function deserialize(bytes: Uint8Array): tl.TlObject {
	const object: unknown = new TlBinaryReader(__tlReaderMap, bytes).object();

	if (typeof object !== 'object' || object === null || !('_' in object)) {
		throw new TypeError('Expected a boxed TL object');
	}

	// The reader is untyped; a boxed value with a constructor name is a TL object.
	return object as tl.TlObject;
}

/**
 * Serializes a boxed `Vector` of TL objects.
 *
 * @param objects - The vector's entries.
 * @returns Its bytes.
 */
export function serializeVector(objects: readonly tl.TlObject[]): Uint8Array<ArrayBuffer> {
	const size = objects.reduce(
		(total, object) => total + TlSerializationCounter.countNeededBytes(__tlWriterMap, object),
		8,
	);
	const writer = TlBinaryWriter.alloc(__tlWriterMap, size);

	writer.vector(writer.object, [...objects]);

	return new Uint8Array(writer.result());
}

function isFileLocation(object: unknown): object is FileLocation {
	return (
		typeof object === 'object' &&
		object !== null &&
		'_' in object &&
		typeof object._ === 'string' &&
		FILE_LOCATIONS.has(object._)
	);
}

/**
 * Reads a boxed `InputFileLocation`, admitting only the constructors a request
 * may name, so the server can never point the session at any other kind of file.
 *
 * @param bytes - The locator's TL bytes.
 * @returns The location, or undefined when the bytes are anything else.
 */
export function decodeFileLocation(bytes: Uint8Array): FileLocation | undefined {
	const reader = new TlBinaryReader(__tlReaderMap, bytes);
	let location: unknown;

	try {
		location = reader.object();
	} catch (error) {
		logger.warn(`Failed to decode a file location: ${asError(error).message}`);

		return undefined;
	}

	// The reader never bounds-checks byte strings, so an overrun shows up as a position past the end.
	return reader.pos === bytes.length && isFileLocation(location) ? location : undefined;
}

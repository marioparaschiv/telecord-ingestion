import { z } from 'zod';

/** The values the vector placeholders stand for. */
export type VectorBindings = {
	min: number;
	max: number;
	key: string;
	foreignKey: string;
	unboundKey: string;
	/** The account id `{key}` is bound to: a number on Telegram, a snowflake string on Discord. */
	platformUserId: number | string;
	otherUserId: number | string;
	streamId: string;
};

const FrameSchema = z.object({
	op: z.string(),
	d: z.unknown().optional(),
	nonce: z.string().optional(),
	seq: z.number().optional(),
});

const ConnectVectorSchema = z.object({
	id: z.string(),
	kind: z.literal('connect'),
	description: z.string(),
	url: z.string(),
	expect: z.union([
		z.object({ status: z.number() }),
		z.object({ close: z.object({ code: z.number(), reason: z.string() }) }),
		z.object({ frame: FrameSchema }),
	]),
	chatsFetch: z.boolean().optional(),
});

const IdentifyVectorSchema = z.object({
	id: z.string(),
	kind: z.literal('identify'),
	description: z.string(),
	send: FrameSchema.optional(),
	expect: z.union([
		z.object({ close: z.object({ code: z.number(), reason: z.string() }) }),
		z.object({ chatsFetch: z.boolean() }),
		z.object({ frame: FrameSchema }),
	]),
});

const EventVectorSchema = z.object({
	id: z.string(),
	kind: z.literal('event'),
	description: z.string(),
	url: z.string().optional(),
	send: FrameSchema,
	outcome: z.enum(['accepted', 'refused', 'held']),
	expect: FrameSchema,
});

const RequestVectorSchema = z.object({
	id: z.string(),
	kind: z.literal('request'),
	description: z.string(),
	request: FrameSchema,
	reply: z.array(FrameSchema),
	outcome: z.enum(['accepted', 'refused']),
	chats: z.array(z.string()).optional(),
});

const StreamVectorSchema = z.object({
	id: z.string(),
	kind: z.literal('stream'),
	description: z.string(),
	steps: z.array(z.object({ send: FrameSchema, expect: FrameSchema })),
});

const VectorFileSchema = z.object({
	url: z.string(),
	identify: FrameSchema,
	vectors: z.array(
		z.discriminatedUnion('kind', [
			ConnectVectorSchema,
			IdentifyVectorSchema,
			EventVectorSchema,
			StreamVectorSchema,
			RequestVectorSchema,
		]),
	),
});

export type VectorFrame = z.output<typeof FrameSchema>;

export type ConnectVector = z.output<typeof ConnectVectorSchema>;

export type EventVector = z.output<typeof EventVectorSchema>;

export type RequestVector = z.output<typeof RequestVectorSchema>;

export type VectorFile = z.output<typeof VectorFileSchema>;

const PLACEHOLDER =
	/\{(min|max|min-1|max\+1|key|foreignKey|unboundKey|platformUserId|otherUserId|streamId)\}/g;

function placeholderValue(name: string, bindings: VectorBindings): string | number {
	switch (name) {
		case 'min-1':
			return bindings.min - 1;

		case 'max+1':
			return bindings.max + 1;

		case 'min':
		case 'max':
		case 'key':
		case 'foreignKey':
		case 'unboundKey':
		case 'platformUserId':
		case 'otherUserId':
		case 'streamId':
			return bindings[name];

		default:
			throw new Error(`Unknown vector placeholder {${name}}`);
	}
}

function isBytesPlaceholder(value: object): value is { $bytes: string } {
	return '$bytes' in value && typeof value.$bytes === 'string';
}

function materialize(value: unknown, bindings: VectorBindings): unknown {
	if (typeof value === 'string') {
		const whole = /^\{([^}]+)\}$/.exec(value);
		const single = whole?.[1] === undefined ? undefined : placeholderValue(whole[1], bindings);

		if (typeof single === 'number') {
			return single;
		}

		return value.replaceAll(PLACEHOLDER, (_match, name: string) =>
			String(placeholderValue(name, bindings)),
		);
	}

	if (Array.isArray(value)) {
		return value.map((entry) => materialize(entry, bindings));
	}

	if (typeof value !== 'object' || value === null) {
		return value;
	}

	if (isBytesPlaceholder(value)) {
		return new Uint8Array(Buffer.from(value.$bytes, 'base64'));
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, materialize(entry, bindings)]),
	);
}

/**
 * Reads a conformance vector file with its placeholders filled in: numeric
 * placeholders become numbers and `{ $bytes }` becomes a `Uint8Array`, the
 * shape a msgpack `bin` decodes to.
 *
 * @param file - The parsed JSON of a vector file.
 * @param bindings - The values the placeholders stand for.
 * @returns The vectors.
 */
export function loadVectors(file: unknown, bindings: VectorBindings): VectorFile {
	return VectorFileSchema.parse(materialize(file, bindings));
}

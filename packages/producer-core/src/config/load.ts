import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { z } from 'zod';

import createTaggedLogger from '../logger';
import asError from '../as-error';

declare module 'zod' {
	// oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface.
	interface GlobalMeta {
		/** The environment variable that overrides the setting. */
		env?: string;
		/** A credential: masked when shown, and never taken from a command-line flag. */
		secret?: boolean;
	}
}

/** Where compose mounts the install's `config.toml` in every producer container. */
export const CONFIG_FILE = '/config/config.toml';

const logger = createTaggedLogger('Config');

type ConfigTable = Record<string, unknown>;

/** A setting of a config schema: its key path under the producer's table and its metadata. */
export type ConfigField = {
	path: readonly string[];
	/** Merged from every wrapper of the setting's schema, the outermost winning. */
	meta: z.GlobalMeta;
	schema: z.core.$ZodType;
};

type LoadConfigOptions = {
	/** The producer's table in the file, e.g. `telegram`. */
	section: string;
	path?: string;
	env?: NodeJS.ProcessEnv;
};

function isTable(value: unknown): value is ConfigTable {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Date)
	);
}

/**
 * Strips defaults, optionals and pipes down to the schema the TOML value is
 * checked against. Zod keeps metadata on the exact instance `.meta()` returned,
 * so every layer's metadata is collected on the way in.
 */
function unwrap(schema: z.core.$ZodType): { inner: z.core.$ZodType; meta: z.GlobalMeta } {
	let inner = schema;
	let meta = { ...z.globalRegistry.get(inner) };

	while (
		inner instanceof z.ZodDefault ||
		inner instanceof z.ZodPrefault ||
		inner instanceof z.ZodOptional ||
		inner instanceof z.ZodPipe
	) {
		inner = inner instanceof z.ZodPipe ? inner.in : inner.unwrap();
		meta = { ...z.globalRegistry.get(inner), ...meta };
	}

	return { inner, meta };
}

/**
 * Every setting of a config schema, depth first: the leaves of its nested
 * tables, each with the key path and metadata (`env`, `description`) it declares.
 *
 * @param schema - A producer's config schema, or one of its tables.
 * @param path - The key path of `schema` itself.
 * @returns The settings.
 */
export function configFields(schema: z.core.$ZodType, path: readonly string[] = []): ConfigField[] {
	const { inner, meta } = unwrap(schema);

	if (!(inner instanceof z.ZodObject)) {
		return [{ path, meta, schema }];
	}

	return Object.entries(inner.shape).flatMap(([key, field]) =>
		configFields(field, [...path, key]),
	);
}

function unknownKeys(schema: z.core.$ZodType, value: unknown, path: readonly string[]): string[] {
	const { inner } = unwrap(schema);

	if (!(inner instanceof z.ZodObject) || !isTable(value)) {
		return [];
	}

	return Object.entries(value).flatMap(([key, child]) =>
		Object.hasOwn(inner.shape, key)
			? unknownKeys(inner.shape[key], child, [...path, key])
			: [[...path, key].join('.')],
	);
}

/**
 * Sets a setting, creating the tables on its path. Without a value it only
 * creates the missing tables, so an absent table reports each missing setting
 * rather than the table.
 */
function withValue(
	table: ConfigTable,
	[key, ...rest]: readonly string[],
	value: string | undefined,
): ConfigTable {
	if (key === undefined) {
		return table;
	}

	const child = table[key];

	if (rest.length === 0) {
		return value === undefined ? table : { ...table, [key]: value };
	}

	if (value === undefined && child !== undefined && !isTable(child)) {
		return table;
	}

	return { ...table, [key]: withValue(isTable(child) ? child : {}, rest, value) };
}

function readTable(path: string): ConfigTable {
	if (!existsSync(path)) {
		return {};
	}

	try {
		return parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new Error(`Failed to read ${path}: ${asError(error).message}`);
	}
}

function describeIssue(section: string, fields: readonly ConfigField[], issue: z.core.$ZodIssue) {
	const field = fields.find(({ path }) => path.every((key, index) => issue.path[index] === key));
	const where = issue.path.reduce<string>(
		(text, key) => (typeof key === 'number' ? `${text}[${key}]` : `${text}.${String(key)}`),
		section,
	);
	const env = field?.meta.env;

	return `${where}${env === undefined ? '' : ` (${env})`}: ${issue.message}`;
}

/**
 * Reads a producer's settings from its table in `config.toml`, with each
 * setting's environment variable overriding the file and the schema's default
 * filling what neither sets. A missing file leaves the environment and
 * defaults. Keys the schema does not know are logged and ignored.
 *
 * @param schema - The producer's config schema, its settings declaring their variables with `.meta({ env })`.
 * @param options - The producer's table, the file and the environment to read.
 * @returns The parsed settings.
 * @throws When the file cannot be read or parsed, or a setting is missing or invalid, naming
 * each offending setting by its TOML path and variable.
 */
export function loadConfig<Schema extends z.ZodObject>(
	schema: Schema,
	{ section, path = CONFIG_FILE, env = process.env }: LoadConfigOptions,
): z.output<Schema> {
	const file = readTable(path)[section] ?? {};

	if (!isTable(file)) {
		throw new Error(`Failed to read ${path}: ${section} is not a table`);
	}

	for (const key of unknownKeys(schema, file, [section])) {
		logger.warn(`Ignoring the unknown key ${key} in ${path}`);
	}

	const fields = configFields(schema);
	const input = fields.reduce(
		(table, { path: fieldPath, meta }) =>
			withValue(table, fieldPath, meta.env === undefined ? undefined : env[meta.env]),
		file,
	);
	const parsed = schema.safeParse(input);

	if (parsed.success) {
		return parsed.data;
	}

	const issues = parsed.error.issues
		.map((issue) => `  ${describeIssue(section, fields, issue)}`)
		.join('\n');

	throw new Error(`Missing or invalid settings in ${path} or the environment:\n${issues}`);
}

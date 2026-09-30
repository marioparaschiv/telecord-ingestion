import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';

import { isTable } from './config-file';

type TomlTable = Record<string, unknown>;

type Pair = {
	/** The full key path: the section's path, then the pair's dotted key. */
	path: readonly string[];
	start: number;
	/** Past the pair's line, its trailing comment and newline included. */
	end: number;
	valueStart: number;
	valueEnd: number;
};

type Section = {
	path: readonly string[];
	/** An array-of-tables entry, `[[path]]`. */
	array: boolean;
	start: number;
	/** Past the header's line, or the start of the file for the root section. */
	headerEnd: number;
	pairs: Pair[];
};

type Edit = { start: number; end: number; text: string };

const BARE_KEY = /^[\w-]+$/;
const BARE_KEY_CHARS = /[\w-]+/y;
const LOCAL_DATE_WITH_SPACE = /\d{4}-\d{2}-\d{2} (?=\d{2}:)/y;
const BARE_VALUE = /[^\s,\]}#]*/y;

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
	return prefix.length <= path.length && prefix.every((key, index) => path[index] === key);
}

function withValue(table: TomlTable, [key, ...rest]: readonly string[], value: unknown): TomlTable {
	if (key === undefined) {
		return table;
	}

	if (rest.length === 0) {
		return { ...table, [key]: value };
	}

	const child = table[key];

	return { ...table, [key]: withValue(isTable(child) ? child : {}, rest, value) };
}

/** Copies parsed tables, which have no prototype, onto plain objects so they compare equal to built ones. */
function plain(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(plain);
	}

	if (isTable(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
	}

	return value;
}

/** Puts a round-tripped value's keys back in the caller's order, which stringify moves subtables behind. */
function inKeyOrder(original: unknown, normalized: unknown): unknown {
	if (Array.isArray(original) && Array.isArray(normalized)) {
		return normalized.map((item, index) => inKeyOrder(original[index], item));
	}

	if (!isTable(original) || !isTable(normalized)) {
		return normalized;
	}

	return Object.fromEntries(
		Object.keys(original)
			.filter((key) => Object.hasOwn(normalized, key))
			.map((key) => [key, inKeyOrder(original[key], normalized[key])]),
	);
}

function renderKey(path: readonly string[]): string {
	return path.map((key) => (BARE_KEY.test(key) ? key : JSON.stringify(key))).join('.');
}

/** A table whose values are all scalars, which reads well as one inline table. */
function isFlatTable(value: unknown): value is TomlTable {
	return (
		isTable(value) &&
		Object.values(value).every((child) => !isTable(child) && !Array.isArray(child))
	);
}

/** A list of flat tables, such as a `forward.allow` list, written inline with one entry per line. */
function isFlatTableList(value: unknown): value is TomlTable[] {
	return Array.isArray(value) && value.length > 0 && value.every((item) => isFlatTable(item));
}

function renderInlineTable(table: TomlTable, eol: string): string {
	const pairs = Object.entries(table).map(
		([key, child]) => `${renderKey([key])} = ${renderValue(child, eol)}`,
	);

	return pairs.length === 0 ? '{}' : `{ ${pairs.join(', ')} }`;
}

function renderValue(value: unknown, eol: string): string {
	if (isFlatTableList(value)) {
		return ['[', ...value.map((item) => `\t${renderInlineTable(item, eol)},`), ']'].join(eol);
	}

	return stringify({ value }).slice('value = '.length).trimEnd();
}

/** Whether a value is written as `[table]` or `[[array]]` sections rather than a `key = value` line. */
function isSectioned(value: unknown): boolean {
	return (
		isTable(value) ||
		(Array.isArray(value) &&
			value.length > 0 &&
			value.every((item) => isTable(item)) &&
			!isFlatTableList(value))
	);
}

/** Writes a table as its `[path]` section, then its subtables' sections. */
function renderSections(path: readonly string[], value: unknown, eol: string): string {
	if (!isTable(value)) {
		return stringify(withValue({}, path, value))
			.trimEnd()
			.replaceAll('\n', eol);
	}

	const entries = Object.entries(value);
	const lines = entries
		.filter(([, child]) => !isSectioned(child))
		.map(([key, child]) => `${renderKey([key])} = ${renderValue(child, eol)}`);
	const subtables = entries
		.filter(([, child]) => isSectioned(child))
		.map(([key, child]) => renderSections([...path, key], child, eol));
	const own =
		lines.length > 0 || subtables.length === 0
			? [[`[${renderKey(path)}]`, ...lines].join(eol)]
			: [];

	return [...own, ...subtables].join(eol + eol);
}

/** Reads the source a statement at a time, knowing only enough TOML to find where each one ends. */
class Scanner {
	private index = 0;

	constructor(private readonly source: string) {}

	scan(): Section[] {
		let section: Section = { path: [], array: false, start: 0, headerEnd: 0, pairs: [] };
		const sections = [section];

		for (this.skipBlank(); this.index < this.source.length; this.skipBlank()) {
			const start = this.source.lastIndexOf('\n', this.index - 1) + 1;

			if (this.source[this.index] !== '[') {
				const key = this.key();

				this.expect('=');
				this.skipSpaces();

				const valueStart = this.index;

				this.value();

				const valueEnd = this.index;

				this.lineEnd();
				section.pairs.push({
					path: [...section.path, ...key],
					start,
					end: this.index,
					valueStart,
					valueEnd,
				});

				continue;
			}

			const array = this.source.startsWith('[[', this.index);

			this.index += array ? 2 : 1;

			const path = this.key();

			this.expect(array ? ']]' : ']');
			this.lineEnd();
			section = { path, array, start, headerEnd: this.index, pairs: [] };
			sections.push(section);
		}

		return sections;
	}

	private fail(expected: string): never {
		throw new Error(`Failed to read TOML at offset ${this.index}: expected ${expected}`);
	}

	private expect(token: string): void {
		this.skipSpaces();

		if (!this.source.startsWith(token, this.index)) {
			this.fail(token);
		}

		this.index += token.length;
	}

	private skipSpaces(): void {
		while (this.source[this.index] === ' ' || this.source[this.index] === '\t') {
			this.index++;
		}
	}

	private skipComment(): void {
		if (this.source[this.index] !== '#') {
			return;
		}

		const newline = this.source.indexOf('\n', this.index);

		this.index = newline === -1 ? this.source.length : newline;
	}

	private skipBlank(): void {
		for (;;) {
			this.skipSpaces();
			this.skipComment();

			if (this.source[this.index] === '\r' && this.source[this.index + 1] === '\n') {
				this.index += 2;
			} else if (this.source[this.index] === '\n') {
				this.index++;
			} else {
				return;
			}
		}
	}

	/** Moves past the rest of the line: spaces, a comment and the newline. */
	private lineEnd(): void {
		this.skipSpaces();
		this.skipComment();

		if (this.source.startsWith('\r\n', this.index)) {
			this.index += 2;
		} else if (this.source[this.index] === '\n') {
			this.index++;
		}
	}

	private key(): string[] {
		const keys: string[] = [];

		for (;;) {
			this.skipSpaces();

			const start = this.index;
			const quote = this.source[this.index];

			if (quote === '"' || quote === "'") {
				this.string(quote);
				keys.push(parse(`key = ${this.source.slice(start, this.index)}`).key as string);
			} else {
				BARE_KEY_CHARS.lastIndex = this.index;

				const match = BARE_KEY_CHARS.exec(this.source) ?? this.fail('a key');

				this.index += match[0].length;
				keys.push(match[0]);
			}

			this.skipSpaces();

			if (this.source[this.index] !== '.') {
				return keys;
			}

			this.index++;
		}
	}

	private string(quote: '"' | "'"): void {
		const multiline = this.source.startsWith(quote.repeat(3), this.index);
		const delimiter = multiline ? quote.repeat(3) : quote;

		this.index += delimiter.length;

		while (!this.source.startsWith(delimiter, this.index)) {
			if (this.index >= this.source.length) {
				this.fail(delimiter);
			}

			this.index += quote === '"' && this.source[this.index] === '\\' ? 2 : 1;
		}

		this.index += delimiter.length;

		// A multiline string may end in up to two quotes of its own before the delimiter.
		for (let extra = 0; multiline && extra < 2 && this.source[this.index] === quote; extra++) {
			this.index++;
		}
	}

	private value(): void {
		const first = this.source[this.index];

		if (first === '"' || first === "'") {
			this.string(first);

			return;
		}

		if (first === '[' || first === '{') {
			this.nested();

			return;
		}

		LOCAL_DATE_WITH_SPACE.lastIndex = this.index;

		if (LOCAL_DATE_WITH_SPACE.test(this.source)) {
			this.index = LOCAL_DATE_WITH_SPACE.lastIndex;
		}

		BARE_VALUE.lastIndex = this.index;
		this.index += BARE_VALUE.exec(this.source)?.[0].length ?? 0;
	}

	/** Moves past an array or inline table, which may nest and span lines. */
	private nested(): void {
		let depth = 0;

		do {
			const char = this.source[this.index];

			if (char === undefined) {
				this.fail('] or }');
			}

			if (char === '"' || char === "'") {
				this.string(char);
				continue;
			}

			if (char === '#') {
				this.skipComment();
				continue;
			}

			if (char === '[' || char === '{') {
				depth++;
			} else if (char === ']' || char === '}') {
				depth--;
			}

			this.index++;
		} while (depth > 0);
	}
}

/** The end of a statement together with the blank lines after it, so removing it leaves no gap. */
function withBlankLines(source: string, end: number): number {
	const blank = /(?:[ \t]*\r?\n)*/y;

	blank.lastIndex = end;
	blank.exec(source);

	return blank.lastIndex;
}

function sectionEnd(section: Section): number {
	return section.pairs.at(-1)?.end ?? section.headerEnd;
}

/**
 * Inserts sections at a position, set apart from their neighbours by a blank
 * line. `contextEnd` is where the text after them resumes once a removal at
 * the same position is applied.
 */
function sectionsBlock(
	source: string,
	position: number,
	contextEnd: number,
	rendered: string,
	eol: string,
): Edit {
	const before = source.slice(0, position);
	const after = source.slice(contextEnd);
	const separated = before === '' || /\n[ \t]*\r?\n$/.test(before);
	const leading = separated ? '' : before.endsWith('\n') ? eol : eol + eol;
	const trailing = after === '' || /^[ \t]*\r?\n/.test(after) ? '' : eol;

	return { start: position, end: position, text: `${leading}${rendered}${eol}${trailing}` };
}

function pairLine(source: string, position: number, line: string, eol: string): Edit {
	const leading = position === 0 || source[position - 1] === '\n' ? '' : eol;

	return { start: position, end: position, text: `${leading}${line}${eol}` };
}

/** Applies edits from the end of the source back, a removal before an insertion at the same position. */
function applyEdits(source: string, edits: readonly Edit[]): string {
	return edits
		.toSorted((left, right) => right.start - left.start || right.end - left.end)
		.reduce(
			(text, { start, end, text: replacement }) =>
				text.slice(0, start) + replacement + text.slice(end),
			source,
		);
}

/**
 * Where the new value goes once the lines that defined it are removed: a line
 * in the section of its table, or new sections where the old ones began or
 * after the last section of the same top-level table.
 */
function insertion(
	source: string,
	sections: readonly Section[],
	path: readonly string[],
	value: unknown,
	anchor: Edit | undefined,
	eol: string,
): Edit {
	const parent = path.slice(0, -1);

	if (!isSectioned(value)) {
		const home =
			sections.find((section) => !section.array && isDeepStrictEqual(section.path, parent)) ??
			sections.find(
				(section) =>
					!section.array &&
					section.path.length < parent.length &&
					startsWith(parent, section.path) &&
					section.pairs.some(
						(pair) => pair.path.length > parent.length && startsWith(pair.path, parent),
					),
			);

		if (home) {
			const line = `${renderKey(path.slice(home.path.length))} = ${renderValue(value, eol)}`;

			return pairLine(source, sectionEnd(home), line, eol);
		}
	}

	const rendered = isSectioned(value)
		? renderSections(path, value, eol)
		: renderSections(parent, withValue({}, path.slice(-1), value), eol);

	if (anchor) {
		return sectionsBlock(source, anchor.start, anchor.end, rendered, eol);
	}

	const related = sections.filter((section) => section.path[0] === path[0]).at(-1);
	const position = related ? sectionEnd(related) : source.length;

	return sectionsBlock(source, position, position, rendered, eol);
}

/**
 * Sets one key or table of a TOML document, leaving every other line as it
 * was: comments, ordering, spacing and line endings. A key that exists keeps
 * its line and trailing comment and has only its value replaced. A table, or
 * an array of tables, replaces every line that defined it and is written as
 * `[path]` or `[[path]]` sections where the old definition began. A list of
 * tables holding only scalars is written instead as an inline array, one table
 * per line, so it stays easy to edit by hand. Anything new goes beside the
 * section it belongs to.
 *
 * @param source - The document.
 * @param path - The key path, e.g. `['telegram', 'ingest', 'url']` or `['telegram', 'forward']`.
 * @param value - Its new value, any value TOML can hold.
 * @returns The edited document.
 * @throws When the document is not valid TOML, or the key cannot be set without rewriting
 * other lines, such as a key inside an inline table.
 *
 * @example
 * setTomlValue('[telegram] # mine\napi_id = 1\n', ['telegram', 'api_id'], 2);
 * // '[telegram] # mine\napi_id = 2\n'
 */
function setTomlValue(source: string, path: readonly string[], value: unknown): string {
	if (path.length === 0) {
		throw new Error('Failed to set a TOML value: the key path is empty');
	}

	const normalized = inKeyOrder(value, parse(stringify({ value })).value);
	const expected = withValue(parse(source), path, normalized);
	const eol = source.includes('\r\n') ? '\r\n' : '\n';
	const sections = new Scanner(source).scan();
	const existing = sections
		.flatMap((section) => section.pairs)
		.filter((pair) => startsWith(pair.path, path));
	const [only] = existing;
	let edits: Edit[];

	if (existing.length === 1 && only?.path.length === path.length && !isSectioned(normalized)) {
		edits = [
			{ start: only.valueStart, end: only.valueEnd, text: renderValue(normalized, eol) },
		];
	} else {
		const removed = sections.filter((section) => startsWith(section.path, path));
		const sectionRemovals = removed.map((section) => ({
			start: section.start,
			end: withBlankLines(source, sectionEnd(section)),
			text: '',
		}));
		const pairRemovals = existing
			.filter((pair) => !removed.some((section) => section.pairs.includes(pair)))
			.map((pair) => ({ start: pair.start, end: pair.end, text: '' }));

		edits = [
			...sectionRemovals,
			...pairRemovals,
			insertion(source, sections, path, normalized, sectionRemovals[0], eol),
		];
	}

	const edited = applyEdits(source, edits);
	const failure = `Failed to set ${path.join('.')} without rewriting other lines of the file`;
	let result: unknown;

	try {
		result = parse(edited);
	} catch (error) {
		throw new Error(failure, { cause: error });
	}

	if (!isDeepStrictEqual(plain(result), plain(expected))) {
		throw new Error(failure);
	}

	return edited;
}

export default setTomlValue;

// Writes the settings reference into README.md between its markers, or with --check fails when it is stale.
import { readFile, writeFile } from 'node:fs/promises';

import { platformSettings, type Setting } from '../src/settings';
import PLATFORMS from '../src/platforms';

const README = `${import.meta.dir}/../../README.md`;
const START = '<!-- settings:start -->';
const END = '<!-- settings:end -->';

function code(text: string): string {
	return `\`${text}\``;
}

function defaultOf(setting: Setting): string {
	if (setting.required) {
		return setting.suggestion === undefined
			? 'required'
			: `required, setup offers ${code(setting.suggestion)}`;
	}

	return setting.defaultValue === undefined ? 'unset' : code(String(setting.defaultValue));
}

function setupOf(setting: Setting): string {
	return setting.flag === undefined
		? `${code(setting.env)} or the prompt`
		: `${code(setting.flag)}, ${code(setting.env)}`;
}

function table(rows: readonly (readonly string[])[]): string {
	const widths = rows[0]?.map((_, column) =>
		Math.max(...rows.map((row) => row[column]?.length ?? 0)),
	);
	const line = (cells: readonly string[]) =>
		`| ${cells.map((cell, column) => cell.padEnd(widths?.[column] ?? 0)).join(' | ')} |`;
	const [header = [], ...body] = rows;

	return [
		line(header),
		line(header.map((_, column) => '-'.repeat(widths?.[column] ?? 0))),
		...body.map(line),
	].join('\n');
}

function settingsReference(): string {
	return PLATFORMS.map((platform) => {
		const rows = platformSettings(platform).map((setting) => [
			code(setting.key),
			setting.meta.env === undefined ? '' : code(setting.meta.env),
			setupOf(setting),
			defaultOf(setting),
			(setting.meta.description ?? '').replaceAll('|', String.raw`\|`),
		]);

		return `**${platform.label}**\n\n${table([
			['Key', 'Producer variable', 'Setup flag and variable', 'Default', 'Meaning'],
			...rows,
		])}`;
	}).join('\n\n');
}

const readme = await readFile(README, 'utf8');
const start = readme.indexOf(START);
const end = readme.indexOf(END);

if (start === -1 || end < start) {
	throw new Error(`Failed to update ${README}: it has no ${START} ... ${END} markers`);
}

const updated = `${readme.slice(0, start + START.length)}\n\n${settingsReference()}\n\n${readme.slice(end)}`;

if (process.argv.includes('--check')) {
	if (updated !== readme) {
		console.error('README.md has a stale settings reference: run pnpm readme');
		process.exit(1);
	}
} else {
	await writeFile(README, updated);
}

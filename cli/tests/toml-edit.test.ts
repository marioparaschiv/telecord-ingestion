import { describe, expect, it } from 'vitest';

import setTomlValue from '../src/toml-edit';

const CONFIG = `# Telecord ingestion
[telegram]  # my account
api_id = 123   # from my.telegram.org
api_hash = "abc"

# Where events go
[telegram.ingest]
url = "wss://ingest.telecord.app/telegram/v1"
api_key = 'key' # rotated monthly

[[telegram.filter.rules]]
action = "deny" # no DMs
peerType = "user"

[[telegram.filter.rules]]
action = "allow"
peerId = ["-1001", "-1002"]

[discord]
token = """
multi"""
data_dir = "/data"
`;

describe('setTomlValue', () => {
	it('replaces only the value of an existing key', () => {
		expect(setTomlValue(CONFIG, ['telegram', 'api_id'], 456)).toBe(
			CONFIG.replace('api_id = 123 ', 'api_id = 456 '),
		);
		expect(setTomlValue(CONFIG, ['telegram', 'ingest', 'api_key'], 'new')).toBe(
			CONFIG.replace(`api_key = 'key'`, 'api_key = "new"'),
		);
		expect(setTomlValue(CONFIG, ['discord', 'token'], 'plain')).toBe(
			CONFIG.replace('"""\nmulti"""', '"plain"'),
		);
	});

	it('adds a key at the end of its table', () => {
		expect(setTomlValue(CONFIG, ['telegram', 'ingest', 'window'], 100)).toBe(
			CONFIG.replace(
				`api_key = 'key' # rotated monthly\n`,
				`api_key = 'key' # rotated monthly\nwindow = 100\n`,
			),
		);
	});

	it('adds a table after the last section of its top-level table', () => {
		expect(setTomlValue(CONFIG, ['discord', 'ingest', 'url'], 'wss://d')).toBe(
			`${CONFIG}\n[discord.ingest]\nurl = "wss://d"\n`,
		);
		expect(setTomlValue(CONFIG, ['telegram', 'forward'], { dms: true })).toBe(
			CONFIG.replace(
				'peerId = ["-1001", "-1002"]\n',
				'peerId = ["-1001", "-1002"]\n\n[telegram.forward]\ndms = true\n',
			),
		);
	});

	it('gives a table only its subtables defined a section of its own', () => {
		expect(setTomlValue('[telegram.ingest]\nurl = "u"\n', ['telegram', 'api_id'], 1)).toBe(
			'[telegram.ingest]\nurl = "u"\n\n[telegram]\napi_id = 1\n',
		);
	});

	it('builds a file from nothing', () => {
		const withToken = setTomlValue('', ['discord', 'token'], 't');
		const withUrl = setTomlValue(withToken, ['discord', 'ingest', 'url'], 'wss://d');

		expect(withUrl).toBe('[discord]\ntoken = "t"\n\n[discord.ingest]\nurl = "wss://d"\n');
	});

	it('replaces an array of tables in place, keeping the comments around it', () => {
		const rules = [{ action: 'allow', peerId: ['-1'] }];

		expect(setTomlValue(CONFIG, ['telegram', 'filter', 'rules'], rules)).toBe(
			CONFIG.replace(
				/\[\[telegram\.filter\.rules\]\][\s\S]*?(?=\[discord\])/,
				'[[telegram.filter.rules]]\naction = "allow"\npeerId = [ "-1" ]\n\n',
			),
		);
	});

	it('writes a list of flat tables inline, one per line, in place of its sections', () => {
		const rules = [
			{ action: 'deny', peerType: 'user' },
			{ action: 'allow', peerType: 'channel' },
		];

		expect(setTomlValue(CONFIG, ['telegram', 'filter', 'rules'], rules)).toBe(
			CONFIG.replace(
				/\[\[telegram\.filter\.rules\]\][\s\S]*?(?=\[discord\])/,
				'[telegram.filter]\nrules = [\n\t{ action = "deny", peerType = "user" },\n\t{ action = "allow", peerType = "channel" },\n]\n\n',
			),
		);
	});

	it('writes a forward table with its lists inline, replacing an inline list in place', () => {
		const forward = {
			default: 'deny',
			dms: false,
			allow: [{ id: '-1001', name: 'News' }],
			deny: [],
		};
		const written = setTomlValue(CONFIG, ['telegram', 'forward'], forward);
		const section =
			'[telegram.forward]\ndefault = "deny"\ndms = false\nallow = [\n\t{ id = "-1001", name = "News" },\n]\ndeny = []\n';

		expect(written).toBe(
			CONFIG.replace(
				'peerId = ["-1001", "-1002"]\n',
				`peerId = ["-1001", "-1002"]\n\n${section}`,
			),
		);
		expect(
			setTomlValue(written, ['telegram', 'forward', 'allow'], [{ id: '1' }, { id: '2' }]),
		).toBe(
			written.replace(
				'\t{ id = "-1001", name = "News" },\n',
				'\t{ id = "1" },\n\t{ id = "2" },\n',
			),
		);
	});

	it('replaces an array of tables with an empty list where it was', () => {
		expect(setTomlValue(CONFIG, ['telegram', 'filter', 'rules'], [])).toBe(
			CONFIG.replace(
				/\[\[telegram\.filter\.rules\]\][\s\S]*?(?=\[discord\])/,
				'[telegram.filter]\nrules = []\n\n',
			),
		);
	});

	it('adds a key beside the dotted keys that define its table', () => {
		const source = '[discord]\ntoken = "t"\ningest.url = "u"\n';

		expect(setTomlValue(source, ['discord', 'ingest', 'api_key'], 'k')).toBe(
			`${source}ingest.api_key = "k"\n`,
		);
	});

	it('moves a table defined by dotted keys into its own section after its table', () => {
		const source =
			'[discord]\ntoken = "t"\nforward.dms = false # hide DMs\nforward.default = "deny"\n\n# kept\n[discord.ingest]\nurl = "wss://d"\n';

		expect(setTomlValue(source, ['discord', 'forward'], { allow: [{ id: '1' }] })).toBe(
			'[discord]\ntoken = "t"\n\n# kept\n[discord.ingest]\nurl = "wss://d"\n\n[discord.forward]\nallow = [\n\t{ id = "1" },\n]\n',
		);
	});

	it('replaces the [[...]] sections of a forward list with the inline form', () => {
		const source =
			'[telegram.forward]\ndefault = "deny"\n\n[[telegram.forward.allow]]\nid = "1"\nname = "One"\n\n[discord]\ntoken = "t"\n';

		expect(
			setTomlValue(source, ['telegram', 'forward'], {
				default: 'deny',
				allow: [{ id: '2', name: 'Two' }],
			}),
		).toBe(
			'[telegram.forward]\ndefault = "deny"\nallow = [\n\t{ id = "2", name = "Two" },\n]\n\n[discord]\ntoken = "t"\n',
		);
	});

	it('keeps CRLF line endings', () => {
		const source = '[discord]\r\ntoken = "t"\r\n';

		expect(setTomlValue(source, ['discord', 'data_dir'], '/d')).toBe(
			'[discord]\r\ntoken = "t"\r\ndata_dir = "/d"\r\n',
		);
		expect(setTomlValue(source, ['discord', 'ingest', 'url'], 'u')).toBe(
			'[discord]\r\ntoken = "t"\r\n\r\n[discord.ingest]\r\nurl = "u"\r\n',
		);
		expect(setTomlValue(source, ['discord', 'forward'], { allow: [{ channel: '1' }] })).toBe(
			'[discord]\r\ntoken = "t"\r\n\r\n[discord.forward]\r\nallow = [\r\n\t{ channel = "1" },\r\n]\r\n',
		);
	});

	it('refuses a key inside an inline table rather than rewriting it', () => {
		expect(() =>
			setTomlValue(
				'[discord]\ningest = { url = "u" }\n',
				['discord', 'ingest', 'api_key'],
				'k',
			),
		).toThrow('Failed to set discord.ingest.api_key without rewriting other lines of the file');
	});

	it('rejects a file that is not TOML', () => {
		expect(() => setTomlValue('[discord\n', ['discord', 'token'], 't')).toThrow();
	});
});

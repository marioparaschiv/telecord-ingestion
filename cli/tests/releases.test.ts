import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';

import {
	checkForUpdate,
	downloadAsset,
	fetchReleases,
	latestCliRelease,
	releasesUrl,
	type Release,
} from '../src/releases';

function release(tag: string, flags: Partial<Pick<Release, 'draft' | 'prerelease'>> = {}): Release {
	return {
		tag_name: tag,
		draft: false,
		prerelease: false,
		assets: [
			{
				name: 'checksums.txt',
				browser_download_url: `https://github.com/marioparaschiv/telecord-ingestion/releases/download/${tag}/checksums.txt`,
			},
		],
		...flags,
	};
}

describe('latestCliRelease', () => {
	it('takes the newest stable CLI release, skipping drafts, pre-releases and other tags', () => {
		const latest = latestCliRelease([
			release('cli-v1.3.0', { draft: true }),
			release('cli-v1.3.0-rc.1', { prerelease: true }),
			release('telegram-v2.0.0'),
			release('cli-vnext'),
			release('cli-v1.2.0'),
			release('cli-v1.1.0'),
		]);

		expect(latest?.tag_name).toBe('cli-v1.2.0');
		expect(latest?.version).toBe('1.2.0');
	});

	it('finds nothing without a stable CLI release', () => {
		expect(
			latestCliRelease([release('cli-v1.0.0-rc.1', { prerelease: true })]),
		).toBeUndefined();
	});
});

describe('checkForUpdate', () => {
	const releases = [release('cli-v1.2.0'), release('cli-v1.1.0')];

	it.each(['1.1.0', '1.2.0-rc.1'])('offers %s the latest release', (current) => {
		expect(checkForUpdate(releases, current)).toMatchObject({
			status: 'available',
			latest: { version: '1.2.0' },
		});
	});

	it.each(['1.2.0', '1.3.0-rc.1'])('keeps %s', (current) => {
		expect(checkForUpdate(releases, current).status).toBe('current');
	});

	it('reports when no stable CLI release exists', () => {
		expect(checkForUpdate([release('telegram-v1.0.0')], '0.1.0')).toEqual({
			status: 'unreleased',
		});
	});
});

describe('releasesUrl', () => {
	it('defaults to the GitHub API', () => {
		expect(releasesUrl(undefined)).toBe(
			'https://api.github.com/repos/marioparaschiv/telecord-ingestion/releases',
		);
	});

	it('rejects an override that is not an HTTP(S) URL', () => {
		expect(() => releasesUrl('file:///tmp/releases')).toThrow(
			'TELECORD_INGESTION_RELEASES is not an HTTP(S) URL',
		);
	});
});

describe('the GitHub API', () => {
	let base: string;
	const server = createServer((request, response) => {
		if (request.url === '/releases?per_page=100') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify([
					{
						...release('cli-v1.0.0'),
						assets: [
							{
								name: 'checksums.txt',
								browser_download_url: `${base}/download/cli-v1.0.0/checksums.txt`,
							},
						],
						html_url:
							'https://github.com/marioparaschiv/telecord-ingestion/releases/tag/cli-v1.0.0',
					},
				]),
			);

			return;
		}

		if (request.url === '/download/cli-v1.0.0/checksums.txt') {
			response.writeHead(200).end('listing');

			return;
		}

		if (request.url === '/broken/releases?per_page=100') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ message: 'Moved Permanently' }));

			return;
		}

		response.writeHead(404).end();
	});

	beforeAll(async () => {
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

		const address = server.address();

		if (address === null || typeof address === 'string') {
			throw new Error('Release server is not listening on a TCP port');
		}

		base = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	it('lists releases and downloads their assets', async () => {
		const [listed] = await fetchReleases(`${base}/releases`);

		expect(listed.tag_name).toBe('cli-v1.0.0');
		expect(new TextDecoder().decode(await downloadAsset(listed, 'checksums.txt'))).toBe(
			'listing',
		);
	});

	it('rejects a response that is not a release list', async () => {
		await expect(fetchReleases(`${base}/broken/releases`)).rejects.toThrow(
			'Failed to read the release list',
		);
	});

	it('fails on an error status', async () => {
		await expect(fetchReleases(`${base}/missing/releases`)).rejects.toThrow('HTTP 404');
	});

	it('fails on an asset the release does not have', async () => {
		await expect(downloadAsset(release('cli-v1.0.0'), 'checksums.sig')).rejects.toThrow(
			'Release cli-v1.0.0 has no asset named checksums.sig',
		);
	});
});

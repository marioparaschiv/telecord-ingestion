import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchClientBuild } from '../src/client';

/** Answers the pages the build lookup reads, as Discord serves them. */
function serveDiscord(manifest: object) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = String(input);

		if (url === 'https://discord.com/app') {
			return new Response(
				'<script src="/assets/web.a1b2c3.js"></script><script src="/assets/web.d4e5f6.js"></script>',
			);
		}

		if (url === 'https://discord.com/assets/web.d4e5f6.js') {
			return new Response('var e=parseInt("441529",10);');
		}

		if (url.startsWith('https://updates.discord.com/distributions/app/manifests/latest')) {
			return Response.json(manifest);
		}

		return new Response('', { status: 404 });
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('fetchClientBuild', () => {
	it("reads the desktop client's web and native builds from Discord", async () => {
		serveDiscord({ metadata_version: 71_839, full: { host_version: [1, 0, 9227] } });

		await expect(fetchClientBuild()).resolves.toEqual({
			clientBuildNumber: 441_529,
			clientVersion: '1.0.9227',
			nativeBuildNumber: 71_839,
		});
	});

	it('refuses to make up a build Discord does not name', async () => {
		serveDiscord({ full: {} });

		await expect(fetchClientBuild()).rejects.toThrow();
	});
});

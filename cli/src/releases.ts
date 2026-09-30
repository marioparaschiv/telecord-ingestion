import semver from 'semver';
import { z } from 'zod';

const TAG_PREFIX = 'cli-v';

const DEFAULT_RELEASES_URL =
	'https://api.github.com/repos/marioparaschiv/telecord-ingestion/releases';

export const ReleaseSchema = z.object({
	tag_name: z.string(),
	draft: z.boolean(),
	prerelease: z.boolean(),
	assets: z.array(z.object({ name: z.string(), browser_download_url: z.url() })),
});

export type Release = z.infer<typeof ReleaseSchema>;

/** A stable CLI release, with the version its tag names. */
export type CliRelease = Release & { version: string };

/**
 * Picks the latest stable CLI release, skipping drafts, pre-releases and the
 * releases of anything else. Like GitHub's own "latest", that is the newest
 * one published, so the install scripts can agree on it without a semver sort.
 *
 * @param releases - The releases, newest first, as GitHub lists them.
 * @returns The release, or undefined when there is no stable CLI release.
 */
export function latestCliRelease(releases: readonly Release[]): CliRelease | undefined {
	for (const release of releases) {
		if (release.draft || release.prerelease || !release.tag_name.startsWith(TAG_PREFIX)) {
			continue;
		}

		const version = semver.valid(release.tag_name.slice(TAG_PREFIX.length));

		if (version !== null) {
			return { ...release, version };
		}
	}

	return undefined;
}

/** Whether a newer stable CLI release than the running one exists. */
export type UpdateCheck =
	| { status: 'unreleased' }
	| { status: 'current'; latest: CliRelease }
	| { status: 'available'; latest: CliRelease };

/**
 * Compares the running version with the latest stable CLI release. A newer
 * running version, such as a pre-release, counts as current rather than
 * downgrading.
 *
 * @param releases - The releases, newest first, as GitHub lists them.
 * @param current - The running version.
 * @returns The latest release and whether it is an update.
 */
export function checkForUpdate(releases: readonly Release[], current: string): UpdateCheck {
	const latest = latestCliRelease(releases);

	if (!latest) {
		return { status: 'unreleased' };
	}

	return { status: semver.gt(latest.version, current) ? 'available' : 'current', latest };
}

/**
 * Reads the releases API endpoint, which `TELECORD_INGESTION_RELEASES` overrides
 * to test against a fake release.
 *
 * @param value - The override, if any.
 * @returns The endpoint.
 * @throws When the override is not an HTTP(S) URL.
 */
export function releasesUrl(value = process.env.TELECORD_INGESTION_RELEASES): string {
	if (value === undefined) {
		return DEFAULT_RELEASES_URL;
	}

	if (!z.url({ protocol: /^https?$/ }).safeParse(value).success) {
		throw new Error(`TELECORD_INGESTION_RELEASES is not an HTTP(S) URL: ${value}`);
	}

	return value;
}

/**
 * Fetches a URL, failing on any status but success.
 *
 * @param url - The URL.
 * @param what - What is fetched, for the error message.
 * @param headers - Headers besides the user agent GitHub requires.
 * @returns The successful response.
 * @throws When the request fails or answers with an error status.
 */
async function request(
	url: string,
	what: string,
	headers: Record<string, string> = {},
): Promise<Response> {
	const response = await fetch(url, {
		headers: { ...headers, 'User-Agent': 'telecord-ingestion' },
	});

	if (!response.ok) {
		await response.body?.cancel();

		throw new Error(`Failed to download ${what} from ${url}: HTTP ${response.status}`);
	}

	return response;
}

/**
 * Lists the repository's most recent releases.
 *
 * @param url - The GitHub releases API endpoint.
 * @returns The releases, newest first.
 * @throws When the request fails or the response is not a release list.
 */
export async function fetchReleases(url = releasesUrl()): Promise<Release[]> {
	const response = await request(`${url}?per_page=100`, 'the release list', {
		Accept: 'application/vnd.github+json',
	});
	const parsed = z.array(ReleaseSchema).safeParse(await response.json());

	if (!parsed.success) {
		throw new Error(`Failed to read the release list from ${url}: ${parsed.error.message}`);
	}

	return parsed.data;
}

/**
 * Downloads one of a release's assets.
 *
 * @param release - The release.
 * @param name - The asset's file name.
 * @returns The asset's bytes.
 * @throws When the release has no such asset or the download fails.
 */
export async function downloadAsset(release: Release, name: string): Promise<Uint8Array> {
	const asset = release.assets.find((candidate) => candidate.name === name);

	if (!asset) {
		throw new Error(`Release ${release.tag_name} has no asset named ${name}`);
	}

	const response = await request(asset.browser_download_url, name);

	return new Uint8Array(await response.arrayBuffer());
}

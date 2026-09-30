import { Client, type ClientSessionOptions, type PresenceData } from 'discord.js-selfbot-v13';
import { z } from 'zod';

import { asError, createTaggedLogger } from '@telecord/producer-core';

const logger = createTaggedLogger('Discord Client');

/** The desktop client build the producer identifies as. */
const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9227 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36';

/** Where the web client's build number is read from, in its script bundle. */
const BUILD_NUMBER_PATTERN = /parseInt\("(\d+)",10\)/;

/** Keeps the account from showing as online to its contacts while the producer runs. */
export const PRESENCE: PresenceData = { status: 'invisible', afk: true };

/** The desktop client's current web and native builds, which identify it to Discord. */
export type ClientBuild = {
	clientBuildNumber: number;
	clientVersion: string;
	nativeBuildNumber: number;
};

/** The parts of the desktop client's update manifest that name its builds. */
const NativeManifestSchema = z.object({
	metadata_version: z.int().positive(),
	full: z.object({ host_version: z.array(z.int().nonnegative()).min(1) }),
});

/** Reads the web client's build number off the script bundle `discord.com/app` loads. */
async function fetchClientBuildNumber(): Promise<number> {
	const response = await fetch('https://discord.com/app');

	if (!response.ok) {
		throw new Error(`Failed to fetch the Discord app page: ${response.statusText}`);
	}

	const scripts = (await response.text()).match(/\/assets\/web\.[a-z0-9].*?\.js/gi) ?? [];

	for (const script of scripts.toReversed()) {
		try {
			const bundle = await fetch(`https://discord.com${script}`, {
				headers: { Origin: 'https://discord.com/', Referer: 'https://discord.com/app' },
			});
			const match = BUILD_NUMBER_PATTERN.exec(await bundle.text());

			if (match?.[1]) {
				return Number(match[1]);
			}
		} catch (error) {
			logger.warn(
				`Failed to read the build number from ${script}: ${asError(error).message}`,
			);
		}
	}

	throw new Error('Failed to find the Discord build number in any app script');
}

/** Reads the desktop client's host version and native build off its update manifest. */
async function fetchNativeBuild(): Promise<
	Pick<ClientBuild, 'clientVersion' | 'nativeBuildNumber'>
> {
	const response = await fetch(
		`https://updates.discord.com/distributions/app/manifests/latest?channel=stable&platform=win&arch=x64&install_id=${crypto.randomUUID()}`,
	);

	if (!response.ok) {
		throw new Error(`Failed to fetch the Discord update manifest: ${response.statusText}`);
	}

	const manifest = NativeManifestSchema.parse(await response.json());

	return {
		clientVersion: manifest.full.host_version.join('.'),
		nativeBuildNumber: manifest.metadata_version,
	};
}

/**
 * Reads the desktop client's current builds from Discord, as the desktop client reports them.
 *
 * @returns The builds.
 * @throws When Discord does not name them, since identifying with made-up builds is what gives a
 * selfbot away.
 */
export async function fetchClientBuild(): Promise<ClientBuild> {
	const [clientBuildNumber, native] = await Promise.all([
		fetchClientBuildNumber(),
		fetchNativeBuild(),
	]);

	return { clientBuildNumber, ...native };
}

/** A launch signature as the desktop client makes one: a random UUID with its canvas bits cleared. */
function launchSignature(): string {
	const canvasMask = BigInt(
		'0b00000000100000000001000000010000000010000001000000001000000000000010000010000001000000000100000000000001000000000000100000000000',
	);
	const uuid = BigInt(`0x${crypto.randomUUID().replaceAll('-', '')}`);
	const hex = (uuid & (((1n << 128n) - 1n) ^ canvasMask)).toString(16).padStart(32, '0');

	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join('-');
}

/**
 * The properties the desktop client identifies with, on the gateway and in every REST call's
 * `X-Super-Properties`.
 *
 * @param build - The desktop client's current builds.
 * @returns The properties.
 */
export function superProperties(build: ClientBuild) {
	return {
		os: 'Windows',
		browser: 'Discord Client',
		release_channel: 'stable',
		client_version: build.clientVersion,
		os_version: '10.0.26200',
		os_arch: 'x64',
		app_arch: 'x64',
		system_locale: 'en-US',
		has_client_mods: false,
		browser_user_agent: USER_AGENT,
		browser_version: '37.6.0',
		os_sdk_version: '26200',
		client_build_number: build.clientBuildNumber,
		native_build_number: build.nativeBuildNumber,
		client_event_source: null,
		client_launch_id: crypto.randomUUID(),
		launch_signature: launchSignature(),
		client_heartbeat_session_id: crypto.randomUUID(),
		client_app_state: 'focused',
		is_fast_connect: true,
	};
}

/**
 * The selfbot client a producer logs in with: identified as the desktop client, invisible and away.
 * A resumed session keeps whatever presence it was stored with, so the presence is set again on
 * every `ready`.
 *
 * @param build - The desktop client's current builds.
 * @param session - A stored gateway session to resume, when there is one.
 * @returns The client, not yet logged in.
 */
export function createDiscordClient(build: ClientBuild, session?: ClientSessionOptions): Client {
	const client = new Client({
		session,
		presence: PRESENCE,
		ws: { properties: superProperties(build) },
		http: { headers: { 'User-Agent': USER_AGENT } },
	});

	client.on('ready', (ready) => {
		ready.user.setPresence(PRESENCE);
	});

	return client;
}

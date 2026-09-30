import { DiscordAPIError, type Client } from 'discord.js-selfbot-v13';
import { z } from 'zod';

import {
	DiscordAttachmentRefresh,
	DiscordAttachmentRefreshResult,
	DiscordMediaFetch,
	DiscordMessagesFetch,
	DiscordMessagesFetchResult,
	DiscordOpcode,
	type DiscordAttachmentRefreshPayload,
	type DiscordAttachmentRefreshResultPayload,
	type DiscordMediaFetchPayload,
	type DiscordMessagesFetchPayload,
	type DiscordMessagesFetchResultPayload,
} from '@telecord/ingest-client/discord';
import {
	asError,
	createTaggedLogger,
	defineProbe,
	defineRequest,
	failureMessage,
	isAllowed,
	postPresigned,
	readLimited,
	type Filter,
	type RequestHandler,
} from '@telecord/producer-core';
import {
	IngestMediaFetchResultSchema,
	RequestFailureReason,
	type IngestMediaFetchResult,
} from '@telecord/ingest-client';
import { recordError, withSpan } from '@telecord/producer-otel';

import type { DiscordFilterSubject } from './filter';

import { subjectOfChannel, subjectOfChannelId } from './channels';

/** Statuses Discord answers a history read with once the account can no longer see the channel. */
const ACCESS_LOST_STATUSES = new Set([403, 404]);

/** Path prefixes of CDN urls that belong to a channel, followed by its id. */
const CHANNEL_PATHS = new Set(['attachments', 'ephemeral-attachments']);

/** Path prefixes of CDN urls that belong to a guild, followed by its id. */
const GUILD_PATHS = new Set(['icons', 'banners', 'splashes', 'discovery-splashes', 'guilds']);

/** Reference type of a reply; forwards and other references carry their content themselves. */
const REPLY_REFERENCE = 0;

const logger = createTaggedLogger('Discord Requests');

const RawMessagesSchema = z.array(z.looseObject({ id: z.string() }));

type RawMessage = z.output<typeof RawMessagesSchema>[number];

const ReferenceSchema = z.object({
	type: z.number().optional(),
	message_id: z.string().optional(),
	channel_id: z.string().optional(),
});

// discord.js types its REST router as `unknown`; this is the one route the producer reads through it.
type MessagesRouter = {
	channels: (id: string) => {
		messages: { get: (options: { query: Record<string, string> }) => Promise<unknown> };
	};
};

/**
 * Reads raw messages through the library's REST client, which queues and
 * retries rate-limited calls itself. The library's own `messages.fetch` reads
 * the same route but keeps only its parsed objects, not the raw ones.
 */
async function readMessages(
	client: Client,
	channelId: string,
	query: Record<string, string>,
): Promise<RawMessage[]> {
	const router = client.api as MessagesRouter;

	return RawMessagesSchema.parse(await router.channels(channelId).messages.get({ query }));
}

/** Messages by id, each read as the one message around itself; an id that is gone is left out. */
async function readMessagesById(
	client: Client,
	channelId: string,
	ids: readonly string[],
): Promise<RawMessage[]> {
	const pages = await Promise.all(
		ids.map((id) => readMessages(client, channelId, { around: id, limit: '1' })),
	);

	return pages.flat().filter(({ id }) => ids.includes(id));
}

/**
 * Attaches the replied-to message to every reply that arrived without one,
 * the raw equivalent of `message.fetchReference()`, as long as the filter
 * rules allow the channel it sits in.
 */
async function fetchReferences(
	client: Client,
	filter: Filter,
	channelId: string,
	messages: RawMessage[],
): Promise<void> {
	await Promise.all(
		messages.map(async (message) => {
			const reference = ReferenceSchema.safeParse(message.message_reference);

			if (!reference.success || 'referenced_message' in message) {
				return;
			}

			const {
				type = REPLY_REFERENCE,
				message_id: messageId,
				channel_id: referenceChannelId = channelId,
			} = reference.data;

			if (
				type !== REPLY_REFERENCE ||
				messageId === undefined ||
				!isAllowed(filter, subjectOfChannelId(client, referenceChannelId))
			) {
				return;
			}

			const [referenced] = await readMessagesById(client, referenceChannelId, [messageId]);

			message.referenced_message = referenced ?? null;
		}),
	);
}

/**
 * Answers one `MESSAGES_FETCH` with raw messages as the API returned them. A
 * channel the cache does not know, or one the filter rules block, is declined
 * without a call.
 */
async function fetchMessages(
	client: Client,
	filter: Filter,
	request: DiscordMessagesFetchPayload,
): Promise<DiscordMessagesFetchResultPayload> {
	const channel = client.channels.cache.get(request.channelId);

	if (!channel) {
		return {
			ok: false,
			reason: RequestFailureReason.ACCESS_LOST,
			message: `Channel ${request.channelId} is unknown to this session`,
		};
	}

	if (!isAllowed(filter, subjectOfChannel(channel))) {
		return { ok: false, reason: RequestFailureReason.FILTERED };
	}

	try {
		const messages =
			'ids' in request
				? await readMessagesById(client, request.channelId, request.ids)
				: await readMessages(client, request.channelId, {
						limit: String(request.limit),
						...(request.before !== undefined && { before: request.before }),
						...(request.after !== undefined && { after: request.after }),
					});

		await fetchReferences(client, filter, request.channelId, messages);

		return { ok: true, messages };
	} catch (error) {
		logger.warn(`Failed to fetch messages in ${request.channelId}: ${asError(error).message}`);
		recordError(error);

		if (error instanceof DiscordAPIError && ACCESS_LOST_STATUSES.has(error.httpStatus)) {
			return {
				ok: false,
				reason: RequestFailureReason.ACCESS_LOST,
				message: failureMessage(error),
			};
		}

		return { ok: false, message: failureMessage(error) };
	}
}

function isDiscordCdn(url: URL): boolean {
	return url.hostname.endsWith('.discordapp.com') || url.hostname.endsWith('.discordapp.net');
}

/** The chat a CDN url belongs to, or undefined for a file bound to none, such as an avatar or emoji. */
function subjectOfCdnUrl(client: Client, url: URL): DiscordFilterSubject | undefined {
	const [kind, id] = url.pathname.split('/').filter(Boolean);

	if (kind === undefined || id === undefined) {
		return undefined;
	}

	if (CHANNEL_PATHS.has(kind)) {
		return subjectOfChannelId(client, id);
	}

	return GUILD_PATHS.has(kind) ? { type: 'guild', guildId: id } : undefined;
}

/** Whether the filter rules block the chat a CDN url belongs to. */
function isCdnUrlFiltered(client: Client, filter: Filter, url: URL): boolean {
	const subject = subjectOfCdnUrl(client, url);

	return subject !== undefined && !isAllowed(filter, subject);
}

/**
 * Answers one `MEDIA_FETCH`: downloads a Discord CDN file, refusing a body past
 * `maxBytes` before it is fully read, and posts it to the presigned upload.
 */
async function fetchMedia(
	client: Client,
	filter: Filter,
	{ fileName, url, maxBytes, upload }: DiscordMediaFetchPayload,
): Promise<IngestMediaFetchResult> {
	const source = new URL(url);

	if (!isDiscordCdn(source)) {
		return { fileName, ok: false, message: `${source.hostname} is not a Discord CDN host` };
	}

	if (isCdnUrlFiltered(client, filter, source)) {
		return { fileName, ok: false, reason: RequestFailureReason.FILTERED };
	}

	try {
		const response = await fetch(source);

		if (!response.ok || !response.body) {
			await response.body?.cancel();

			return { fileName, ok: false, message: `The CDN answered HTTP ${response.status}` };
		}

		const bytes = await readLimited(response.body, maxBytes);

		if (!bytes) {
			return { fileName, ok: false, message: `The file is larger than ${maxBytes} bytes` };
		}

		const status = await postPresigned(upload, bytes);

		return status >= 200 && status < 300
			? { fileName, ok: true, bytes: bytes.byteLength }
			: { fileName, ok: false, message: `The upload was answered with HTTP ${status}` };
	} catch (error) {
		logger.warn(`Failed to fetch media ${fileName}: ${asError(error).message}`);
		recordError(error);

		return { fileName, ok: false, message: failureMessage(error) };
	}
}

/**
 * Answers one `ATTACHMENT_REFRESH` with a re-signed url. Discord echoes a url
 * it declines to refresh, so only a different url counts; a failed call
 * passes Discord's own error code on, since a lapsed signature and a deleted
 * attachment fail the same way.
 */
async function refreshAttachment(
	client: Client,
	filter: Filter,
	{ fileName, url }: DiscordAttachmentRefreshPayload,
): Promise<DiscordAttachmentRefreshResultPayload> {
	if (isCdnUrlFiltered(client, filter, new URL(url))) {
		return { fileName, ok: false, reason: RequestFailureReason.FILTERED };
	}

	try {
		const [refreshed] = await client.refreshAttachmentURL(url);
		const fresh = refreshed?.refreshed;

		if (fresh === undefined || fresh === url) {
			return { fileName, ok: false, reason: RequestFailureReason.ACCESS_LOST };
		}

		return { fileName, ok: true, url: fresh };
	} catch (error) {
		logger.warn(`Failed to refresh attachment ${fileName}: ${asError(error).message}`);
		recordError(error);

		return error instanceof DiscordAPIError
			? { fileName, ok: false, code: error.code, message: failureMessage(error) }
			: { fileName, ok: false, message: failureMessage(error) };
	}
}

/**
 * The single-result requests a Discord producer answers: `PROBE`,
 * `MESSAGES_FETCH`, `MEDIA_FETCH` and `ATTACHMENT_REFRESH`, each checked
 * against the filter rules.
 *
 * @param client - The ready client.
 * @param filter - The producer's filter rules.
 * @returns The handlers, keyed by request opcode.
 */
export function createDiscordRequests(
	client: Client,
	filter: Filter,
): Record<string, RequestHandler> {
	return {
		[DiscordOpcode.PROBE]: defineProbe(DiscordOpcode.PROBE_RESULT),
		[DiscordOpcode.MESSAGES_FETCH]: defineRequest({
			payload: DiscordMessagesFetch,
			result: DiscordOpcode.MESSAGES_FETCH_RESULT,
			resultSchema: DiscordMessagesFetchResult,
			handle: (request) =>
				withSpan(
					'discord.messages_fetch',
					{
						'telecord.platform': 'discord',
						'telecord.request': 'MESSAGES_FETCH',
						'discord.channel.id': request.channelId,
						'discord.message.ids': 'ids' in request ? request.ids : undefined,
					},
					() => fetchMessages(client, filter, request),
				),
		}),
		[DiscordOpcode.MEDIA_FETCH]: defineRequest({
			payload: DiscordMediaFetch,
			result: DiscordOpcode.MEDIA_FETCH_RESULT,
			resultSchema: IngestMediaFetchResultSchema,
			handle: (request) =>
				withSpan(
					'discord.media_fetch',
					{
						'telecord.platform': 'discord',
						'telecord.request': 'MEDIA_FETCH',
						'discord.file.name': request.fileName,
						'url.path': URL.parse(request.url)?.pathname,
					},
					() => fetchMedia(client, filter, request),
				),
		}),
		[DiscordOpcode.ATTACHMENT_REFRESH]: defineRequest({
			payload: DiscordAttachmentRefresh,
			result: DiscordOpcode.ATTACHMENT_REFRESH_RESULT,
			resultSchema: DiscordAttachmentRefreshResult,
			handle: (request) =>
				withSpan(
					'discord.attachment_refresh',
					{
						'telecord.platform': 'discord',
						'telecord.request': 'ATTACHMENT_REFRESH',
						'discord.file.name': request.fileName,
						'url.path': URL.parse(request.url)?.pathname,
					},
					() => refreshAttachment(client, filter, request),
				),
		}),
	};
}

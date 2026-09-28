import type { ClientSessionOptions } from 'discord.js-selfbot-v13';
import { z } from 'zod';

import { createTaggedLogger, type Outbox } from '@telecord/producer-core';

import { RoutingSchema } from './dispatches';

/** The session's id, resume URL and last sequence, rewritten on every dispatch. */
const SESSION_KEY = 'discord_session';
/** The session's `READY` payload, written once per `READY`: it can run to megabytes. */
const READY_KEY = 'discord_ready';

/**
 * The dispatches whose handlers change what `READY` fills the cache with and
 * the producer reads: guilds, their roles, emojis, stickers, events and stage
 * instances, channels and threads, relationships, notes and the account's own
 * user, member and settings. Presences, voice states, typing, other members
 * and message edits change only caches the producer never reads, and arrive
 * too often to keep.
 */
const CACHE_DISPATCHES = new Set([
	'GUILD_CREATE',
	'GUILD_UPDATE',
	'GUILD_DELETE',
	'GUILD_ROLE_CREATE',
	'GUILD_ROLE_UPDATE',
	'GUILD_ROLE_DELETE',
	'GUILD_EMOJIS_UPDATE',
	'GUILD_STICKERS_UPDATE',
	'GUILD_MEMBER_ADD',
	'GUILD_MEMBER_UPDATE',
	'GUILD_MEMBER_REMOVE',
	'GUILD_SCHEDULED_EVENT_CREATE',
	'GUILD_SCHEDULED_EVENT_UPDATE',
	'GUILD_SCHEDULED_EVENT_DELETE',
	'STAGE_INSTANCE_CREATE',
	'STAGE_INSTANCE_UPDATE',
	'STAGE_INSTANCE_DELETE',
	'CHANNEL_CREATE',
	'CHANNEL_UPDATE',
	'CHANNEL_DELETE',
	'CHANNEL_PINS_UPDATE',
	'CHANNEL_RECIPIENT_ADD',
	'CHANNEL_RECIPIENT_REMOVE',
	'THREAD_CREATE',
	'THREAD_UPDATE',
	'THREAD_DELETE',
	'THREAD_LIST_SYNC',
	'THREAD_MEMBER_UPDATE',
	'RELATIONSHIP_ADD',
	'RELATIONSHIP_UPDATE',
	'RELATIONSHIP_REMOVE',
	'USER_UPDATE',
	'USER_NOTE_UPDATE',
	'USER_SETTINGS_UPDATE',
	'USER_GUILD_SETTINGS_UPDATE',
	'MESSAGE_CREATE',
]);

/** Kept only when they concern the account's own member. */
const MEMBER_DISPATCHES = new Set([
	'GUILD_MEMBER_ADD',
	'GUILD_MEMBER_UPDATE',
	'GUILD_MEMBER_REMOVE',
]);

const logger = createTaggedLogger('Discord Session');

const StoredSessionSchema = z.object({
	sessionId: z.string().min(1),
	resumeURL: z.url(),
	/** The last dispatch received; a `RESUME` replays everything after it. */
	sequence: z.number().int().nonnegative(),
});

const StoredReadySchema = z.looseObject({ user: z.looseObject({ id: z.string() }) });

const StoredDispatchSchema = z.object({ t: z.string(), d: z.unknown() });

const ReadySchema = z.object({
	op: z.literal(0),
	t: z.literal('READY'),
	d: StoredReadySchema.extend({ session_id: z.string(), resume_gateway_url: z.string() }),
});

const ResumedSchema = z.object({ op: z.literal(0), t: z.literal('RESUMED') });

const DispatchSchema = z.object({
	op: z.literal(0),
	t: z.string(),
	s: z.number().int(),
	d: z.unknown(),
});

const InvalidSessionSchema = z.object({ op: z.literal(9), d: z.literal(false) });

function forgetSession(outbox: Outbox): void {
	outbox.deleteMeta(SESSION_KEY);
	outbox.deleteMeta(READY_KEY);
	outbox.clearSessionLog();
}

/**
 * The gateway session an earlier run left in the outbox, in the shape the
 * client resumes it from, or undefined when none is stored or the stored one
 * is unreadable.
 *
 * @param outbox - The producer's outbox.
 * @returns The session to seed the client with.
 */
export function loadSession(outbox: Outbox): ClientSessionOptions | undefined {
	const session = outbox.getMeta(SESSION_KEY);
	const ready = outbox.getMeta(READY_KEY);

	if (session === undefined || ready === undefined) {
		return undefined;
	}

	const parsedSession = StoredSessionSchema.safeParse(JSON.parse(session));
	const parsedReady = StoredReadySchema.safeParse(JSON.parse(ready));
	const parsedDispatches = z
		.array(StoredDispatchSchema)
		.safeParse(outbox.sessionLog().map((entry) => JSON.parse(entry)));

	if (!parsedSession.success || !parsedReady.success || !parsedDispatches.success) {
		const error = parsedSession.error ?? parsedReady.error ?? parsedDispatches.error;

		logger.error(`Discarded an unreadable stored gateway session: ${error?.message}`);
		forgetSession(outbox);

		return undefined;
	}

	return { ...parsedSession.data, ready: parsedReady.data, dispatches: parsedDispatches.data };
}

/**
 * Keeps the client's gateway session in the outbox as its packets arrive, so
 * the next run can resume it with its cache as this run left it: the `READY`
 * payload with the session it opens, every dispatch since that changes what
 * `READY` cached, and the sequence of the last dispatch. Only the newest
 * `MESSAGE_CREATE` of each channel is kept, which is all its last message id
 * needs. A session the gateway invalidates is forgotten.
 *
 * @param outbox - The producer's outbox.
 * @param seeded - The stored session the client was seeded with, if any.
 * @returns The handler for the client's `raw` event, and whether the stored session resumed.
 */
export function createSessionRecorder(outbox: Outbox, seeded?: ClientSessionOptions) {
	const resuming = seeded !== undefined;
	let current: Omit<z.output<typeof StoredSessionSchema>, 'sequence'> | undefined = seeded && {
		sessionId: seeded.sessionId,
		resumeURL: seeded.resumeURL,
	};
	let selfId = seeded && StoredReadySchema.parse(seeded.ready).user.id;
	/** Undefined until a seeded client resumes or identifies anew, and when nothing was seeded. */
	let resumed: boolean | undefined;

	function keep(event: string, payload: unknown): void {
		if (!CACHE_DISPATCHES.has(event)) {
			return;
		}

		const { channel_id: channelId, user } = RoutingSchema.safeParse(payload).data ?? {};

		if (MEMBER_DISPATCHES.has(event) && user?.id !== selfId) {
			return;
		}

		const key = event === 'MESSAGE_CREATE' ? `${event} ${channelId}` : undefined;

		outbox.logSession(JSON.stringify({ t: event, d: payload }), key);
	}

	return {
		get resumed(): boolean | undefined {
			return resumed;
		},

		onPacket(packet: unknown): void {
			if (InvalidSessionSchema.safeParse(packet).success) {
				current = undefined;
				forgetSession(outbox);

				return;
			}

			if (resuming && resumed === undefined && ResumedSchema.safeParse(packet).success) {
				resumed = true;
			}

			const ready = ReadySchema.safeParse(packet);

			if (ready.success) {
				const { d } = ready.data;

				if (resuming && resumed === undefined) {
					resumed = false;
				}

				current = { sessionId: d.session_id, resumeURL: d.resume_gateway_url };
				selfId = d.user.id;
				// Dropping the session before replacing READY means a crash between the writes never pairs a session with another's READY.
				forgetSession(outbox);
				outbox.setMeta(READY_KEY, JSON.stringify(d));
			}

			const dispatch = DispatchSchema.safeParse(packet);

			if (!current || !dispatch.success) {
				return;
			}

			keep(dispatch.data.t, dispatch.data.d);
			outbox.setMeta(SESSION_KEY, JSON.stringify({ ...current, sequence: dispatch.data.s }));
		},
	};
}

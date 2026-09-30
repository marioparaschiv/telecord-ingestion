import { z } from 'zod';

import {
	TELEGRAM_FORWARDED_UPDATES,
	type TelegramForwardedUpdate,
} from '@telecord/ingest-client/telegram';
import type { ForwardPlatform } from '@telecord/producer-core/config';

export const PEER_TYPES = ['user', 'group', 'channel'] as const;

export type PeerType = (typeof PEER_TYPES)[number];

/** What the filter rules see of an event, a snapshot chat or a request's chat. */
export type TelegramFilterSubject = {
	peerType?: PeerType;
	/** The marked id: a user as is, a basic group as `-<id>`, a channel as `-100<id>`. */
	peerId?: string;
	/** The update constructor, for events only. */
	update?: TelegramForwardedUpdate;
};

export const TELEGRAM_FILTER_FIELDS = {
	peerType: z.enum(PEER_TYPES),
	peerId: z.string().regex(/^-?\d+$/),
	update: z.enum(TELEGRAM_FORWARDED_UPDATES),
};

/** A chat in `forward.allow` or `forward.deny`; `name` is for the reader only. */
const TelegramForwardEntrySchema = z.strictObject({
	id: TELEGRAM_FILTER_FIELDS.peerId,
	name: z.string().optional(),
});

export type TelegramForwardEntry = z.output<typeof TelegramForwardEntrySchema>;

/** Private chats are dropped unless the rules or the `forward` table say otherwise. */
export const TELEGRAM_FORWARD: ForwardPlatform<TelegramForwardEntry> = {
	entry: TelegramForwardEntrySchema,
	fields: ['peerId'],
	targetOf: ({ id }) => ({ field: 'peerId', id }),
	dms: { peerType: ['user'] },
};

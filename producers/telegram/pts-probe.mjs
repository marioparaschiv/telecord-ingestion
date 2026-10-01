import { MemoryStorage, TelegramClient } from '@mtcute/node';

const client = new TelegramClient({
	apiId: Number(process.env.TELEGRAM_API_ID),
	apiHash: process.env.TELEGRAM_API_HASH,
	storage: new MemoryStorage(),
	disableUpdates: true,
	logLevel: 1,
});

const me = await client.start({ botToken: process.env.BOT_TOKEN });
console.log('self', me.id, me.username);

const live = await client.call({ _: 'updates.getState' });
console.log('live state', { pts: live.pts, qts: live.qts, date: live.date, seq: live.seq });

const tally = new Map();
const bump = (key) => tally.set(key, (tally.get(key) ?? 0) + 1);
const joins = [];
const chats = new Map();
const tooLongChannels = new Set();

function describe(update) {
	const base = { _: update._ };

	for (const key of ['chatId', 'channelId', 'userId', 'actorId', 'date', 'qts', 'pts']) {
		if (update[key] !== undefined) {
			base[key] = update[key];
		}
	}

	for (const key of ['prevParticipant', 'newParticipant']) {
		if (update[key]) {
			base[key] = update[key]._;
		}
	}

	return base;
}

const ptsTotalLimit = Number(process.env.PTS_TOTAL_LIMIT ?? 2147483647);

function getDifference({ pts, qts, date }) {
	return client.call({ _: 'updates.getDifference', pts, qts, date, ptsTotalLimit });
}

// The lowest pts Telegram still replays from: every pts below it answers differenceTooLong.
async function lowestReplayablePts(state, bottom, top) {
	let probes = 0;

	while (bottom <= top) {
		const pts = (bottom + top) >> 1;
		const { _ } = await getDifference({ ...state, pts });

		probes++;
		console.log(`  search [${bottom}, ${top}] pts=${pts}: ${_}`);

		if (_ === 'updates.differenceTooLong') {
			bottom = pts + 1;
		} else {
			top = pts - 1;
		}
	}

	console.log(`lowest replayable pts ${bottom} after ${probes} probes`);

	return bottom;
}

let state = { pts: 1, qts: 1, date: 1 };
let firstDate;
let lastDate;

for (let slice = 0; slice < 500; slice++) {
	const diff = await getDifference(state);

	console.log(`slice ${slice}: ${diff._} from`, state);

	if (diff._ === 'updates.differenceEmpty') {
		break;
	}

	if (diff._ === 'updates.differenceTooLong') {
		state = { ...state, pts: await lowestReplayablePts(state, state.pts, diff.pts) };
		continue;
	}

	for (const chat of diff.chats) {
		chats.set(`${chat._}:${chat.id}`, chat.title);
	}

	for (const message of diff.newMessages) {
		bump(`msg:${message._}${message.action ? `:${message.action._}` : ''}`);
		firstDate ??= message.date;
		lastDate = message.date;

		const action = message.action?._;

		if (
			action === 'messageActionChatAddUser' ||
			action === 'messageActionChatCreate' ||
			action === 'messageActionChatJoinedByLink' ||
			action === 'messageActionChatDeleteUser' ||
			action === 'messageActionChatMigrateTo'
		) {
			joins.push({
				via: 'newMessages',
				action,
				peer: message.peerId,
				users: message.action.users ?? message.action.userId,
				date: message.date,
			});
		}
	}

	for (const update of diff.otherUpdates) {
		bump(`upd:${update._}`);

		if (update._ === 'updateChannelTooLong') {
			tooLongChannels.add(update.channelId);
		}

		if (/Participant|updateChannel$|BotStopped|InviteRequester/.test(update._)) {
			joins.push({ via: 'otherUpdates', ...describe(update) });
		}
	}

	if (diff._ === 'updates.difference') {
		console.log('final state', diff.state);
		break;
	}

	state = diff.intermediateState;
}

console.log('tally', Object.fromEntries(tally));
console.log('message date range', firstDate, lastDate);
console.log('chats seen', chats.size, Object.fromEntries(chats));
console.log('join-like events', joins.length);
console.log(JSON.stringify(joins.slice(0, 60), null, 1));
console.log('channels flagged too long', [...tooLongChannels]);

await client.destroy();

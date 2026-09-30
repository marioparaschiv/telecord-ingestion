import { TELEGRAM_CONFIG_SECTION, TelegramConfigSchema } from '@telecord/telegram-producer/config';
import { DISCORD_CONFIG_SECTION, DiscordConfigSchema } from '@telecord/discord-producer/config';

/**
 * The producers the CLI sets up. Each one's name is its table in
 * `config.toml`, its compose service and its compose profile.
 */
const PLATFORMS = [
	{ name: TELEGRAM_CONFIG_SECTION, label: 'Telegram', schema: TelegramConfigSchema },
	{ name: DISCORD_CONFIG_SECTION, label: 'Discord', schema: DiscordConfigSchema },
] as const;

export type Platform = (typeof PLATFORMS)[number];

export type PlatformName = Platform['name'];

export default PLATFORMS;

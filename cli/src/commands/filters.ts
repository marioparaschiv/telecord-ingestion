import { Argument, Command } from 'commander';

import { installDirOption, installedPlatforms, openInstall } from '../install';
import PLATFORMS, { type PlatformName } from '../platforms';
import pickChats from '../pick-chats';
import { canPrompt } from '../prompt';

const filters = new Command('filters')
	.description('Pick the chats a producer forwards, from the chats its account has')
	.addArgument(
		new Argument(
			'[platform]',
			'The platform whose chats to pick; every one the install runs when omitted',
		).choices(PLATFORMS.map(({ name }) => name)),
	)
	.addOption(installDirOption())
	.action(async (platform: PlatformName | undefined, options: { dir?: string }) => {
		if (!canPrompt()) {
			throw new Error(
				'Failed to open the chat picker: it needs a terminal. Set <platform>.forward.allow and .deny with telecord-ingestion config set instead.',
			);
		}

		const install = await openInstall(options.dir);
		const enabled = await installedPlatforms(install);

		if (platform !== undefined && !enabled.includes(platform)) {
			throw new Error(
				`Failed to pick the ${platform} chats: ${install.dir} does not run it. Run telecord-ingestion setup --platforms with ${platform} first.`,
			);
		}

		if (enabled.length === 0) {
			throw new Error(
				`Failed to pick chats in ${install.dir}: it runs no producer. Run telecord-ingestion setup.`,
			);
		}

		for (const name of platform === undefined ? enabled : [platform]) {
			await pickChats(install, name);
		}
	});

export default filters;

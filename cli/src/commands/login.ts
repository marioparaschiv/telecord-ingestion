import { Argument, Command } from 'commander';

import { installDirOption, installedPlatforms, openInstall } from '../install';
import withTelegramStopped from '../telegram-session';
import logInToTelegram from '../login';
import { compose } from '../docker';

const login = new Command('login')
	.description('Log an account in, then start its producer')
	.addArgument(new Argument('<platform>', 'The platform to log in to').choices(['telegram']))
	.addOption(installDirOption())
	.action(async (platform: 'telegram', options: { dir?: string }) => {
		const install = await openInstall(options.dir);

		if (!(await installedPlatforms(install)).includes(platform)) {
			throw new Error(
				`Failed to log in to Telegram: ${install.dir} does not run it. Run telecord-ingestion setup --platforms with telegram first.`,
			);
		}

		await withTelegramStopped(install.dir, () => logInToTelegram(install.dir));
		await compose(install.dir, ['up', '--detach', platform]);
		console.log('Logged in to Telegram and started it.');
	});

export default login;

import { Command } from 'commander';

import { installDirOption, openInstall } from '../install';
import { compose } from '../docker';

const logs = new Command('logs')
	.description("Show the services' logs, through docker compose logs")
	.argument('[services...]', 'Only these services, e.g. telegram')
	.option('-f, --follow', 'Keep printing new lines')
	.option('-n, --tail <lines>', 'Start this many lines from the end')
	.addOption(installDirOption())
	.action(
		async (services: string[], options: { dir?: string; follow?: boolean; tail?: string }) => {
			const install = await openInstall(options.dir);

			await compose(install.dir, [
				'logs',
				...(options.follow ? ['--follow'] : []),
				...(options.tail === undefined ? [] : ['--tail', options.tail]),
				...services,
			]);
		},
	);

export default logs;

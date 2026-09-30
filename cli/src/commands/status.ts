import { Command } from 'commander';

import { composeProfiles, enabledPlatforms, installDirOption, openInstall } from '../install';
import { configProblem, serviceEnvironment } from '../config-check';
import { composeContainers, composeModel } from '../docker';
import { readEnvFile } from '../env-file';
import PLATFORMS from '../platforms';

const status = new Command('status')
	.description("Show each service's state and whether each producer's config is valid")
	.addOption(installDirOption())
	.action(async (options: { dir?: string }) => {
		const install = await openInstall(options.dir);
		const env = (await readEnvFile(install.env)) ?? {};
		const enabled = enabledPlatforms(env);
		const [model, containers] = await Promise.all([
			composeModel(install.dir),
			composeContainers(install.dir),
		]);
		const services = [
			...new Set([...composeProfiles(env), ...containers.map(({ Service }) => Service)]),
		];
		const width = Math.max(0, ...services.map((service) => service.length));

		console.log(`Install: ${install.dir}`);

		for (const service of services) {
			const container = containers.find(({ Service }) => Service === service);

			console.log(`  ${service.padEnd(width)}  ${container?.Status ?? 'not created'}`);
		}

		for (const platform of PLATFORMS.filter(({ name }) => enabled.includes(name))) {
			const problem = configProblem(
				install.config,
				platform,
				serviceEnvironment(model, platform),
			);

			console.log(
				problem === undefined
					? `${platform.label} config: valid`
					: `${platform.label} config: invalid\n${problem.replaceAll(/^/gm, '  ')}`,
			);
		}
	});

export default status;

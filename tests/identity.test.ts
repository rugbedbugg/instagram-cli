/* eslint-disable @typescript-eslint/no-unsafe-call -- XO cannot resolve AVA/esbuild types in tests outside the source tsconfig. */

import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'ava';
import {build} from 'esbuild';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(
	await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as {
	name: string;
	version: string;
	private: boolean;
	bin: Record<string, string>;
	repository: {url: string};
	homepage: string;
	bugs: {url: string};
};
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-cli-identity-'));

test.before(async () => {
	// Build an isolated installed-package layout so npm test also works before
	// npm run build. Both aliases follow the POSIX bin links declared by npm.
	await fs.writeFile(
		path.join(root, 'package.json'),
		JSON.stringify(packageJson),
	);
	await fs.symlink(
		path.join(projectRoot, 'node_modules'),
		path.join(root, 'node_modules'),
		'dir',
	);
	await build({
		absWorkingDir: projectRoot,
		entryPoints: ['source/cli.ts', 'source/commands/**/*.tsx'],
		bundle: true,
		splitting: true,
		platform: 'node',
		format: 'esm',
		outdir: path.join(root, 'dist'),
		outbase: 'source',
		packages: 'external',
		external: ['react-devtools-core'],
	});
	await fs.mkdir(path.join(root, 'bin'));
	await fs.chmod(path.join(root, 'dist/cli.js'), 0o755);
	await Promise.all(
		Object.entries(packageJson.bin).map(async ([name, target]) =>
			fs.symlink(path.join(root, target), path.join(root, 'bin', name)),
		),
	);
});

test.after.always(async () => {
	await fs.rm(root, {recursive: true, force: true});
});

test('package and lockfile identify the private downstream package', async t => {
	const lock = JSON.parse(
		await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
	);
	t.is(packageJson.name, 'insta-cli');
	t.true(packageJson.private);
	t.is(lock.name, packageJson.name);
	t.is(lock.packages[''].name, packageJson.name);
	t.deepEqual(packageJson.bin, {
		'insta-cli': 'dist/cli.js',
		'instagram-cli': 'dist/cli.js',
	});
	t.deepEqual(lock.packages[''].bin, packageJson.bin);
	t.is(
		packageJson.repository.url,
		'git+https://github.com/rugbedbugg/Instagram-CLI.git',
	);
	t.is(
		packageJson.homepage,
		'https://github.com/rugbedbugg/Instagram-CLI#readme',
	);
	t.is(
		packageJson.bugs.url,
		'https://github.com/rugbedbugg/Instagram-CLI/issues',
	);
});

for (const alias of ['insta-cli', 'instagram-cli']) {
	for (const command of ['--help', '--version', 'version']) {
		test(`${alias} ${command} works offline from outside the package`, async t => {
			const {stdout} = await execute(path.join(root, 'bin', alias), [command], {
				cwd: os.tmpdir(),
				env: {
					...process.env,
					PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
					INSTAGRAM_CLI_HOME: path.join(root, 'state', alias, command),
					NO_COLOR: '1',
				},
				timeout: 30_000,
			});
			t.false(stdout.includes('@i7m/instagram-cli'));
			if (command === '--help') {
				t.true(stdout.includes('insta-cli'));
				t.true(stdout.includes('Instagram-CLI'));
				t.true(stdout.includes('auth'));
			} else if (command === '--version') {
				t.is(stdout.trim(), packageJson.version);
			} else {
				t.true(
					stdout.includes(`Instagram-CLI (insta-cli): v${packageJson.version}`),
				);
				t.true(stdout.includes('Instagram app version:'));
			}
		});
	}
}

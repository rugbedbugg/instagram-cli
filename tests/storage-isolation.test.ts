/* eslint-disable @typescript-eslint/no-unsafe-call */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'ava';
import {
	ConfigManager,
	DATA_DIR_ENV_VAR,
	resolveDataDir,
} from '../source/config.js';
import {SessionManager} from '../source/session.js';
import {getLogger} from '../source/utils/logger.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const realDataDir = path.join(os.homedir(), '.instagram-cli');

function isInside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return (
		relative === '' ||
		(!relative.startsWith('..') && !path.isAbsolute(relative))
	);
}

// Metadata only: the real config file is never read or written by this test.
async function statRealConfig(): Promise<string> {
	try {
		const stat = await fs.stat(path.join(realDataDir, 'config.ts.yaml'));
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return 'absent';
	}
}

// ── resolveDataDir ───────────────────────────────────────────────────────────

test('resolveDataDir: defaults to ~/.instagram-cli without an override', t => {
	t.is(resolveDataDir({}), realDataDir);
});

test('resolveDataDir: blank override falls back to the default', t => {
	t.is(resolveDataDir({[DATA_DIR_ENV_VAR]: '   '}), realDataDir);
});

test('resolveDataDir: override is resolved to an absolute path', t => {
	t.is(
		resolveDataDir({[DATA_DIR_ENV_VAR]: 'relative-dir'}),
		path.resolve('relative-dir'),
	);
});

// ── Test-run isolation ───────────────────────────────────────────────────────

test('test workers run with an isolated data dir outside the real one', t => {
	const isolated = process.env[DATA_DIR_ENV_VAR];
	t.truthy(isolated, `${DATA_DIR_ENV_VAR} must be set by the AVA setup file`);
	t.false(isInside(isolated!, realDataDir));
	t.is(resolveDataDir(), path.resolve(isolated!));
});

test.serial(
	'config, sessions and logs stay inside the isolated data dir',
	async t => {
		const isolated = resolveDataDir();
		const realConfigBefore = await statRealConfig();

		const config = ConfigManager.getInstance();
		await config.initialize();
		await config.set('login.currentUsername', 'isolation-test-user');

		t.true(isInside(config.getConfigFilePath(), isolated));
		await t.notThrowsAsync(fs.access(config.getConfigFilePath()));

		for (const key of [
			'dataDir',
			'usersDir',
			'cacheDir',
			'mediaDir',
			'generatedDir',
			'logsDir',
			'downloadDir',
		]) {
			const directory = config.get(`advanced.${key}`);
			t.true(isInside(directory, isolated), `advanced.${key} leaked`);
		}

		const session = new SessionManager('isolation-test-user');
		await session.saveSession({test: 'data'});
		t.true(await session.sessionExists());
		await t.notThrowsAsync(
			fs.access(
				path.join(isolated, 'users', 'isolation-test-user', 'session.ts.json'),
			),
		);
		await session.deleteSession();

		t.true(isInside(getLogger().getLogFilePath(), isolated));

		await config.set('login.currentUsername', undefined);
		t.is(await statRealConfig(), realConfigBefore);
	},
);

/* eslint-disable @typescript-eslint/no-unsafe-call */

import {Buffer} from 'node:buffer';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test, {type ExecutionContext} from 'ava';
import {
	approveLocalFile,
	classifySensitivePath,
	isPreparedMedia,
	LocalFileError,
	readAttachment,
	readMediaForUpload,
	readTextForEmbedding,
	type ApprovedLocalFile,
	type FileAccessOptions,
	type FileAccessRoots,
	type LocalFileRejection,
	type SensitiveCategory,
} from '../source/utils/local-file-policy.js';
import {getLogger} from '../source/utils/logger.js';

// ── Fixtures (temporary directories only) ────────────────────────────────────

// Smallest valid 1x1 PNG, so content sniffing detects an image.
const pngBytes = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
);
// Minimal ISO-BMFF header that content sniffing detects as video/mp4.
const mp4Bytes = Buffer.concat([
	Buffer.from([0, 0, 0, 0x18]),
	Buffer.from('ftypmp42'),
	Buffer.from([0, 0, 0, 0]),
	Buffer.from('mp42isom'),
]);
const fakePrivateKey =
	'-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAfake\n-----END OPENSSH PRIVATE KEY-----\n';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instagram-cli-files-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
const roots: FileAccessRoots = {
	homeDir: home,
	dataDir: path.join(home, '.instagram-cli'),
	cwd: work,
};
const options: FileAccessOptions = {roots};
const smallLimits: FileAccessOptions = {
	roots,
	limits: {textEmbedBytes: 64, photoUploadBytes: 200, videoUploadBytes: 300},
};

function write(relative: string, content: string | Uint8Array): string {
	const target = path.join(root, relative);
	fs.mkdirSync(path.dirname(target), {recursive: true});
	fs.writeFileSync(target, content);
	return target;
}

function link(relative: string, target: string): string {
	const linkPath = path.join(root, relative);
	fs.mkdirSync(path.dirname(linkPath), {recursive: true});
	fs.symlinkSync(target, linkPath);
	return linkPath;
}

const canSymlink = (() => {
	try {
		const probe = path.join(root, 'symlink-probe');
		fs.symlinkSync(root, probe);
		fs.unlinkSync(probe);
		return true;
	} catch {
		return false;
	}
})();

const symlinkTest = canSymlink ? test : test.skip;

// Real locations that must never be touched; compared by metadata only.
const realLocations = ['.instagram-cli', '.ssh', '.config'].map(name =>
	path.join(os.homedir(), name),
);

function snapshotRealLocations(): string[] {
	return realLocations.map(location => {
		try {
			const stat = fs.statSync(location);
			return `${location}:${stat.mtimeMs}:${stat.ctimeMs}`;
		} catch {
			return `${location}:absent`;
		}
	});
}

let realLocationsBefore: string[] = [];

test.before(() => {
	realLocationsBefore = snapshotRealLocations();

	write('work/notes.txt', 'hello notes');
	write('work/my notes.txt', 'spaced notes');
	write('work/photo.png', pngBytes);
	write('work/clip.mp4', mp4Bytes);
	write('work/readme.txt', `Setup:\n${fakePrivateKey}`);
	write(
		'work/token-in-text.txt',
		'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
	);
	write('work/holiday.jpg', fakePrivateKey);
	write('work/blob.bin', Buffer.from([0x68, 0x00, 0x69]));
	write('work/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
	fs.mkdirSync(path.join(work, 'dir'), {recursive: true});
	write('home/doc.txt', 'home document');

	// Fake sensitive files: never real ones.
	write('home/.ssh/id_ed25519', fakePrivateKey);
	write('home/.ssh/config', 'Host example');
	write('home/.SSH/ID_RSA', fakePrivateKey);
	write('home/.gnupg/pubring.kbx', 'fake');
	write('home/.aws/credentials', '[default]');
	write('home/.kube/config', 'apiVersion: v1');
	write('home/.git-credentials', 'https://user:pass@example.com');
	write('home/.config/gh/hosts.yml', 'oauth_token: fake');
	write('home/.npmrc', '//registry.npmjs.org/:_authToken=fake');
	write('home/.netrc', 'machine example.com');
	write('home/.bash_history', 'ls');
	write('home/.instagram-cli/users/someone/session.ts.json', '{}');
	write('home/.instagram-cli/logs/session.log', 'log');
	write('home/.config/google-chrome/Default/Login Data', 'fake');
	write('work/.env', 'SECRET=1');
	write('work/.env.production', 'SECRET=1');
	write('work/api.token', 'fake');
	write('work/server.pem', 'fake');
	write('work/repo/.git/config', '[remote]');

	for (const [name, size] of [
		['text-63.txt', 63],
		['text-64.txt', 64],
		['text-65.txt', 65],
	] as const) {
		write(`work/${name}`, 'a'.repeat(size));
	}

	const padded = (size: number) =>
		Buffer.concat([pngBytes, Buffer.alloc(size - pngBytes.length)]);
	write('work/photo-199.png', padded(199));
	write('work/photo-200.png', padded(200));
	write('work/photo-201.png', padded(201));

	if (canSymlink) {
		link('work/link-to-notes.txt', path.join(work, 'notes.txt'));
		link('work/innocent.txt', path.join(home, '.ssh', 'id_ed25519'));
		link('work/hop-b', path.join(home, '.aws', 'credentials'));
		link('work/hop-a', path.join(work, 'hop-b'));
		link('work/broken-link', path.join(work, 'missing.txt'));
		link('work/link-to-dir', path.join(work, 'dir'));
	}
});

test.after.always(
	'real ~/.instagram-cli, ~/.ssh and ~/.config are unchanged',
	t => {
		const realLocationsAfter = snapshotRealLocations();
		fs.rmSync(root, {recursive: true, force: true});
		t.deepEqual(realLocationsAfter, realLocationsBefore);
	},
);

async function rejection(
	t: ExecutionContext,
	promise: Promise<unknown>,
): Promise<LocalFileError> {
	const error = await t.throwsAsync(promise, {instanceOf: LocalFileError});
	return error as LocalFileError;
}

async function expectRejection(
	t: ExecutionContext,
	requested: string,
	code: LocalFileRejection,
	category?: SensitiveCategory,
	purpose: 'text-embed' | 'media-upload' | 'attachment' = 'attachment',
) {
	const error = await rejection(
		t,
		approveLocalFile(requested, purpose, options),
	);
	t.is(error.code, code);
	if (category) {
		t.is(error.category, category);
	}

	t.false(error.message.includes(root), 'message must not leak the path');
	return error;
}

// ── Normal files ─────────────────────────────────────────────────────────────

test('approves and embeds a valid text file', async t => {
	const file = await approveLocalFile(
		path.join(work, 'notes.txt'),
		'text-embed',
		options,
	);
	t.is(file.displayName, 'notes.txt');
	t.is(await readTextForEmbedding(file), 'hello notes');
});

test('approves a valid image and prepares it as photo media', async t => {
	const file = await approveLocalFile(
		path.join(work, 'photo.png'),
		'media-upload',
		options,
	);
	const media = await readMediaForUpload(file);
	t.is(media.kind, 'photo');
	t.is(media.mime, 'image/png');
	t.true(isPreparedMedia(media));
});

test('detects video media by content', async t => {
	const file = await approveLocalFile(
		path.join(work, 'clip.mp4'),
		'media-upload',
		options,
	);
	const media = await readMediaForUpload(file);
	t.is(media.kind, 'video');
});

test('handles spaces in paths', async t => {
	const file = await approveLocalFile(
		path.join(work, 'my notes.txt'),
		'text-embed',
		options,
	);
	t.is(await readTextForEmbedding(file), 'spaced notes');
});

test('resolves relative paths against the injected cwd', async t => {
	const file = await approveLocalFile('notes.txt', 'text-embed', options);
	t.is(await readTextForEmbedding(file), 'hello notes');
});

test('expands ~ against the injected home directory', async t => {
	const file = await approveLocalFile('~/doc.txt', 'text-embed', options);
	t.is(await readTextForEmbedding(file), 'home document');
});

// ── Canonicalization ─────────────────────────────────────────────────────────

test('normalizes .. segments', async t => {
	const file = await approveLocalFile(
		'dir/../notes.txt',
		'text-embed',
		options,
	);
	t.is(await readTextForEmbedding(file), 'hello notes');
});

test('.. into a sensitive directory is blocked', async t => {
	await expectRejection(t, '../home/.ssh/id_ed25519', 'sensitive', 'ssh');
});

symlinkTest('symlink to a safe file is allowed', async t => {
	const file = await approveLocalFile(
		'link-to-notes.txt',
		'text-embed',
		options,
	);
	t.is(await readTextForEmbedding(file), 'hello notes');
});

symlinkTest('safe-looking symlink to a sensitive file is blocked', async t => {
	const error = await expectRejection(t, 'innocent.txt', 'sensitive', 'ssh');
	t.is(error.displayName, 'innocent.txt');
});

symlinkTest('symlink chain ending at a sensitive file is blocked', async t => {
	await expectRejection(t, 'hop-a', 'sensitive', 'cloud-credentials');
});

symlinkTest('broken symlink is reported as not found', async t => {
	await expectRejection(t, 'broken-link', 'not-found');
});

symlinkTest('symlink to a directory is rejected', async t => {
	await expectRejection(t, 'link-to-dir', 'not-a-file');
});

test('nonexistent target is reported as not found', async t => {
	await expectRejection(t, 'missing.txt', 'not-found');
});

test('directory is rejected', async t => {
	await expectRejection(t, 'dir', 'not-a-file');
});

test('empty path is rejected', async t => {
	await expectRejection(t, '   ', 'empty-path');
});

(process.platform === 'win32' ? test.skip : test)(
	'FIFO is rejected without blocking',
	async t => {
		const fifo = path.join(work, 'pipe');
		try {
			execFileSync('mkfifo', [fifo]);
		} catch {
			t.pass('mkfifo unavailable');
			return;
		}

		await expectRejection(t, 'pipe', 'not-a-file');
	},
);

// ── Sensitive files ──────────────────────────────────────────────────────────

const sensitiveCases: Array<[string, SensitiveCategory]> = [
	['~/.ssh/id_ed25519', 'ssh'],
	['~/.ssh/config', 'ssh'],
	['~/.SSH/ID_RSA', 'ssh'],
	['~/.gnupg/pubring.kbx', 'gpg'],
	['~/.aws/credentials', 'cloud-credentials'],
	['~/.kube/config', 'cloud-credentials'],
	['~/.git-credentials', 'git-credentials'],
	['~/.config/gh/hosts.yml', 'git-credentials'],
	['~/.npmrc', 'package-credentials'],
	['~/.netrc', 'netrc'],
	['~/.bash_history', 'shell-history'],
	['~/.instagram-cli/users/someone/session.ts.json', 'instagram-cli-data'],
	['~/.instagram-cli/logs/session.log', 'instagram-cli-data'],
	['~/.config/google-chrome/Default/Login Data', 'browser-profile'],
	['.env', 'environment-file'],
	['.env.production', 'environment-file'],
	['api.token', 'token-file'],
	['server.pem', 'private-key'],
	['repo/.git/config', 'git-credentials'],
];

for (const [requested, category] of sensitiveCases) {
	test(`blocks ${requested} as ${category}`, async t => {
		await expectRejection(t, requested, 'sensitive', category);
	});
}

test('blocks the injected CLI data dir even under another name', async t => {
	const custom: FileAccessOptions = {
		roots: {...roots, dataDir: path.join(work, 'custom-data')},
	};
	write('work/custom-data/notes.txt', 'internal');
	const error = await rejection(
		t,
		approveLocalFile('custom-data/notes.txt', 'attachment', custom),
	);
	t.is(error.category, 'instagram-cli-data');
});

test('classification handles Windows separators and case', t => {
	t.is(classifySensitivePath(String.raw`C:\Users\Me\.SSH\id_rsa`), 'ssh');
	t.is(
		classifySensitivePath(
			String.raw`C:\Users\Me\AppData\Local\Google\Chrome\User Data\Default\Cookies`,
		),
		'browser-profile',
	);
	t.is(classifySensitivePath('/proc/self/environ'), 'system');
	t.is(classifySensitivePath('/home/me/Pictures/cat.png'), undefined);
});

test('private key content in a safely named text file is blocked', async t => {
	const file = await approveLocalFile('readme.txt', 'text-embed', options);
	const error = await rejection(t, readTextForEmbedding(file));
	t.is(error.code, 'secret-content');
});

test('access token content in a text file is blocked', async t => {
	const file = await approveLocalFile(
		'token-in-text.txt',
		'text-embed',
		options,
	);
	const error = await rejection(t, readTextForEmbedding(file));
	t.is(error.code, 'secret-content');
});

test('a key renamed to .jpg is not uploaded as media', async t => {
	const file = await approveLocalFile('holiday.jpg', 'media-upload', options);
	const error = await rejection(t, readMediaForUpload(file, 'photo'));
	t.is(error.code, 'unsupported-type');
});

test('requested media kind must match the content', async t => {
	const file = await approveLocalFile('clip.mp4', 'media-upload', options);
	const error = await rejection(t, readMediaForUpload(file, 'photo'));
	t.is(error.code, 'unsupported-type');
});

test('binary and non-UTF-8 files are not embedded as text', async t => {
	for (const name of ['blob.bin', 'latin1.txt']) {
		// eslint-disable-next-line no-await-in-loop
		const file = await approveLocalFile(name, 'text-embed', options);
		// eslint-disable-next-line no-await-in-loop
		const error = await rejection(t, readTextForEmbedding(file));
		t.is(error.code, 'unsupported-type');
	}
});

test('attachments: images become photos, text is embedded, videos are refused', async t => {
	const image = await readAttachment(
		await approveLocalFile('photo.png', 'attachment', options),
	);
	t.is(image.type, 'photo');

	const text = await readAttachment(
		await approveLocalFile('notes.txt', 'attachment', options),
	);
	t.deepEqual(text, {
		type: 'text',
		displayName: 'notes.txt',
		text: 'hello notes',
	});

	const error = await rejection(
		t,
		readAttachment(await approveLocalFile('clip.mp4', 'attachment', options)),
	);
	t.is(error.code, 'unsupported-type');
});

// ── Size limits ──────────────────────────────────────────────────────────────

test('text embed: below and exactly at the limit pass, above fails', async t => {
	for (const name of ['text-63.txt', 'text-64.txt']) {
		// eslint-disable-next-line no-await-in-loop
		const file = await approveLocalFile(name, 'text-embed', smallLimits);
		// eslint-disable-next-line no-await-in-loop
		const text = await readTextForEmbedding(file);
		t.is(text.length, Number(name.slice(5, 7)));
	}

	const error = await rejection(
		t,
		approveLocalFile('text-65.txt', 'text-embed', smallLimits),
	);
	t.is(error.code, 'too-large');
});

test('photo upload: below and exactly at the limit pass, above fails', async t => {
	for (const name of ['photo-199.png', 'photo-200.png']) {
		// eslint-disable-next-line no-await-in-loop
		const file = await approveLocalFile(name, 'media-upload', smallLimits);
		// eslint-disable-next-line no-await-in-loop
		const media = await readMediaForUpload(file);
		t.is(media.kind, 'photo');
	}

	const file = await approveLocalFile(
		'photo-201.png',
		'media-upload',
		smallLimits,
	);
	const error = await rejection(t, readMediaForUpload(file));
	t.is(error.code, 'too-large');
});

test('attachment: text above the text limit is refused even if small for media', async t => {
	const file = await approveLocalFile('text-65.txt', 'attachment', smallLimits);
	const error = await rejection(t, readAttachment(file));
	t.is(error.code, 'too-large');
});

// ── Approval integrity ───────────────────────────────────────────────────────

test('a file changed after approval is not read', async t => {
	const target = write('work/mutable.txt', 'original');
	const file = await approveLocalFile('mutable.txt', 'text-embed', options);
	fs.writeFileSync(target, 'replaced content that is longer');
	const error = await rejection(t, readTextForEmbedding(file));
	t.is(error.code, 'changed');
});

test('look-alike approval objects are refused', async t => {
	const forged: ApprovedLocalFile = {
		displayName: 'x',
		size: 1,
		purpose: 'text-embed',
	};
	await t.throwsAsync(readTextForEmbedding(forged), {instanceOf: TypeError});
	t.false(
		isPreparedMedia({
			kind: 'photo',
			mime: 'image/png',
			bytes: pngBytes,
			displayName: 'x',
		}),
	);
});

// ── Logging ──────────────────────────────────────────────────────────────────

test('rejections log the reason without the path or file name', async t => {
	await rejection(
		t,
		approveLocalFile('~/.ssh/id_ed25519', 'attachment', options),
	);
	const logs = getLogger()
		.getBufferedLogs()
		.map(entry => entry.message)
		.join('\n');
	t.true(logs.includes('Local file rejected: sensitive (ssh)'));
	t.false(logs.includes(root));
	t.false(logs.includes('id_ed25519'));
});

// ── Isolation ────────────────────────────────────────────────────────────────

test('fixtures and roots live outside the real home locations', t => {
	for (const location of realLocations) {
		t.false(root.startsWith(location));
	}
});

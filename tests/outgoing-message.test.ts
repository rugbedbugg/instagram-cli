/* eslint-disable @typescript-eslint/no-unsafe-call */

import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {InstagramClient} from '../source/client.js';
import type {
	FileAccessOptions,
	PreparedMedia,
} from '../source/utils/local-file-policy.js';
import {
	parseOutgoingMessage,
	planOutgoingMessage,
	sendPlannedMessage,
	uploadLocalMedia,
	type MessageSender,
	type OutgoingMessagePlan,
	type ReadyOutgoingMessagePlan,
} from '../source/utils/outgoing-message.js';

// ── Fixtures (temporary directories only) ────────────────────────────────────

const pngBytes = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instagram-cli-message-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
const options: FileAccessOptions = {
	roots: {homeDir: home, dataDir: path.join(home, '.instagram-cli'), cwd: work},
};
const blockedPath = path.join(home, '.ssh', 'id_ed25519');

test.before(() => {
	fs.mkdirSync(path.join(home, '.ssh'), {recursive: true});
	fs.mkdirSync(work, {recursive: true});
	fs.writeFileSync(path.join(work, 'safe.txt'), 'safe content');
	fs.writeFileSync(path.join(work, 'second.txt'), 'second content');
	fs.writeFileSync(path.join(work, 'pic.png'), pngBytes);
	fs.writeFileSync(path.join(work, 'notes with space.txt'), 'spaced');
	fs.writeFileSync(
		path.join(work, 'sneaky.txt'),
		'-----BEGIN RSA PRIVATE KEY-----\nfake\n',
	);
	fs.writeFileSync(blockedPath, 'fake private key');
});

test.after.always(() => {
	fs.rmSync(root, {recursive: true, force: true});
});

// ── Helpers ──────────────────────────────────────────────────────────────────

type Sent = {texts: string[]; photos: PreparedMedia[]};

function recordingClient(): {client: MessageSender; sent: Sent} {
	const sent: Sent = {texts: [], photos: []};
	const client: MessageSender = {
		async sendMessage(_threadId: string, text: string) {
			sent.texts.push(text);
			return 'text_item';
		},
		async sendPhoto(_threadId: string, media: PreparedMedia) {
			sent.photos.push(media);
			return 'photo_item';
		},
	};
	return {client, sent};
}

/** Plans and, if allowed, sends a message as if the user confirmed. */
async function sendAsUser(
	text: string,
): Promise<{plan: OutgoingMessagePlan; sent: Sent; error?: Error}> {
	const plan = await planOutgoingMessage(text, options);
	const {client, sent} = recordingClient();
	if (plan.status === 'rejected') {
		return {plan, sent};
	}

	try {
		await sendPlannedMessage(plan, client, 'thread_1');
		return {plan, sent};
	} catch (error) {
		return {plan, sent, error: error as Error};
	}
}

function assertNothingSent(t: ExecutionContext, sent: Sent) {
	t.deepEqual(sent.texts, []);
	t.is(sent.photos.length, 0);
}

function assertNoPathLeak(t: ExecutionContext, sent: Sent) {
	for (const text of sent.texts) {
		t.false(text.includes(root), `path leaked into: ${text}`);
		t.false(text.includes('#'), `token leaked into: ${text}`);
	}
}

// ── Parsing ──────────────────────────────────────────────────────────────────

test('plain text and hashtags are not attachments', t => {
	const parsed = parseOutgoingMessage('hello #travel #2024 world');
	t.deepEqual(parsed.attachments, []);
	t.is(parsed.text, 'hello #travel #2024 world');
});

test('URL fragments inside words are not attachments', t => {
	const parsed = parseOutgoingMessage('see https://example.com/app#/route/x');
	t.deepEqual(parsed.attachments, []);
});

test('a backslash-escaped hash is sent literally and never treated as a path', t => {
	const parsed = parseOutgoingMessage(String.raw`look at \#~/notes.txt`);
	t.deepEqual(parsed.attachments, []);
	t.is(parsed.text, 'look at #~/notes.txt');
});

test('quoted tokens allow spaces and trailing punctuation is kept as text', t => {
	const parsed = parseOutgoingMessage(`#"a b.txt" and #c.txt.`);
	t.deepEqual(
		parsed.attachments.map(a => a.requestedPath),
		['a b.txt', 'c.txt'],
	);
	t.is(parsed.text, 'and.');
});

test('planning never reads file content', async t => {
	const plan = await planOutgoingMessage('#safe.txt', options);
	t.is(plan.status, 'ready');
	t.deepEqual(
		(plan as ReadyOutgoingMessagePlan).attachments.map(a => [
			a.displayName,
			a.size,
		]),
		[['safe.txt', 12]],
	);
	t.false(JSON.stringify(plan).includes('safe content'));
});

// ── Message behavior ─────────────────────────────────────────────────────────

test('#safe-file alone sends only the embedded file under its base name', async t => {
	const {sent, error} = await sendAsUser('#safe.txt');
	t.is(error, undefined);
	t.deepEqual(sent.texts, ['--- safe.txt ---\nsafe content']);
	assertNoPathLeak(t, sent);
});

test('text around #safe-file is kept and the token is removed', async t => {
	const {sent} = await sendAsUser('text before #safe.txt text after');
	t.deepEqual(sent.texts, [
		'text before text after\n--- safe.txt ---\nsafe content',
	]);
	assertNoPathLeak(t, sent);
});

test('#blocked-file alone is rejected and nothing is sent', async t => {
	const {plan, sent} = await sendAsUser(`#${blockedPath}`);
	t.is(plan.status, 'rejected');
	assertNothingSent(t, sent);
	t.false(JSON.stringify(plan).includes(root));
});

test('text around #blocked-file is not sent either', async t => {
	const {plan, sent} = await sendAsUser(`hello #${blockedPath} text after`);
	t.is(plan.status, 'rejected');
	assertNothingSent(t, sent);
});

test('the example from the threat model leaks neither content nor path', async t => {
	const {plan, sent} = await sendAsUser('hello #~/.ssh/id_ed25519');
	t.is(plan.status, 'rejected');
	assertNothingSent(t, sent);
});

test('multiple safe tokens: photos upload first, texts embed in order', async t => {
	const {sent} = await sendAsUser(
		'look #pic.png #safe.txt and #"notes with space.txt" #second.txt',
	);
	t.is(sent.photos.length, 1);
	t.is(sent.photos[0]!.displayName, 'pic.png');
	t.deepEqual(sent.texts, [
		'look and\n--- safe.txt ---\nsafe content\n--- notes with space.txt ---\nspaced\n--- second.txt ---\nsecond content',
	]);
	assertNoPathLeak(t, sent);
});

test('one blocked token among several blocks the whole message', async t => {
	const {plan, sent} = await sendAsUser(
		`#pic.png #safe.txt #${blockedPath} #second.txt`,
	);
	t.is(plan.status, 'rejected');
	assertNothingSent(t, sent);
});

test('a missing file blocks the message instead of sending the path', async t => {
	const {plan, sent} = await sendAsUser('see #missing.txt');
	t.is(plan.status, 'rejected');
	assertNothingSent(t, sent);
});

test('secret content found after confirmation sends nothing, not even photos', async t => {
	const {plan, sent, error} = await sendAsUser('#pic.png #sneaky.txt hi');
	t.is(plan.status, 'ready');
	t.truthy(error);
	assertNothingSent(t, sent);
});

test('more than ten attachments are refused', async t => {
	const tokens = Array.from({length: 11}, () => '#safe.txt').join(' ');
	const {plan, sent} = await sendAsUser(tokens);
	t.is(plan.status, 'rejected');
	assertNothingSent(t, sent);
});

// ── Explicit upload entry point and client guard ─────────────────────────────

test('uploadLocalMedia refuses sensitive files before any upload', async t => {
	const uploads: string[] = [];
	const client = {
		async sendPhoto() {
			uploads.push('photo');
			return 'x';
		},
		async sendVideo() {
			uploads.push('video');
			return 'x';
		},
	};
	await t.throwsAsync(
		uploadLocalMedia(client, 'thread_1', blockedPath, 'photo', options),
	);
	t.deepEqual(uploads, []);
});

test('InstagramClient upload methods refuse anything but prepared media', async t => {
	const client = new InstagramClient();
	await t.throwsAsync(
		client.sendPhoto(
			'thread_1',
			path.join(work, 'pic.png') as unknown as PreparedMedia,
		),
		{instanceOf: TypeError},
	);
	await t.throwsAsync(
		client.sendVideo('thread_1', {
			kind: 'video',
			mime: 'video/mp4',
			bytes: pngBytes,
			displayName: 'forged.mp4',
		}),
		{instanceOf: TypeError},
	);
});

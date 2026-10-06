/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- xo cannot resolve ink-testing-library types in tests */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import test from 'ava';
import {render} from 'ink-testing-library';
import {AppMock} from '../source/mocks/app.mock.js';
import {mockThreads} from '../source/mocks/mock-data.js';
import {waitForFrame} from './_wait-for-frame.js';

// The attachment confirmation boundary, exercised through the real chat view
// with the mock client. Files live in a temporary directory only.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instagram-cli-attach-'));
const attachment = path.join(root, 'notes.txt');

test.before(() => {
	fs.writeFileSync(attachment, 'attachment body');
});

test.after.always(() => {
	fs.rmSync(root, {recursive: true, force: true});
});

test.serial(
	'#path waits for confirmation; n sends nothing, y sends the embedded file',
	async t => {
		const {lastFrame, stdin, unmount} = render(<AppMock view="chat" />);

		await waitForFrame(lastFrame, frame =>
			frame.includes(mockThreads[0]!.title),
		);
		stdin.write('\r');
		await waitForFrame(lastFrame, frame => frame.includes('Ctrl+C'));

		// Trailing word closes the #path autocomplete so Enter submits.
		const message = `#${attachment} please`;

		stdin.write(message);
		await waitForFrame(lastFrame, frame => frame.includes('please'));
		stdin.write('\r');
		let frame = await waitForFrame(lastFrame, frame =>
			frame.includes('Send 1 local file(s)'),
		);
		t.true(frame.includes('notes.txt'));
		t.false(frame.includes('attachment body'), 'nothing read before confirm');

		stdin.write('n');
		frame = await waitForFrame(lastFrame, frame =>
			frame.includes('Nothing was sent'),
		);
		t.true(frame.includes('Nothing was sent'));
		t.false(frame.includes('attachment body'));

		stdin.write(message);
		await waitForFrame(lastFrame, frame => frame.includes('please'));
		stdin.write('\r');
		await waitForFrame(lastFrame, frame =>
			frame.includes('Send 1 local file(s)'),
		);
		stdin.write('y');
		frame = await waitForFrame(lastFrame, frame =>
			frame.includes('attachment body'),
		);
		t.true(frame.includes('attachment body'));
		t.false(frame.includes(root), 'absolute path must not be sent');

		unmount();
	},
);

test.serial(
	'#path to a protected file is refused without a prompt',
	async t => {
		const sshDir = path.join(root, '.ssh');
		fs.mkdirSync(sshDir, {recursive: true});
		fs.writeFileSync(path.join(sshDir, 'id_ed25519'), 'fake key');

		const {lastFrame, stdin, unmount} = render(<AppMock view="chat" />);
		await waitForFrame(lastFrame, frame =>
			frame.includes(mockThreads[0]!.title),
		);
		stdin.write('\r');
		await waitForFrame(lastFrame, frame => frame.includes('Ctrl+C'));

		stdin.write(`hello #${path.join(sshDir, 'id_ed25519')} there`);
		await waitForFrame(lastFrame, frame => frame.includes('there'));
		stdin.write('\r');
		const frame = await waitForFrame(lastFrame, frame =>
			frame.includes('Not sent:'),
		);
		t.true(frame.includes('protected location'));
		t.false(frame.includes('Send 1 local file(s)'));
		t.false(frame.includes('fake key'));

		unmount();
	},
);

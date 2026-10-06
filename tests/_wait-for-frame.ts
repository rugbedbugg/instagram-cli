/**
 * Waits until the rendered Ink frame satisfies `predicate`, instead of sleeping
 * for a fixed time and hoping asynchronous work has finished. Resolves with the
 * last frame either way so the calling test's own assertion reports any failure;
 * the timeout only bounds how long a genuinely broken render can hang a test.
 * A frame is written before React runs effects (such as Ink's useInput
 * subscriptions), so after a match it yields once to the event loop; input
 * written right after this resolves is then not dropped.
 * The leading underscore keeps AVA from treating this file as a test.
 */
export async function waitForFrame(
	lastFrame: () => string | undefined,
	predicate: (frame: string) => boolean,
	timeoutMs = 5000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let frame = lastFrame() ?? '';

	while (!predicate(frame) && Date.now() < deadline) {
		// eslint-disable-next-line no-await-in-loop
		await new Promise(resolve => {
			setTimeout(resolve, 10);
		});
		frame = lastFrame() ?? '';
	}

	await new Promise(resolve => {
		setImmediate(resolve);
	});
	return frame;
}

# Mock System for Instagram-CLI

The mock client supports UI development without Instagram credentials or requests. Its output does not demonstrate live service compatibility.

## Run a view

Build with mocks, then choose one view per invocation:

```bash
npm run dev
npm run start:mock -- --chat
npm run start:mock -- --feed
npm run start:mock -- --story
```

`npm run build` creates production output and excludes mocks. Use `npm run dev:watch` to rebuild while editing, and restart the mock command to see changes.

## Files

- `mock-data.ts`: users, threads, messages, feeds, and stories.
- `mock-client.ts`: the mock client implementing the UI-facing methods.
- `use-instagram-client.mock.ts`: the mock client hook.
- `app.mock.tsx` and `cli.mock.ts`: view selection and the mock entry point.
- `index.ts`: shared exports.

Update relevant fixtures when UI expectations change. Tests in `tests/` render mock views with `ink-testing-library` and assert on `lastFrame()`. The AVA setup isolates state through `INSTAGRAM_CLI_HOME`; no real account is needed.

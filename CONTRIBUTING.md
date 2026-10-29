# Contributing

Thanks for helping. Please read the [Code of Conduct](CODE_OF_CONDUCT.md). Architecture overview: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Verified Claude Code formats live in [docs/RESEARCH.md](docs/RESEARCH.md); check it before assuming any hook, transcript or file-history format.

## Dev setup

1. Node.js 22 and npm.
2. `npm ci`
3. Open the folder in VS Code and press **F5** ("Run Extension"). The Extension Development Host opens with the "Claude Control Center" activity bar view.
4. Install the hooks inside the dev host (command "Install Claude Code Hooks") to feed it real sessions.

Note: the repo path may contain spaces (the maintainer's does). The e2e launcher (`test/e2e/runTest.ts`) is custom for that reason; always quote paths in scripts and pass arguments as arrays.

## Layout

- `src/extension.ts`: activation and wiring only.
- `src/collectors/`: hook event and transcript tailing (incremental, bounded).
- `src/services/`: agent state (`agentState.ts` is vscode-free), terminals, mirror, usage, file history, mod bridge.
- `src/views/`: webviews (shell with tabs, dashboard, agents), status card, timeline; pure state builders are vscode-free.
- `src/accounts/`: multi-account and delegation. `src/checkpoints/`: snapshots.
- `hooks/`: dependency-free Node scripts run by Claude Code.
- `mod/`: Claude Code mod plugin and `sub-account-worker` agent. `media/`: webview JS/CSS.

## Coding rules

- Put logic in vscode-free modules and unit-test it; keep `extension.ts` thin.
- Treat transcripts, hook payloads and webview messages as untrusted: validate, bound sizes, escape output, strict CSP with nonce.
- No shell interpolation: `execFile`/`spawn` with argument arrays; prompts go through stdin or files, never argv.
- Background CLI calls use `cliEnv()` (`src/util/cliEnv.ts`) so they do not attach to the IDE.
- Never read credential files or `~/.claude/sessions/*.key`; never log prompts, tokens or command output.
- Changes to `~/.claude/settings.json` need a preview, modal confirmation, a backup and an atomic write.
- No runtime dependencies; do not add dev dependencies without a reason.

## Testing

- `npm run compile`: type-check and bundle.
- `npm run lint`
- `npm run test:unit`: mocha, no VS Code needed. Must stay green.
- `npm test`: e2e smoke test in a downloaded VS Code (on Linux use `xvfb-run -a npm test`).
- Mod: `claude plugin validate ./mod` and `claude plugin test ./mod`.

## Commits and PRs

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). PR checklist (also in the template): compile, lint and unit tests pass; logic is tested; input is validated; docs and CHANGELOG updated; screenshots for UI changes.

## How to add a setting

1. Add it under `contributes.configuration.properties` in `package.json` (type, default, bounds, description).
2. Add the matching entry to `SETTINGS` in `src/views/settingsView.ts` (the Settings tab).
3. Run `npm run test:unit`; the settings sync test fails if the two drift.
4. Read it where needed via `vscode.workspace.getConfiguration('ccc')`, in a thin adapter so logic stays vscode-free.
5. The README settings table is generated from `package.json`; regenerate it.

## How to add a tab

1. Add the id to `TAB_IDS` in `src/views/shellTabs.ts` (and `DASH_TABS` if the dashboard controller serves it).
2. Add a pure state builder (vscode-free) and unit tests, as in `src/views/dashboardState.ts`.
3. Render it in `media/shell.js` / `media/dashboard.js`; escape every dynamic value.
4. Validate every webview message in the controller before acting.

## Release process

1. Update `CHANGELOG.md` and bump `version` in `package.json`.
2. `npm ci && npm run compile && npm run lint && npm run test:unit`.
3. `npm run package` (runs `vsce package --no-dependencies`) and smoke-test the VSIX.
4. Tag `vX.Y.Z` and attach the VSIX to a release.

## Good first issues

- Add unit tests for an untested pure helper.
- Improve a troubleshooting entry or add screenshots to `docs/images/`.
- Add a setting to hide an Activity section.
- Add another export format for sessions (JSON).
- Linux/macOS testing and fixes for process correlation.

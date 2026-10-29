# Claude Code Control Center — VS Code extension

Sidebar + status bar + chat-box mod that monitors Claude Code sessions, agents, terminals, file changes, usage limits, and delegates tasks to sub-accounts. Works alongside the official `anthropic.claude-code` extension; never patches it.

## Commands
- `npm run compile` — tsc type-check + esbuild bundle → `dist/extension.js`
- `npm run lint` — eslint `src` and `test`
- `npm run test:unit` — mocha unit tests (`test/unit/*.test.ts`); must stay green
- `npm test` — e2e smoke test via @vscode/test-electron (custom launcher: path has spaces)
- `npm run package` — builds the VSIX; install with `code --install-extension claude-code-control-center-0.1.0.vsix --force`, then the user reloads the window
- Mod: `claude plugin validate ./mod` and `claude plugin test ./mod` (installed from local marketplace `ccc-local`, read live from `mod/`)

## Layout
- `src/extension.ts` — activation and wiring only
- `src/collectors/` — hook event + transcript tailing (incremental, bounded)
- `src/services/` — agent state (`agentState.ts` is vscode-free), terminals, mirror terminals, usage (`usageCli.ts` = `claude -p /usage`), file history
- `src/views/` — webviews (Activity, Claude Changes), timeline, status card; pure state builders are vscode-free and unit-tested
- `src/accounts/` — multi-account (`CLAUDE_CONFIG_DIR` per account) + delegation
- `hooks/` — dependency-free Node scripts run by Claude Code: `ccc-hook.js` (events), `ccc-statusline.js`, `ccc-delegate.js`, `ccc-mcp.js` (MCP server), `ccc-runner-lib.js`
- `mod/` — Claude Code mod (band above the chat prompt); `agents/sub-account-worker.md`
- `docs/RESEARCH.md` — verified facts about hooks, transcripts, file-history, limits. Check it before assuming any Claude Code format.

## Rules
- Put logic in vscode-free modules and unit-test it; keep `extension.ts` as thin wiring.
- Treat transcripts, hook payloads and webview messages as untrusted: validate, bound sizes, escape output, strict CSP with nonce.
- No shell interpolation: `execFile`/`spawn` with argument arrays; prompts go through stdin/files, never argv.
- Background CLI calls must use `cliEnv()` (`src/util/cliEnv.ts`) so they don't attach to the IDE.
- Never read credential files or `~/.claude/sessions/*.key`; never log prompts, tokens or command output.
- Changes to `~/.claude/settings.json` need a preview, modal confirmation, a backup and an atomic write.
- No runtime dependencies. Don't add dev dependencies without a reason.
- Never claim tests pass without running them.

## Multi-agent workflow (required)
- **Opus supervises.** The main session plans, splits work, writes precise briefs, and verifies results. It does not hand verification to a worker.
- **Workers:** use Sonnet for implementation (`ccc-implementer`) and review (`ccc-reviewer`), and Haiku for searches, log reading and running checks (`ccc-scout`). Run independent workers in parallel.
- **File ownership:** give each parallel worker a disjoint set of files. Shared files (`package.json`, `src/extension.ts`) get small targeted edits only, re-read just before editing.
- **After workers finish,** the supervisor runs `npm run compile && npm run lint && npm run test:unit` itself. If the mod changed, it also runs the mod checks. Only then package and install, and report actual results.
- Standalone, low-context tasks may be delegated to a sub-account via the `control-center:sub-account-worker` agent or the `mcp__ccc-accounts__delegate_task` tool.

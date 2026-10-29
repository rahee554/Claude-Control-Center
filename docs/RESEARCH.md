# Research: Claude Code data sources for the Control Center extension

Verified 2026-10-29 against code.claude.com docs and local files (CLI 2.1.302, VS Code ext 2.1.312).
"Verified locally" = observed in `~/.claude` (Windows 11 dev machine). No secrets or prompt text reproduced.

## 1. Hooks (settings hooks), from https://code.claude.com/docs/en/hooks

All events: SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest,
PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay,
SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle,
InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate,
WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation,
ElicitationResult, SessionEnd.

Common stdin fields (every event):
- `session_id`, `transcript_path`, `cwd`, `hook_event_name`
- `permission_mode` (`default|plan|acceptEdits|auto|dontAsk|bypassPermissions`)
- `prompt_id` (absent before first user input), `scratchpad_dir` (2.1.257+, optional)
- `effort` `{level}` (tool-context events, optional)
- `agent_id`, `agent_type`: present when the hook fires inside a subagent (or `--agent` session).
  This is the way to tell a subagent's PreToolUse/PostToolUse from the main agent's.

Event-specific fields:
| Event | Fields |
|---|---|
| SessionStart | `source` (`startup|resume|clear|compact|fork`), optional `model`, `agent_type`, `session_title`; on resume/fork: `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` |
| SessionEnd | `reason` (`clear|resume|logout|prompt_input_exit|other`) |
| UserPromptSubmit | `prompt`, optional `session_title` |
| PreToolUse | `tool_name`, `tool_input`, `tool_use_id` |
| PostToolUse | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, optional `duration_ms` |
| Notification | `message`, optional `title`, `notification_type` (`permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`) |
| Stop | `stop_hook_active`, `last_assistant_message` (+ background tasks/crons lists) |
| SubagentStart | `agent_id`, `agent_type` |
| SubagentStop | `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons` |
| PreCompact | `trigger` (`manual|auto`), `custom_instructions` (null for auto) |
| PreModelSwitch/PostModelSwitch | `from_model`, `to_model` |

Notes:
- `transcript_path` is the main session JSONL; for subagents use `agent_transcript_path`
  (example from docs: `~/.claude/projects/.../<session>/subagents/agent-<agent_id>.jsonl`).
- Docs recommend `last_assistant_message` over reading the transcript at Stop (file may lag).
- Matchers: SessionStart=`source`, SessionEnd=`reason`, Notification=`notification_type`,
  PreCompact=`trigger`, SubagentStart/Stop=`agent_type`, tool events=`tool_name`.
- Subagent tool name in transcripts/PreToolUse is `Agent` (older: `Task`).

## 2. Transcript JSONL (verified locally)

Location: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`. Slug = cwd with `:`, `\`, `/`, space and `.`
replaced by `-` (e.g. `g--Web-Development-Apps-Projects-ClaudeCode-vscode-exention`). Drive letter case
follows how the cwd was given (both `c--` and `C--` exist), so match case-insensitively.

Subagents: `~/.claude/projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` plus
`agent-<agentId>.meta.json` = `{agentType, description, toolUseId, spawnDepth, requestShape,
launchedWithDefaults, requestNonInteractive, finished}`. `toolUseId` links back to the parent's
`Agent` tool_use block. Lines in subagent files have `isSidechain: true`, `agentId`, same `sessionId`
as the parent.

Line `type` values seen: `user`, `assistant`, `system`, `attachment`, `file-history-snapshot`,
`file-history-delta`, `queue-operation`, `last-prompt`, `ai-title`, `cost-state`, `api-request*`,
`atis-latch`. Unknown types must be ignored, since the set grows between versions.

Common envelope keys on user/assistant/system lines: `uuid`, `parentUuid`, `sessionId`, `timestamp`
(ISO 8601 UTC), `cwd`, `gitBranch`, `version`, `entrypoint` (e.g. `claude-vscode`, `cli`),
`isSidechain`, `userType`; subagent lines also have `agentId`.

Assistant lines: `message` = Anthropic API message: `id`, `model` (e.g. `claude-opus-5-5`), `role`,
`content[]`, `stop_reason`, `usage`. Also `requestId`, `requestedModel`, `effort`.
- `message.usage` keys: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `cache_creation` {ephemeral_5m/1h...}, `server_tool_use`,
  `service_tier`, `iterations`, `speed`, `output_tokens_details`, `inference_geo`.
- One API response can be split over several `assistant` lines (one per content block) that share
  `message.id`/`requestId` and repeat the same usage. **Dedupe by `message.id`** before summing.

Tool use blocks (`content[].type == "tool_use"`, `id`, `name`, `input`):
- Edit: `file_path`, `old_string`, `new_string`, `replace_all`
- Write: `file_path`, `content`
- MultiEdit: `file_path`, `edits[]` (not seen locally in current versions)
- NotebookEdit: `notebook_path`, `new_source`, `cell_id`, `edit_mode` (per tool schema)
Tool results come on the next `user` line as `content[].type=="tool_result"` with `tool_use_id`;
the line also carries `toolUseResult` (for Edit/Write: `filePath`, `oldString`, `newString`,
`originalFile`, `structuredPatch`, `userModified`; for Agent: `agentId`, `status`, ...).

`cost-state` line: `totalCostUSD`, `modelUsage`, `totalLinesAdded`, `totalLinesRemoved`,
`totalDuration`, `totalAPIDuration`, `startTime`. Gives running session cost without summing.
`ai-title` line: `aiTitle` (session title). `system` lines carry hook results (`hookInfos`, `hookErrors`).

## 3. File history `~/.claude/file-history/` (verified locally)

Layout: `~/.claude/file-history/<sessionId>/<hash>@v<N>`
- `<hash>` = first 16 hex chars of SHA-256 of the absolute file path string as recorded
  (verified: sha256(`C:\...\docs\API_CONTRACT.md`)[:16] matched the backup name).
- Each file is the full pre-edit content of that version (plain copy, not a diff).
- Mapping lives in the transcript: `file-history-delta` lines =
  `{messageId, snapshotMessageId, trackingPath, backup:{backupFileName, version, backupTime,
  realParentDir}, timestamp}`. `trackingPath` is the absolute file path.
- `backupFileName: null` = file did not exist before (a Write that created the file); diff against empty.
- `file-history-snapshot` lines (`snapshot.trackedFileBackups`, keyed by path) mark per-prompt
  checkpoints (what `/rewind` uses).
- Diff for a change = backup `@vN` (before) vs. `@vN+1` or the current file on disk (after).

## 4. `~/.claude/ide/*.lock` and `~/.claude/sessions/` (verified locally)

`ide/<port>.lock` (the file name is the WebSocket port of the IDE MCP server run by the official
extension): JSON `{pid, workspaceFolders[], ideName, transport:"ws", runningInWindows, authToken}`.
`pid` is the VS Code extension host, not the CLI. **Never read or log `authToken`.** Stale locks persist.

`sessions/`:
- `<pid>.json`: one per live CLI process: `{pid, sessionId, cwd, startedAt, procStart, version,
  kind, entrypoint, name, nameSource, status, updatedAt, statusUpdatedAt, messagingSocketPath,
  peerProtocol, peerFeatures, pidDomain}`. **Best source to map a terminal's shell child PID to a
  sessionId + transcript.** Check the pid is alive, since stale files can remain.
- `<pid>.<sha>.key`: `{peerToken, procStartFt}`: peer messaging secrets. Do not read or show.

## 5. Account usage limits (5-hour / weekly)

Supported and documented: **status line stdin JSON** (https://code.claude.com/docs/en/statusline):
- `rate_limits.five_hour.used_percentage` (0-100), `rate_limits.five_hour.resets_at` (Unix seconds)
- `rate_limits.seven_day.used_percentage`, `rate_limits.seven_day.resets_at`
- `rate_limits.spend_limit.{used_percentage,resets_at,used_usd,limit_usd,period}` (gateway only)
- Present only for claude.ai Pro/Max (or a gateway spend limit), only after the first API response,
  each window independently optional, dropped after `resets_at` passes.
- Same JSON also carries `session_id`, `transcript_path`, `model.{id,display_name}`,
  `cost.total_cost_usd`, `context_window.{used_percentage,context_window_size,current_usage}`.
- Only runs in the terminal CLI's status line (the user's `statusLine.command`). The extension can
  capture it by wrapping or chaining the user's statusline command, tee-ing stdin to a file, and
  keeping the original output.
Not supported: no file, API or hook that exposes account limits otherwise. `/usage` is interactive UI
only. Scraping OAuth endpoints is undocumented, so don't use it.

## 6. Claude Code mods

- Mods = plugins whose `hooks/register.js` exports `register(on)` with in-process JS/TS handlers
  (`on('tool.call', ...)`, `on('ui.render', {component}, ...)`), with a mods API `$` (`$.ui.invalidate`,
  commands, model calls, files). Layout: `.claude-plugin/plugin.json`, `hooks/hooks.json`,
  `hooks/register.js`. Install: `/plugin install name@marketplace` or `--plugin-dir`.
- Can draw: a pane beside the transcript, a band above the prompt, buttons/inputs, restyle spinner/tool rows.
- Surfaces: CLI 2.1.287+, Desktop 2.1.286+, **VS Code extension chat panel draws mods from
  extension 2.1.299+** (2.1.304+ without feature-flag fetch). Installed ext 2.1.312 qualifies.
  Some elements are terminal-only (see mods reference "render sites/elements").
- So a mod *can* show content in the official chat panel, e.g. a usage/cost band, and a mod sees
  token usage per request in-process. Mods are not sandboxed, and `disableAllHooks` turns them off.
- Docs: https://code.claude.com/docs/en/plugins/mods/overview, samples in
  anthropics/claude-code-playground `claude-code/mods`.

## 7. Prior art

- **edtroleis.claude-code-agents-monitor** (Marketplace, MIT): sidebar of subagents, running/duration,
  recent runs, status bar count. Data: settings hook on Task Pre/PostToolUse writes
  `~/.claude/agent-status.json`, which the extension watches; reads `~/.claude/agents` definitions.
- **Plagemes/claude-mods** (GitHub, MIT): 200+ community mods (guardrails, status lines, panes,
  commands) plus an in-terminal store. TypeScript hook folders. Not affiliated with Anthropic.
- **modmyclaude/claude-code-mods** (GitHub, MIT): curated 25 mods (cost gauges, safety holds, status
  panes), heavily tested, install via `/plugin install <mod>@modmyclaude`.

## 8. VS Code API facts (stable API)

- `Terminal.processId: Thenable<number | undefined>`: PID of the shell. The CLI is a child of it,
  so match the `sessions/<pid>.json` pid via parent-PID lookup (Windows: `wmic`/PowerShell
  `Get-CimInstance Win32_Process` ParentProcessId).
- `Terminal.creationOptions: Readonly<TerminalOptions | ExtensionTerminalOptions>`: `name`, `cwd`,
  `env`, `location`, etc. as created; use `env` to tag terminals you spawn (e.g. a session marker).
- `Terminal.shellIntegration?: TerminalShellIntegration` with `cwd: Uri | undefined` and
  `executeCommand()`; `window.onDidChangeTerminalShellIntegration` fires when it becomes available.
- `window.onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`:
  `e.execution.commandLine.value`, `e.execution.cwd`, `e.terminal`, `onDidEnd` gives `exitCode`.
  Lets you detect `claude ...` launched in any terminal (needs shell integration).
- `TerminalLocation.Editor` (=2) / `TerminalLocation.Panel` (=1); also `{viewColumn}` or
  `{parentTerminal}` (split) as `location` in `createTerminal`.
- Commands: `workbench.action.terminal.split`, `workbench.action.terminal.renameWithArg`
  (args `{name}` and it acts on the active terminal, so call `terminal.show()` first).
- `window.onDidOpenTerminal`, `onDidCloseTerminal`, `onDidChangeActiveTerminal`, `window.terminals`.

## Design implications

- Live state: register settings hooks (SessionStart/End, UserPromptSubmit, Pre/PostToolUse,
  Notification, Stop, SubagentStart/Stop, PreCompact) running a tiny node script that appends the
  stdin JSON to a per-session JSONL the extension watches. Hooks are the only push signal.
- Distinguish subagents by `agent_id`/`agent_type` presence on any hook payload. Get their transcripts
  via `agent_transcript_path` or the `<session>/subagents/` folder plus `.meta.json`.
- Token usage: tail transcripts, sum `message.usage` deduped by `message.id`, group by `message.model`.
  Prefer `cost-state` lines for cost when present.
- File changes: parse `file-history-delta` lines and read `~/.claude/file-history/<session>/<backupFileName>`
  as the "before" side of `vscode.diff`. Null backup means a new file.
- Terminal to session: terminal `processId`, then child process PID, then `~/.claude/sessions/<pid>.json`
  (`sessionId`, `cwd`, `status`). Fallback: the SessionStart hook's `cwd` + timing, or a terminal env marker.
- Rate limits: only via a status-line wrapper (Pro/Max, terminal CLI sessions). Show "unavailable"
  otherwise, never guess.
- Never read `authToken` (ide locks) or `.key` files in sessions/.
- Optional later: a companion mod could draw usage inside the official chat panel (ext 2.1.299+).
- Parse JSONL defensively: unknown `type`s, partial last line while writing, case-varying slugs.

## Multiple accounts (verified 2026-10-29, CLI 2.1.302)

- `CLAUDE_CONFIG_DIR` relocates settings, sessions and credentials — https://code.claude.com/docs/en/settings ("To keep the home-directory files somewhere else, set CLAUDE_CONFIG_DIR"). Verified: `claude auth status` with it set to an empty dir reports `loggedIn:false` and that `configDirectory`.
- Login: `claude auth login`; status: `claude auth status [--json|--text]` (JSON default, exit 1 when logged out).
- `--settings <file-or-json>` sits at the "command line" precedence level; keys it omits keep their file values and lists merge — so passing only `hooks` is additive (same settings page, "Lists merge instead of overriding").
- Windows: the npm `claude.cmd` shim just runs `node_modules/@anthropic-ai/claude-code/bin/claude.exe`, which we spawn directly with `shell:false`.
- `claude -p` reads the prompt from stdin when no positional prompt is given (smoke-tested via the runner).

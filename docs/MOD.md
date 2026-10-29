# control-center mod (changed-files band above the prompt)

`mod/` is a Claude Code plugin (function-hooks module `mod/hooks/register.tsx`) plus the
`sub-account-worker` agent (`mod/agents/`). It shows, Copilot style, directly above the prompt box:

```
▾ 3 files changed  +42 −7  [Keep all]
  dashboardProvider.ts +30 −5  [Keep] [Undo]
  README.md +12 −2  [Keep] [Undo]
subagents 1 · context 34% · 5h 12% · weekly 40%
```

- Click the header to collapse/expand. **Keep** drops a file from the list; **Undo** writes back the
  file text from before the session's first edit of it (kept up to 256KB; not offered for files created
  this session). Opening a diff is not possible: the mods API has no editor/diff call and `Link` on
  remote surfaces only opens `https:` URLs.
- Data: `tool.call` results of Edit/Write/NotebookEdit (`structuredPatch`, `originalFile`), running
  `Agent` calls, and `session.measure` (context %, 5h/weekly windows; `n/a` when not reported).
- `/ccc-changes` hides/shows the band; `/ccc-changes pane` opens the same view as a pane.

## Where it renders

- Hook: `ui.render` on `AbovePrompt`. The 2.1.312 type contract still says AbovePrompt is "raised on the
  terminal and desktop surfaces only", but the VS Code 2.1.312 webview (`webview/index.js`) renders an
  `AbovePrompt` site inside its `data-engine-surface="above-prompt"` container (with inline panes, plugin
  toasts and status lines) directly above the input. So the band is used in VS Code too.
- If a build does not draw it, `/ccc-changes pane` opens a Pane, which is raised on every surface and
  placed inline above the prompt on vscode.
- Counts are per session (state survives reloads, not new sessions). Mods are not sandboxed and are
  disabled by `disableAllHooks`.

## Install (done for this machine)

```
claude plugin marketplace add "G:/Web Development/Apps Projects/ClaudeCode vscode exention"
claude plugin install control-center@ccc-local
```

The marketplace is `.claude-plugin/marketplace.json` (`ccc-local`, source `./mod`). The plugin is read
from the folder, so edits apply at the next session start or `/reload-plugins`. Reload the VS Code window
(or start a new Claude Code session) to see it. Checks: `claude plugin validate ./mod`,
`claude plugin test ./mod`.

## sub-account-worker agent

Installing the plugin gives the agent `control-center:sub-account-worker`. Without the plugin, copy
`agents/sub-account-worker.md` to `~/.claude/agents/`. It needs the `ccc-accounts` MCP server registered
at user scope (Control Center command), so its `mcp__ccc-accounts__*` tools are available to subagents.

`delegate_task` arguments: `prompt`, `account`, `preset` (`read` | `edit` | `run` | `full`; `run` and
`full` need `ccc.delegate.allowRunFromMcp`, also read as `allowFullFromMcp`, default off), `model`, `cwd`,
`contextFiles` (workspace-relative, 200KB total, prepended to the prompt), `appendSystemPrompt`,
`resumeTaskId` (continues that task's session via `--resume`, same account and cwd), `wait`, `timeoutSec`.

## Band UI notes (Copilot-style strip)

- Collapsed (default): one row `› N files changed  +A  -R  [spacer]  Keep  Undo`. Click the label to expand (`⌄`): one row per file (`🗎`, bold name, right-aligned `+A -R`), newest 6 then `+K more` / `show less`. Hidden at 0 files.
- Header Keep hides all files; header Undo restores every file with a kept original (<=256KB) and is hidden when none can be restored. Created files show `(no undo)`. State is per session (`$.state`).
- No footer line (subagents/context/limits live in the sidebar and status bar).
- Cannot match Copilot: the API has no button variants/colors, so Keep is the default chrome `Button` and Undo the same dimmed (not filled accent vs outlined); no custom icons (a `🗎` glyph is used); no file-open/diff link on remote surfaces; the engine draws its own "From the control-center plugin" label; per-file Keep/Undo omitted (counts only).

## Click to open diff (file bridge)
The mods API cannot call VS Code. Pressing a file name writes `{v:1,action:'openDiff',path,sessionId,ts}` to
`~/.control-center/requests/<ts>-<rand>.json`; the extension (`src/services/modBridge.ts`) watches that
directory, validates strictly (absolute non-UNC path inside a workspace folder, session id, ts < 60s), deletes
the file and opens the baseline diff. Invalid requests are ignored. The API has no tooltip prop (hover only
restyles), so there is no "click to open diff" hint. Whether `$.fs.write` creates missing parent dirs is
unverified; the extension creates the directory on activation.

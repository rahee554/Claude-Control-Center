# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0]

### Added
- Sidebar webview with Activity, Changes, Agents, Accounts, Checkpoints and Settings tabs.
- Activity: running sessions, subagents and tasks with state chips; context/5h/weekly/token metrics; per-model usage; messages timeline from local transcripts with revert-to-before-message.
- Changes: per-session changed files with diff, Keep and Undo (from Claude Code file history).
- Agents tree and map; optional Terminals tree.
- Command mirror terminals with output, and replay of recorded commands.
- Checkpoints: manual and automatic workspace snapshots with restore.
- Multiple accounts (`CLAUDE_CONFIG_DIR`), per-account usage polling, task delegation (UI, editor context menu, `ccc-accounts` MCP server, `sub-account-worker` agent).
- Status bar card with limits and running agents; attention alerts; session export to Markdown.
- Hook installer and status-line capture with preview, backup and atomic write of `~/.claude/settings.json`.
- Chat-box mod (`mod/`): changed-files band above the prompt.

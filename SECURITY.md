# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private "Report a vulnerability" (Security tab) for this repository, or email CONTACT_EMAIL. Include the version, steps to reproduce and impact. Expect an acknowledgement within a few days.

## Scope and model

In scope: handling of untrusted input (transcripts, hook payloads, webview messages), webview CSP and escaping, file writes (settings.json edits, Undo, checkpoints), process spawning, the MCP server and delegation permission presets, path validation.

The extension is local-only with no telemetry and no runtime dependencies. It never reads credential files or `~/.claude/sessions/*.key`. Edits to `~/.claude/settings.json` require a preview, modal confirmation, a backup and an atomic write. Please do not include real tokens or prompts in reports.

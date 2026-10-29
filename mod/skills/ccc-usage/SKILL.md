---
name: ccc-usage
description: Check usage limits before big work and adapt when near them. Use when the user asks "how much usage/limit is left", "am I near my limit", or before a large multi-step task.
---

# Usage and limits

## Checking
1. Preferred: call `mcp__ccc-accounts__list_accounts` for cached 5h/weekly % per account (see `ccc-accounts`), or point to the Control Center status bar item.
2. Only if the user asks for exact numbers: run `claude -p /usage` with Bash (plain command, no interpolation). It is a separate CLI call and costs a little; do not poll.
3. Suggest "Refresh Account Limits" in the Command Palette if data looks stale.

## Near a limit (about 80%+ of 5h or weekly)
- **Delegate** standalone work to a sub-account with headroom (`ccc-delegate`, `weight:"heavy"`).
- **Downshift**: suggest `/model haiku` (or delegate with `model:"haiku"`) for light work: searches, formatting, simple edits.
- **Compact**: suggest `/compact` or a fresh session; avoid re-reading large files; use Grep and ranged Read.
- Batch work, skip optional exploration, and tell the user what you deferred.

## Rules
- Never read credential files to find usage.
- Report numbers as cached/approximate and name the account.

---
name: ccc-accounts
description: List Claude accounts and their 5h/weekly usage, explain main vs sub accounts, or help add/log in/switch accounts. Use when the user asks "which accounts do I have", "how much usage is left", "add a sub-account", "switch default account".
---

# Accounts (Control Center)

## Listing
Call `mcp__ccc-accounts__list_accounts` (no args). It returns per account: id, label, role (main/sub), enabled, loggedIn, cached 5h and weekly usage %. Present a compact table. Usage is cached, so say it may be slightly stale; the user can run "Refresh Account Limits".

## Main vs sub
- **Main**: the account this session runs on (default `~/.claude`).
- **Sub**: an extra account with its own `CLAUDE_CONFIG_DIR` and its own subscription limits. Used as a delegation target (see `ccc-delegate`).

## Changes are made by the user
You cannot run VS Code commands. Tell the user to open the Command Palette and run:
- "Add Sub-Account", then "Log In Account" (login happens in the account's own terminal)
- "Switch Default Delegation Account"
- "Set as Main Account", "Enable/Disable Account", "Rename Account", "Remove Account", "Log Out Account"
- "Refresh Accounts" / "Refresh Account Limits"
- "Install Delegation MCP Server (ccc-accounts)" if the tools above are missing

## Safety
- Never read credential files, `.credentials.json`, or `~/.claude/sessions/*.key`.
- Never ask the user to paste tokens.
- Do not delegate to accounts that are disabled or not loggedIn.

---
name: ship
description: Verify, package and install the Claude Code Control Center extension into this VS Code (compile, lint, unit tests, mod checks, VSIX, install).
disable-model-invocation: true
---

Run these in order from the project root. Stop at the first failure and report it with the real output:

1. `npm run compile`
2. `npm run lint`
3. `npm run test:unit`. Report the passing and failing counts.
4. If anything under `mod/` changed: `claude plugin validate ./mod` and `claude plugin test ./mod`.
5. `npm run package`
6. `code --install-extension claude-code-control-center-0.1.0.vsix --force`

Then tell the user to reload the window (Ctrl+Shift+P → Developer: Reload Window). List what changed since the last install.

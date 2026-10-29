---
name: ccc-checkpoint
description: Create or restore a checkpoint around risky multi-file changes. Use when about to do a large refactor, mass rename, migration, or when the user says "checkpoint", "undo all that", "roll back", "restore".
---

# Checkpoints

Checkpoints are VS Code commands; you cannot run them. Ask the user (or suggest) to run them from the Command Palette.

## Before a risky change (3+ files, deletes, renames, generated rewrites)
1. Say so: "This touches many files. Please run **Create Checkpoint** (`ccc.checkpoint.create`) first." Wait for confirmation unless the user said to proceed.
2. If the workspace is a git repo, a fallback is fine: check `git status`, then suggest a commit or `git stash push -u -m "pre-change"`. Do not commit, stash, reset, or clean on your own without being asked.

## Restoring
- Tell the user to run **Restore Checkpoint** (`ccc.checkpoint.restore`) and pick the checkpoint.
- Git fallback: `git stash pop` or `git checkout` of specific files, only on request. Never run `git reset --hard` or `git clean` unprompted.

## Notes
- Checkpoints skip large files and excluded globs (`ccc.checkpoints.exclude`, `ccc.checkpoints.maxFileKB`); warn if big untracked files are involved.
- `ccc.checkpoints.autoOnPrompt` may already snapshot each prompt; still recommend a named one before big work.

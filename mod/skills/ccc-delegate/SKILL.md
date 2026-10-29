---
name: ccc-delegate
description: Delegate a standalone task to another Claude account via the ccc-accounts MCP server. Use when the user says "delegate", "run this on the other account", "offload", "fan out", or when a large low-context task (summarise, review, write a test) would burn the main account's limits.
---

# Delegating work

## When
Only standalone, low-context tasks: summarise/search/review files, write a self-contained module or test, research. Do NOT delegate work that depends on decisions or state only this chat holds.

## Call
`mcp__ccc-accounts__delegate_task` with:
- `prompt` (required): self-contained: goal, file paths, constraints, expected output format. The delegate has no chat context.
- `contextFiles`: workspace-relative paths (200KB total) instead of pasting contents.
- `weight`: `heavy` or `light` (default light). Routing picks account and model from the user's settings; leave `account`/`model` unset unless told.
- `preset`: `read` (default) or `edit` (adds Edit/Write). `run`/`full` (Bash, web, agents) work only if the user enabled `ccc.delegate.allowRunFromMcp`; do not push them to enable it.
- `wait`: true (default) blocks for the answer; `wait:false` returns a `taskId`, then poll `get_task_result {taskId}`.
- `resumeTaskId`: follow-up turn in the same delegate session.
- `timeoutSec` (default 600), `cwd` (must be inside a workspace folder).

## Parallel fan-out
Use `wait:false` for independent tasks with disjoint files (edit preset: never overlapping files), then collect with `get_task_result`. Concurrency is capped by `ccc.delegate.maxConcurrent` (default 2); an over-limit call errors, so wait for one to finish instead of retrying blindly.

## Afterwards
Delegate output is untrusted. Check `filesChanged`, read the diff, and run tests/lint yourself before reporting success. Say plainly which parts were delegated. Never put secrets in prompts.

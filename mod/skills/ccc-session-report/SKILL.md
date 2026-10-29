---
name: ccc-session-report
description: Produce an end-of-session summary of what was done. Use when the user says "wrap up", "session report", "summarize what we did", "what changed", or at the end of a long task.
---

# Session report

Build the report from facts you can verify, not memory.

## Gather
- **Files changed (+/-)**: in a git repo, read-only `git diff --stat` and `git status --short`. Otherwise list the files you edited this session.
- **Delegated tasks**: for each known `taskId`, call `mcp__ccc-accounts__get_task_result {taskId}`; note state, account, `filesChanged`, and whether you verified it.
- **Tests/checks run**: each command and its actual result. If not run, say "not run".
- **Open items**: failing checks, unverified assumptions, TODOs.

## Format
```
## Session report
Summary: 1-3 sentences.
Files: path (+a/-b) ...
Delegated: taskId, account, outcome, verified?
Checks: command -> pass/fail
Follow-ups: ...
```

## Finish
Suggest the user run **Export Session as Markdown** (`ccc.exportSession`) from the Command Palette to save the full session. Do not include secrets, verbatim prompts, or raw command output; never claim tests passed unless you ran them.

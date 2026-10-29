# Bundled skills

The `control-center` plugin (`mod/skills/`) ships five skills. Claude invokes them from their descriptions, or the user can ask by name.

| Skill | Use it for | Example prompt |
|---|---|---|
| `ccc-accounts` | List accounts, 5h/weekly usage, main vs sub, how to add/log in/switch | "Which accounts do I have and how much is left?" |
| `ccc-delegate` | Offload standalone tasks via `delegate_task` / `get_task_result` (weight, preset, contextFiles, resumeTaskId, parallel fan-out) | "Delegate writing tests for src/util to another account" |
| `ccc-checkpoint` | Suggest Create/Restore Checkpoint before risky multi-file changes; git fallback | "Refactor all services, checkpoint first" |
| `ccc-usage` | Check limits, then delegate, downshift to Haiku, or compact | "Am I near my limit before this migration?" |
| `ccc-session-report` | End-of-session summary: files (+/-), delegated tasks, checks, follow-ups; suggests Export Session | "Wrap up and give me a session report" |

Safety: skills never read credentials, never run VS Code commands themselves (they ask the user), and `run`/`full` delegation presets need `ccc.delegate.allowRunFromMcp`.

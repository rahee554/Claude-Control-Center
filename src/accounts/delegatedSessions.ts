// Finds the transcript of a delegated task's session inside its account's config dir. vscode-free.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<configDir>/projects/<slug>/<sessionId>.jsonl` (configDir defaults to ~/.claude), or undefined if not on disk yet. */
export function locateTranscript(configDir: string | undefined, sessionId: unknown): string | undefined {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return undefined;
  const projects = path.join(configDir || path.join(os.homedir(), '.claude'), 'projects');
  try {
    for (const slug of fs.readdirSync(projects).slice(0, 500)) {
      const f = path.join(projects, slug, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch { /* no projects dir yet */ }
  return undefined;
}

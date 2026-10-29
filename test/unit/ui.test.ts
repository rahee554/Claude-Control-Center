import * as assert from 'assert';
import { cleanPrompt, subagentLabel, TimelineReader } from '../../src/views/timeline';
import { hookConfigJson, readToggles, TOGGLE_SETTINGS } from '../../src/views/dashboardState';

describe('injected text stripping', () => {
  it('keeps the user words and drops IDE / reminder / browser blocks', () => {
    const raw = '<ide_opened_file>The user opened the file c:\\x.ts in the IDE.</ide_opened_file>\n<system-reminder>\nbe nice\n</system-reminder>fix the build\n<browser_instruction># Claude in Chrome\nstuff</browser_instruction>';
    assert.deepStrictEqual(cleanPrompt(raw), { text: 'fix the build' });
    assert.strictEqual(cleanPrompt('<ide_selection a="1">sel</ide_selection>  please refactor').text, 'please refactor');
  });
  it('turns purely injected messages into system rows', () => {
    assert.deepStrictEqual(cleanPrompt('<task-notification> <task-id>b1</task-id> <status>completed</status> </task-notification>'), { text: '', system: 'Background task finished' });
    assert.strictEqual(cleanPrompt('<task-notification><status>failed</status></task-notification>').system, 'Background task failed');
    assert.strictEqual(cleanPrompt('<command-name>/clear</command-name><command-args></command-args>').system, 'System event');
    assert.strictEqual(cleanPrompt('<ide_opened_file>x</ide_opened_file>').system, 'Editor context');
  });
  it('leaves ordinary text with angle brackets alone', () => {
    assert.strictEqual(cleanPrompt('why is <div> not centered').text, 'why is <div> not centered');
  });
  it('reader stores the cleaned prompt and system label', () => {
    const r = new TimelineReader('/none.jsonl');
    r.apply(JSON.stringify({ type: 'user', timestamp: new Date(0).toISOString(), message: { content: '<ide_opened_file>f</ide_opened_file>hello' } }));
    r.apply(JSON.stringify({ type: 'user', timestamp: new Date(1000).toISOString(), message: { content: [{ type: 'text', text: '<task-notification><status>completed</status></task-notification>' }] } }));
    assert.deepStrictEqual(r.turns.map((t) => [t.prompt, t.system]), [['hello', undefined], [undefined, 'Background task finished']]);
  });
});

describe('subagent labels', () => {
  it('prefers meta description, then tool description, then prompt first line, then type', () => {
    assert.strictEqual(subagentLabel({ metaDescription: 'Audit CSS', description: 'x', agentType: 'Explore', id: 'a1234567' }), 'Audit CSS');
    assert.strictEqual(subagentLabel({ description: 'Find callers', prompt: 'p' }), 'Find callers');
    assert.strictEqual(subagentLabel({ prompt: '\n<system-reminder>r</system-reminder>\nSearch   the repo for every usage of foo and report back with file paths and line numbers please' }).length, 61);
    assert.strictEqual(subagentLabel({ agentType: 'Explore', id: 'a1234567' }), 'Explore');
    assert.strictEqual(subagentLabel({ id: 'a1234567zz' }), 'subagent a1234567');
  });
});

describe('settings toggles', () => {
  it('maps chatBox to config.json key chatBox', () => {
    assert.deepStrictEqual(JSON.parse(hookConfigJson({ mirror: true, showOutput: true, maxOutputKB: 64, chatBox: false })), { mirrorOutput: true, maxOutputKB: 64, chatBox: false, delegation: true });
    assert.strictEqual(JSON.parse(hookConfigJson({ mirror: false, showOutput: true, maxOutputKB: 8, chatBox: true })).chatBox, true);
    assert.deepStrictEqual(TOGGLE_SETTINGS.chatBox, ['chatBox.enabled', true, false]);
  });
  it('reads every toggle from settings with defaults on', () => {
    const t = readToggles((_k, d) => d, true);
    assert.ok(Object.values(t).every((v) => v === true));
    const off = readToggles(<T>(k: string, d: T) => (k === 'limits.pollMinutes' ? 0 : k === 'chatBox.enabled' ? false : d) as T, false);
    assert.strictEqual(off.limits, false); assert.strictEqual(off.chatBox, false); assert.strictEqual(off.monitoring, false);
    for (const k of Object.keys(TOGGLE_SETTINGS)) assert.ok(k in t, k);
  });
});

describe('fileIcons', () => {
  it('maps names to icon ids and data uris', async () => {
    const { iconId, iconUri } = await import('../../src/views/fileIcons');
    assert.strictEqual(iconId('a.test.ts'), 'test-ts');
    assert.strictEqual(iconId('a.TS'), 'typescript');
    assert.strictEqual(iconId('Makefile'), 'file');
    assert.ok(iconUri('json').startsWith('data:image/svg+xml;utf8,%3Csvg'));
  });
});

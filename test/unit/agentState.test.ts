import * as assert from 'assert';
import { CccEvent } from '../../src/models/events';
import { AgentStore } from '../../src/services/agentState';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
function e(event: string, s: number, extra: Partial<CccEvent> = {}): CccEvent {
  return { v: 1, ts: at(s), event, sessionId: 'S', ...extra };
}
const store = () => new AgentStore({ staleAfterMs: 120000, historyLimit: 100, recentLimit: 5 });

describe('AgentStore lifecycle', () => {
  it('session start -> prompt -> tool -> stop -> end', () => {
    const st = store();
    st.apply(e('SessionStart', 0, { cwd: 'C:/p', pid: 10 }), T0);
    assert.strictEqual(st.snapshot().sessions[0].status, 'waiting');
    st.apply(e('UserPromptSubmit', 1), T0);
    st.apply(e('PreToolUse', 2, { toolName: 'Bash' }), T0);
    let s = st.snapshot().sessions[0];
    assert.strictEqual(s.status, 'running');
    assert.strictEqual(s.currentTool, 'Bash');
    assert.deepStrictEqual(s.pids, [10]);
    st.apply(e('PostToolUse', 3, { toolName: 'Bash' }), T0);
    assert.strictEqual(st.snapshot().sessions[0].currentTool, undefined);
    st.apply(e('Stop', 4), T0);
    assert.strictEqual(st.snapshot().sessions[0].status, 'waiting');
    st.apply(e('SessionEnd', 5), T0);
    s = st.snapshot().recent[0] as typeof s;
    assert.strictEqual(st.snapshot().sessions.length, 0);
    assert.strictEqual(s.status, 'completed');
  });

  it('subagents start, run tools and complete into recent', () => {
    const st = store();
    st.apply(e('SessionStart', 0), T0);
    st.apply(e('SubagentStart', 1, { agentId: 'A', agentType: 'Explore' }), T0);
    st.apply(e('PreToolUse', 2, { agentId: 'A', toolName: 'Grep' }), T0);
    const sub = st.snapshot().sessions[0].subagents[0];
    assert.strictEqual(sub.status, 'running');
    assert.strictEqual(sub.currentTool, 'Grep');
    assert.strictEqual(sub.agentType, 'Explore');
    assert.strictEqual(st.snapshot().sessions[0].status, 'running');
    st.apply(e('SubagentStop', 3, { agentId: 'A' }), T0);
    assert.strictEqual(st.snapshot().sessions[0].subagents.length, 0);
    assert.strictEqual(st.snapshot().recent[0].id, 'A');
    assert.strictEqual(st.snapshot().recent[0].status, 'completed');
  });

  it('marks failures', () => {
    const st = store();
    st.apply(e('SubagentStart', 1, { agentId: 'B' }), T0);
    st.apply(e('SubagentStop', 2, { agentId: 'B', isError: true }), T0);
    assert.strictEqual(st.snapshot().recent[0].status, 'failed');
    st.apply(e('StopFailure', 3), T0);
    assert.strictEqual(st.snapshot().recent[0].status, 'failed');
    assert.strictEqual(st.snapshot().recent[0].kind, 'session');
  });

  it('out-of-order events never regress state', () => {
    const st = store();
    st.apply(e('PreToolUse', 5, { toolName: 'Edit' }), T0);
    st.apply(e('SessionStart', 0), T0); // late arrival
    const s = st.snapshot().sessions[0];
    assert.strictEqual(s.status, 'running');
    assert.strictEqual(s.currentTool, 'Edit');
    assert.strictEqual(s.startTime, T0, 'start time takes the earliest ts');
    st.apply(e('SessionEnd', 10), T0);
    st.apply(e('PreToolUse', 7, { toolName: 'Bash' }), T0); // straggler after end
    assert.strictEqual(st.snapshot().sessions.length, 0, 'ended session not resurrected');
    st.apply(e('SessionStart', 20), T0); // resumed later
    assert.strictEqual(st.snapshot().sessions[0].status, 'waiting');
  });

  it('stale detection: silent agents are stale and not counted live', () => {
    const st = store();
    st.apply(e('UserPromptSubmit', 0), T0);
    assert.strictEqual(st.snapshot().activeCount, 1);
    assert.strictEqual(st.refreshStale(T0 + 60000), false);
    assert.strictEqual(st.refreshStale(T0 + 121000), true);
    const snap = st.snapshot();
    assert.strictEqual(snap.sessions[0].stale, true);
    assert.strictEqual(snap.activeCount, 0);
    assert.strictEqual(snap.staleCount, 1);
    st.apply(e('PreToolUse', 200, { toolName: 'Read' }), T0 + 200000);
    assert.strictEqual(st.snapshot().sessions[0].stale, false);
  });

  it('bounds history and recent lists', () => {
    const st = new AgentStore({ staleAfterMs: 1e9, historyLimit: 50, recentLimit: 3 });
    for (let i = 0; i < 100; i++) st.apply(e('PreToolUse', i, { toolName: 'X' + i }), T0);
    assert.strictEqual(st.getHistory().length, 50);
    for (let i = 0; i < 10; i++) {
      st.apply(e('SubagentStart', 200 + i, { agentId: 'a' + i }), T0);
      st.apply(e('SubagentStop', 201 + i, { agentId: 'a' + i }), T0);
    }
    assert.strictEqual(st.snapshot().recent.length, 3);
  });
});

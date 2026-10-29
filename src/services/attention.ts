import { CccEvent, eventTime } from '../models/events';

export type AlertKind = 'permission' | 'input' | 'taskDone' | 'taskFailed';
export interface Alert { kind: AlertKind; sessionId: string; title: string; detail: string }
export interface AlertFlags { enabled: boolean; permission: boolean; input: boolean; tasks: boolean }
export const DEDUPE_MS = 60_000;

const kindOn = (k: AlertKind, f: AlertFlags) =>
  f.enabled && (k === 'permission' ? f.permission : k === 'input' ? f.input : f.tasks);

export class AttentionDecider {
  private last = new Map<string, number>();
  constructor(private activatedAt: number, private now: () => number = Date.now) {}

  private gate(kind: AlertKind, sessionId: string, flags: AlertFlags): boolean {
    if (!kindOn(kind, flags)) return false;
    const key = `${sessionId}\0${kind}`, t = this.now(), prev = this.last.get(key);
    if (prev !== undefined && t - prev < DEDUPE_MS) return false;
    this.last.set(key, t);
    return true;
  }

  /** Hook Notification events only carry the message text (no notification_type), so classify by wording. */
  fromEvent(e: CccEvent, flags: AlertFlags): Alert | undefined {
    if (e.event !== 'Notification' || eventTime(e) < this.activatedAt) return undefined;
    const msg = e.summary ?? '';
    const kind: AlertKind = /permission/i.test(msg) ? 'permission' : 'input';
    if (!this.gate(kind, e.sessionId, flags)) return undefined;
    return kind === 'permission'
      ? { kind, sessionId: e.sessionId, title: 'Claude needs permission', detail: msg }
      : { kind, sessionId: e.sessionId, title: 'Claude is waiting for you', detail: msg };
  }

  /** Call on a task's transition into done/failed (caller tracks previous state). */
  fromTask(taskId: string, state: string, label: string, flags: AlertFlags): Alert | undefined {
    const kind: AlertKind | undefined = state === 'done' ? 'taskDone' : state === 'failed' ? 'taskFailed' : undefined;
    if (!kind || !this.gate(kind, taskId, flags)) return undefined;
    return { kind, sessionId: taskId, title: kind === 'taskDone' ? 'Delegated task finished' : 'Delegated task failed', detail: label };
  }
}

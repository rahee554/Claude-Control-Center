// Minimal vscode-free emitter so services/collectors stay unit-testable. Shape-compatible with vscode.Event.
export interface Disposable { dispose(): void }
export type Event<T> = (listener: (e: T) => void) => Disposable;

export class Emitter<T> {
  private listeners = new Set<(e: T) => void>();
  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try { l(e); } catch { /* a faulty listener must not break the pipeline */ }
    }
  }
  dispose(): void { this.listeners.clear(); }
}

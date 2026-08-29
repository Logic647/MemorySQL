import { EventEmitter } from 'node:events'

/** Minimal typed event bus shared across the host and all plugins. */
export class EventBus {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(100)
  }

  on(event: string, listener: (...args: unknown[]) => void): () => void {
    this.emitter.on(event, listener)
    return () => this.emitter.off(event, listener)
  }

  emit(event: string, ...args: unknown[]): void {
    this.emitter.emit(event, ...args)
  }
}

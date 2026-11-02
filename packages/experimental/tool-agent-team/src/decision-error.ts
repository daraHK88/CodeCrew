/** Sanitized decision failures never retain provider bodies, credentials or file contents. */
export class DecisionError extends Error {
  /** @param code - Stable handling code. @param message - Safe task-relevant recovery guidance. */
  constructor(readonly code: string, message: string) { super(message); this.name = 'DecisionError' }
}

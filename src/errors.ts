/**
 * An error whose message is written for the person reading a tool result, not for
 * a log. The MCP tool boundary turns these into an error response verbatim; every
 * other throw becomes a generic failure, because an unexpected stack trace is not
 * something to hand back to a client.
 */
export class BraintrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BraintrustError';
  }
}

export type SyncServerErrorCode =
  | 'invalid_data'
  | 'not_found'
  | 'version_conflict'
  | 'io';

export class SyncServerError extends Error {
  /** Create an error with a stable machine-readable code and client-safe message. */
  constructor(
    readonly code: SyncServerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SyncServerError';
  }
}

/** Narrow an unknown value to a Node.js filesystem or system error. */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

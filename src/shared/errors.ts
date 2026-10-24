// Error codes shared by main and renderer (ARCHITECTURE.md section 10). Main-process services throw AppError;
// the IPC wrapper turns it into a SerializedError, because Electron passes only an error's message across `invoke`.

export const ERROR_CODES = [
  'INVALID_INPUT',
  'FORBIDDEN_SENDER',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'CONFLICT',
  'PATH_OUTSIDE_PROJECT',
  'PATH_SENSITIVE',
  'PERMISSION_REQUIRED',
  'PERMISSION_DENIED',
  'TOOL_NOT_INSTALLED',
  'TOOL_NOT_RUNNING',
  'TOOL_FAILED',
  'TIMEOUT',
  'CANCELLED',
  'OUTPUT_LIMIT',
  'LIMIT_REACHED',
  'UNSUPPORTED',
  'DB_CORRUPT',
  'DB_NEWER_THAN_APP',
  'MIGRATION_FAILED',
  'SHUTTING_DOWN',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SerializedError {
  code: ErrorCode;
  /** What happened, in plain language. */
  message: string;
  /** What the user can do about it. */
  hint?: string;
  retryable: boolean;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: SerializedError };

export interface AppErrorOptions {
  hint?: string;
  retryable?: boolean;
  cause?: unknown;
  /** Logged after redaction, never sent to the renderer. */
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  serialize(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      retryable: this.retryable,
    };
  }
}

export const INTERNAL_ERROR_MESSAGE = 'Something went wrong. Details are in the log.';

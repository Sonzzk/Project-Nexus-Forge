import { randomUUID } from 'node:crypto';
import { AppError, INTERNAL_ERROR_MESSAGE, type IpcResult } from '@shared/errors';
import type { ChannelName } from '@shared/ipc/channels';
import { contract, type ParsedRequestOf, type ResponseOf } from '@shared/ipc/contract';
import type { Logger } from '../logging';

// Every IPC handler is registered through `handle()` (ARCHITECTURE.md section 6). For each call it checks the sender,
// parses the request with the channel's schema, runs the handler, parses the response, and answers with an IpcResult.
// Electron passes only an error's message across `invoke`, so errors travel inside the result envelope.

export interface IpcContext {
  requestId: string;
  senderUrl: string;
}

/** The parts of Electron's IpcMainInvokeEvent we use. `parent === null` means the main frame. */
export interface InvokeEventLike {
  senderFrame: { url: string; parent: unknown } | null;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: InvokeEventLike, ...args: unknown[]) => unknown): void;
}

export interface IpcDeps {
  ipcMain: IpcMainLike;
  logger: Logger;
  /** True for our own page: `app://renderer`, or the dev server while the app is not packaged. */
  isTrustedUrl(url: string): boolean;
  isShuttingDown(): boolean;
  newRequestId?: () => string;
}

export interface Ipc {
  handle<C extends ChannelName>(
    channel: C,
    fn: (input: ParsedRequestOf<C>, context: IpcContext) => Promise<ResponseOf<C>> | ResponseOf<C>,
  ): void;
}

const fail = (error: AppError): { ok: false; error: ReturnType<AppError['serialize']> } => ({
  ok: false,
  error: error.serialize(),
});

export function createIpc(deps: IpcDeps): Ipc {
  const { ipcMain, logger } = deps;
  const newRequestId = deps.newRequestId ?? randomUUID;

  return {
    handle(channel, fn) {
      const schemas = contract[channel];
      ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<ResponseOf<typeof channel>>> => {
        const requestId = newRequestId();
        const log = logger.child('ipc');
        try {
          if (deps.isShuttingDown())
            return fail(
              new AppError('SHUTTING_DOWN', 'The app is closing, so it cannot take new requests.', {
                retryable: true,
              }),
            );

          const frame = event.senderFrame;
          if (frame === null || frame.parent !== null || !deps.isTrustedUrl(frame.url)) {
            log.warn('request from an untrusted sender was refused', {
              channel,
              requestId,
              url: frame?.url ?? null,
              subframe: frame?.parent !== null,
            });
            return fail(new AppError('FORBIDDEN_SENDER', 'This request did not come from the app window.'));
          }

          if (args.length > 1)
            return fail(new AppError('INVALID_INPUT', `The request to ${channel} had extra arguments.`));
          const request = schemas.request.safeParse(args[0]);
          if (!request.success) {
            log.warn('request failed validation', {
              channel,
              requestId,
              issues: request.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            });
            return fail(
              new AppError('INVALID_INPUT', `The request to ${channel} was not valid.`, {
                hint: 'Check the values and try again.',
              }),
            );
          }

          const value: unknown = await fn(request.data as ParsedRequestOf<typeof channel>, {
            requestId,
            senderUrl: frame.url,
          });
          const response = schemas.response.safeParse(value);
          if (!response.success) {
            log.error('handler returned an invalid response', {
              channel,
              requestId,
              issues: response.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            });
            return fail(new AppError('INTERNAL', INTERNAL_ERROR_MESSAGE));
          }
          return { ok: true, value: response.data as ResponseOf<typeof channel> };
        } catch (error) {
          if (error instanceof AppError) {
            log[error.code === 'INTERNAL' ? 'error' : 'warn']('request failed', {
              channel,
              requestId,
              code: error.code,
              details: error.details,
              error: error.cause,
            });
            return fail(error);
          }
          log.error('unexpected error in handler', { channel, requestId, error });
          return fail(new AppError('INTERNAL', INTERNAL_ERROR_MESSAGE));
        }
      });
    },
  };
}

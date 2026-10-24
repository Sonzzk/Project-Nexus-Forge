import type { z } from 'zod';
import { AppError } from '@shared/errors';

/** Validates input that did not come through IPC (which already validates), with the same kind of error. */
export function parseInput<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new AppError('INVALID_INPUT', `${issue?.path.join('.') || 'The input'} ${issue?.message ?? 'is not valid'}.`, { hint: 'Check the fields and try again.' });
}

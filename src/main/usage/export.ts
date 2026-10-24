import { z } from 'zod';
import { GENERATE_PURPOSES, PROVIDER_IDS } from '@shared/providers';
import { USAGE_STATUSES } from '@shared/usage';
import type { ExportableTable } from '../storage';

// The usage log joins export and import (spec §22). A row that says "running" is not a record this app keeps across a restart.

const id = z.string().min(1).max(64);

export const usageTables: ExportableTable[] = [
  {
    id: 'usage_log',
    label: 'Usage log',
    schema: z.strictObject({
      id,
      project_id: id.nullable(),
      task_id: id.nullable(),
      run_id: id.nullable(),
      purpose: z.enum(GENERATE_PURPOSES),
      provider_id: z.enum(PROVIDER_IDS),
      model: z.string().max(200),
      location: z.enum(['local', 'cloud']),
      status: z.enum(USAGE_STATUSES),
      started_at: z.iso.datetime(),
      ended_at: z.iso.datetime().nullable(),
      input_tokens: z.number().int().min(0).nullable(),
      output_tokens: z.number().int().min(0).nullable(),
      cost_usd: z.number().min(0).nullable(),
      reason: z.string().max(600),
    }),
    key: ['id'],
    parents: [
      { column: 'project_id', table: 'projects', parentColumn: 'id' },
      { column: 'task_id', table: 'tasks', parentColumn: 'id' },
    ],
    check: (row) => (row['status'] === 'running' ? 'a request that was still running cannot be imported' : undefined),
    orderBy: 'started_at, id',
  },
];

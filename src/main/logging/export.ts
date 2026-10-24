import { z } from 'zod';
import { ACTIVITY_SEVERITIES } from '@shared/activity';
import type { ExportableTable } from '../storage';

// The activity history joins export and import (spec §22). Details were redacted when they were recorded.

export const activityTable: ExportableTable = {
  id: 'activity_events',
  label: 'Activity history',
  schema: z.strictObject({
    id: z.string().min(1).max(64),
    occurred_at: z.iso.datetime(),
    kind: z.string().min(1).max(100),
    severity: z.enum(ACTIVITY_SEVERITIES),
    summary: z.string().max(1000),
    project_id: z.string().max(64).nullable(),
    task_id: z.string().max(64).nullable(),
    details_json: z.string().max(100_000).nullable(),
  }),
  key: ['id'],
  orderBy: 'occurred_at, id',
  check(row) {
    if (row['details_json'] === null) return undefined;
    try {
      JSON.parse(String(row['details_json']));
      return undefined;
    } catch {
      return 'the details are not valid JSON';
    }
  },
};

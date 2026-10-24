import { z } from 'zod';
import { DOC_TYPES, MEMORY_STORAGES } from '@shared/context';
import type { ExportableTable, Row } from '../storage';

// Project memory, saved context packs and handoffs join export and import (spec §22).

const isoText = z.iso.datetime();
const parentProject = [{ column: 'project_id', table: 'projects', parentColumn: 'id' }] as const;
const parsesAs = (field: string, shape: 'array' | 'object') => (row: Row): string | undefined => {
  try {
    const value: unknown = JSON.parse(String(row[field]));
    const ok = shape === 'array' ? Array.isArray(value) : typeof value === 'object' && value !== null && !Array.isArray(value);
    return ok ? undefined : `${field} is not the expected JSON`;
  } catch {
    return `${field} is not valid JSON`;
  }
};

export const contextTables: ExportableTable[] = [
  {
    id: 'memory_settings',
    label: 'Memory settings',
    schema: z.strictObject({
      project_id: z.string().min(1).max(64),
      storage: z.enum(MEMORY_STORAGES),
      docs_dir: z.string().max(200).refine((dir) => !/(^|[\\/])\.\.([\\/]|$)|^[a-zA-Z]:|^[\\/]/.test(dir), 'must be a folder inside the project'),
    }),
    key: ['project_id'],
    parents: parentProject,
  },
  {
    id: 'project_docs',
    label: 'Project memory documents',
    schema: z.strictObject({
      project_id: z.string().min(1).max(64),
      doc_type: z.string().min(1).max(40),
      content: z.string().max(262_144),
      updated_at: isoText,
    }),
    key: ['project_id', 'doc_type'],
    parents: parentProject,
    check: (row) => (DOC_TYPES.some((type) => type === row['doc_type']) ? undefined : 'unknown document type'),
  },
  {
    id: 'context_packs',
    label: 'Context packs',
    schema: z.strictObject({
      id: z.string().min(1).max(64),
      project_id: z.string().min(1).max(64),
      title: z.string().max(120),
      task: z.string().max(4000),
      token_budget: z.number().int().min(500).max(200_000),
      destination: z.string().max(120),
      extra_files_json: z.string().max(100_000),
      manifest_json: z.string().max(2_000_000),
      token_estimate: z.number().int().nonnegative(),
      created_at: isoText,
      updated_at: isoText,
    }),
    key: ['id'],
    parents: parentProject,
    check: (row) => parsesAs('extra_files_json', 'array')(row) ?? parsesAs('manifest_json', 'array')(row),
  },
  {
    id: 'handoffs',
    label: 'Session handoffs',
    schema: z.strictObject({
      id: z.string().min(1).max(64),
      project_id: z.string().min(1).max(64),
      created_at: isoText,
      requested: z.string().max(8000),
      changed: z.string().max(8000),
      verified: z.string().max(8000),
      unfinished: z.string().max(8000),
      risks: z.string().max(8000),
      files: z.string().max(8000),
      next_task: z.string().max(8000),
    }),
    key: ['id'],
    parents: parentProject,
    orderBy: 'created_at, id',
  },
];

import { isAbsolute, parse } from 'node:path';
import { z } from 'zod';
import { PROJECT_TYPES } from '@shared/projects';
import type { ExportableTable, Row } from '../storage';
import { keyOf } from './registry';

// Projects join export and import (spec §22). An imported project registers a folder, which normally only the native
// folder picker can do, so the import checks the folder the way the registry does and the user confirms the list first.

const isoText = z.iso.datetime();
const jsonText = (max: number, shape: 'array' | 'object') =>
  z.string().max(max).refine((text) => {
    try {
      const value: unknown = JSON.parse(text);
      return shape === 'array' ? Array.isArray(value) : typeof value === 'object' && value !== null && !Array.isArray(value);
    } catch {
      return false;
    }
  }, `must hold JSON ${shape === 'array' ? 'list' : 'object'}`);

export const projectTables: ExportableTable[] = [
  {
    id: 'projects',
    label: 'Projects',
    schema: z.strictObject({
      id: z.string().min(1).max(64),
      name: z.string().min(1).max(120),
      description: z.string().max(2000),
      type: z.enum(PROJECT_TYPES),
      type_source: z.enum(['detected', 'manual']),
      engine: z.string().max(60).nullable(),
      engine_version: z.string().max(60).nullable(),
      root_path: z.string().min(1).max(1000),
      root_key: z.string().min(1).max(1000),
      status: z.enum(['active', 'paused', 'archived']),
      tags_json: jsonText(10_000, 'array'),
      instructions: z.string().max(20_000),
      ai_prefs_json: jsonText(20_000, 'object'),
      backup_prefs_json: jsonText(20_000, 'object'),
      created_at: isoText,
      updated_at: isoText,
    }),
    key: ['id'],
    unique: [['root_key']],
    orderBy: 'lower(name), id',
    check(row: Row) {
      const path = String(row['root_path']);
      if (!isAbsolute(path) || path.startsWith('\\\\.\\') || path.startsWith('\\\\?\\')) return 'the project folder is not an ordinary absolute path';
      if (keyOf(path) === keyOf(parse(path).root)) return 'a whole drive cannot be a project';
      if (row['root_key'] !== keyOf(path)) return 'the folder key does not match the folder';
      return undefined;
    },
    needsConfirmation: (row) => String(row['root_path']),
  },
  {
    id: 'project_detections',
    label: 'Project detections',
    schema: z.strictObject({
      project_id: z.string().min(1).max(64),
      detected_at: isoText,
      type: z.enum(PROJECT_TYPES),
      confidence: z.enum(['confirmed', 'inferred']),
      engine: z.string().max(60).nullable(),
      engine_version: z.string().max(60).nullable(),
      evidence_json: jsonText(100_000, 'array'),
    }),
    key: ['project_id'],
    parents: [{ column: 'project_id', table: 'projects', parentColumn: 'id' }],
  },
];

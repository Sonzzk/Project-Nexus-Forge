import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, parse, resolve } from 'node:path';
import { AppError } from '@shared/errors';
import {
  PROJECT_TYPE_LABELS,
  type Detection,
  type Project,
  type ProjectPatch,
  type ProjectType,
} from '@shared/projects';
import type { ActivityLog, Logger } from '../logging';
import type { Db } from '../storage';
import { detectProject } from './detect';

// The project registry (spec §6). Registering a folder records where it is; nothing in it is moved, written or deleted,
// and removing a project only forgets it. Only folders the user chose are ever inspected.

export interface ProjectRegistry {
  list(): Project[];
  get(id: string): Project | undefined;
  /** `folder` comes from a native dialog in main, never from the renderer. */
  add(folder: string): Project;
  update(patch: ProjectPatch): Project;
  /** Read the folder's files again; a manual type override is kept. */
  redetect(id: string): Project;
  /** Forgets the project. The folder and everything in it stay exactly as they are. */
  remove(id: string): void;
}

export interface ProjectRegistryOptions {
  db: Db;
  activity: ActivityLog;
  logger: Logger;
  /** Folders that may not be registered, such as the app's own data folder. */
  protectedDirs?: readonly string[];
  now?: () => Date;
  newId?: () => string;
}

interface Row {
  id: string;
  name: string;
  description: string;
  type: ProjectType;
  type_source: 'detected' | 'manual';
  engine: string | null;
  engine_version: string | null;
  root_path: string;
  status: Project['status'];
  tags_json: string;
  instructions: string;
  ai_prefs_json: string;
  backup_prefs_json: string;
  created_at: string;
  updated_at: string;
}

interface DetectionRow {
  type: ProjectType;
  confidence: Detection['confidence'];
  engine: string | null;
  engine_version: string | null;
  evidence_json: string;
}

/** Windows paths are case-insensitive: one key per folder, whatever the spelling. */
export const keyOf = (path: string): string => path.replace(/[\\/]+$/, '').toLowerCase();

const parseJson = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export function createProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
  const { db, activity, logger } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const protectedKeys = (options.protectedDirs ?? []).map((dir) => keyOf(resolve(dir)));

  const loadDetection = (id: string): Detection | undefined => {
    const row = db.get<DetectionRow>(
      'SELECT type, confidence, engine, engine_version, evidence_json FROM project_detections WHERE project_id = ?',
      id,
    );
    if (row === undefined) return undefined;
    return {
      type: row.type,
      confidence: row.confidence,
      ...(row.engine === null ? {} : { engine: row.engine }),
      ...(row.engine_version === null ? {} : { engineVersion: row.engine_version }),
      evidence: parseJson(row.evidence_json, []),
    };
  };

  const toProject = (row: Row): Project => {
    const detection = loadDetection(row.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      type: row.type,
      typeSource: row.type_source,
      ...(row.engine === null ? {} : { engine: row.engine }),
      ...(row.engine_version === null ? {} : { engineVersion: row.engine_version }),
      rootPath: row.root_path,
      status: row.status,
      folderExists: existsSync(row.root_path),
      tags: parseJson<string[]>(row.tags_json, []),
      instructions: row.instructions,
      aiPrefs: parseJson<Record<string, unknown>>(row.ai_prefs_json, {}),
      backupPrefs: parseJson<Record<string, unknown>>(row.backup_prefs_json, {}),
      ...(detection === undefined ? {} : { detection }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };

  const row = (id: string): Row | undefined => db.get<Row>('SELECT * FROM projects WHERE id = ?', id);
  const mustFind = (id: string): Row => {
    const found = row(id);
    if (found === undefined)
      throw new AppError('NOT_FOUND', 'That project is not in the registry.', {
        hint: 'It may have been removed. Reload the project list.',
      });
    return found;
  };

  const storeDetection = (id: string, detection: Detection): void => {
    db.run(
      `INSERT INTO project_detections (project_id, detected_at, type, confidence, engine, engine_version, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET detected_at = excluded.detected_at, type = excluded.type, confidence = excluded.confidence,
         engine = excluded.engine, engine_version = excluded.engine_version, evidence_json = excluded.evidence_json`,
      id,
      now().toISOString(),
      detection.type,
      detection.confidence,
      detection.engine ?? null,
      detection.engineVersion ?? null,
      JSON.stringify(detection.evidence),
    );
  };

  const resolveFolder = (folder: string): string => {
    if (!isAbsolute(folder)) throw new AppError('INVALID_INPUT', 'Choose a folder with the folder picker.');
    let real: string;
    try {
      real = realpathSync(resolve(folder));
    } catch (error) {
      throw new AppError('NOT_FOUND', 'That folder does not exist.', {
        hint: 'Check that the drive is connected and the folder has not been moved.',
        cause: error,
      });
    }
    if (!statSync(real).isDirectory())
      throw new AppError('INVALID_INPUT', 'A project has to be a folder, not a file.');
    if (keyOf(real) === keyOf(parse(real).root))
      throw new AppError('INVALID_INPUT', 'A whole drive cannot be a project.', {
        hint: 'Choose the folder that holds the project.',
      });
    if (protectedKeys.includes(keyOf(real)))
      throw new AppError('INVALID_INPUT', "That is the app's own data folder, so it cannot be a project.");
    return real;
  };

  const effective = (
    detection: Detection,
    project: Row | undefined,
    override: ProjectType | null | undefined,
  ): {
    type: ProjectType;
    source: 'detected' | 'manual';
    engine: string | null;
    engineVersion: string | null;
  } => {
    const manual =
      override === undefined
        ? project?.type_source === 'manual'
          ? project.type
          : undefined
        : (override ?? undefined);
    if (manual !== undefined && manual !== detection.type)
      return { type: manual, source: 'manual', engine: null, engineVersion: null };
    return {
      type: detection.type,
      source: manual === undefined ? 'detected' : 'manual',
      engine: detection.engine ?? null,
      engineVersion: detection.engineVersion ?? null,
    };
  };

  const get = (id: string): Project | undefined => {
    const found = row(id);
    return found === undefined ? undefined : toProject(found);
  };

  return {
    list: () => db.all<Row>('SELECT * FROM projects ORDER BY lower(name), id').map(toProject),
    get,

    add(folder) {
      const real = resolveFolder(folder);
      const existing = db.get<{ id: string; name: string }>(
        'SELECT id, name FROM projects WHERE root_key = ?',
        keyOf(real),
      );
      if (existing !== undefined)
        throw new AppError('ALREADY_EXISTS', `That folder is already registered as "${existing.name}".`, {
          hint: 'Select it from the project list instead.',
        });

      const detection = detectProject(real);
      const id = newId();
      const stamp = now().toISOString();
      db.transaction(() => {
        db.run(
          `INSERT INTO projects (id, name, description, type, type_source, engine, engine_version, root_path, root_key, status, created_at, updated_at)
           VALUES (?, ?, '', ?, 'detected', ?, ?, ?, ?, 'active', ?, ?)`,
          id,
          basename(real) || real,
          detection.type,
          detection.engine ?? null,
          detection.engineVersion ?? null,
          real,
          keyOf(real),
          stamp,
          stamp,
        );
        storeDetection(id, detection);
      });
      const project = get(id);
      if (project === undefined) throw new AppError('INTERNAL', 'The project was not saved.');
      activity.record({
        kind: 'project.added',
        severity: 'info',
        summary: `Added project "${project.name}" (${PROJECT_TYPE_LABELS[project.type]}).`,
        projectId: id,
        details: {
          type: project.type,
          confidence: detection.confidence,
          evidence: detection.evidence.map((e) => e.path),
        },
      });
      logger.info('project added', { id, type: project.type });
      return project;
    },

    update(patch) {
      const current = mustFind(patch.id);
      const changed: string[] = [];
      const sets: string[] = [];
      const values: (string | null)[] = [];
      const set = (column: string, value: string | null, label: string): void => {
        sets.push(`${column} = ?`);
        values.push(value);
        changed.push(label);
      };
      if (patch.name !== undefined && patch.name !== current.name) set('name', patch.name, 'name');
      if (patch.description !== undefined && patch.description !== current.description)
        set('description', patch.description, 'description');
      if (patch.instructions !== undefined && patch.instructions !== current.instructions)
        set('instructions', patch.instructions, 'instructions');
      if (patch.status !== undefined && patch.status !== current.status)
        set('status', patch.status, 'status');
      if (patch.tags !== undefined) {
        const tags = [...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean))];
        if (JSON.stringify(tags) !== current.tags_json) set('tags_json', JSON.stringify(tags), 'tags');
      }
      if (patch.typeOverride !== undefined) {
        const detection = loadDetection(current.id) ?? {
          type: current.type,
          confidence: 'inferred' as const,
          evidence: [],
        };
        const next = effective(detection, current, patch.typeOverride);
        if (next.type !== current.type || next.source !== current.type_source) {
          set('type', next.type, 'type');
          set('type_source', next.source, 'type source');
          set('engine', next.engine, 'engine');
          set('engine_version', next.engineVersion, 'engine version');
        }
      }
      if (changed.length === 0) return toProject(current);

      db.run(
        `UPDATE projects SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
        ...values,
        now().toISOString(),
        current.id,
      );
      const project = toProject(mustFind(current.id));
      const wasPaused = patch.status !== undefined && patch.status !== current.status;
      activity.record({
        kind: wasPaused
          ? `project.${patch.status === 'active' ? 'resumed' : patch.status}`
          : 'project.updated',
        severity: 'info',
        summary: wasPaused
          ? `Project "${project.name}" is now ${project.status}.`
          : `Updated project "${project.name}": ${changed.join(', ')}.`,
        projectId: project.id,
        details: { changed },
      });
      return project;
    },

    redetect(id) {
      const current = mustFind(id);
      if (!existsSync(current.root_path))
        throw new AppError('NOT_FOUND', `The folder ${current.root_path} could not be found.`, {
          hint: 'Reconnect the drive or restore the folder, then try again. Nothing was changed.',
        });
      const detection = detectProject(current.root_path);
      storeDetection(id, detection);
      const next = effective(detection, current, undefined);
      db.run(
        'UPDATE projects SET type = ?, type_source = ?, engine = ?, engine_version = ?, updated_at = ? WHERE id = ?',
        next.type,
        next.source,
        next.engine,
        next.engineVersion,
        now().toISOString(),
        id,
      );
      const project = toProject(mustFind(id));
      activity.record({
        kind: 'project.redetected',
        severity: 'info',
        summary: `Re-read the files of "${project.name}": ${PROJECT_TYPE_LABELS[detection.type]}.`,
        projectId: id,
        details: { detected: detection.type, effective: project.type, typeSource: project.typeSource },
      });
      return project;
    },

    remove(id) {
      const current = mustFind(id);
      db.run('DELETE FROM projects WHERE id = ?', id); // the detection row goes with it; the folder is not touched
      activity.record({
        kind: 'project.removed',
        severity: 'info',
        summary: `Removed "${current.name}" from the registry. Its folder was not touched.`,
        projectId: id,
      });
      logger.info('project removed', { id });
    },
  };
}

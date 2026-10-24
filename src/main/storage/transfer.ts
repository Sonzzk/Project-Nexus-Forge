import { z } from 'zod';
import { AppError } from '@shared/errors';
import type { ImportConflictMode, ImportPreview, ImportResult, TablePreview } from '@shared/storage';
import type { Db, SqlValue } from './db';

// Export and import of app data as versioned JSON (spec §22, §27.6). Every table joins by registering an ExportableTable,
// so later steps add theirs with one call. An import is validated row by row, previewed, and never overwrites anything
// unless the user chose "replace"; rows that clash with another row's unique value or lack their parent are never imported.

export const EXPORT_FORMAT = 'gdcc-export';
export const EXPORT_FORMAT_VERSION = 1;
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

export type Row = Record<string, string | number | null>;

export interface ExportableTable {
  /** Name in the file; also the SQL table name. */
  id: string;
  label: string;
  /** Build with `z.strictObject`: one field per column; the column list is taken from it. Values are text, integers or null (no blobs). */
  schema: z.ZodObject<Record<string, z.ZodType<string | number | null>>>;
  /** Primary key columns. */
  key: readonly string[];
  /** Other column sets that must be unique; a row that clashes on one is blocked, never replaced. */
  unique?: readonly (readonly string[])[];
  /** Columns that must point at a row of another registered table that is in the app or in the same file. */
  parents?: readonly { column: string; table: string; parentColumn: string }[];
  /** Extra rule beyond the schema; returns a message when the row is not acceptable. */
  check?(row: Row): string | undefined;
  /** For a row that would be added: text the user must confirm first (a project's folder), or undefined if none is needed. */
  needsConfirmation?(row: Row): string | undefined;
  orderBy?: string;
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  exportedAt: string;
  tables: Record<string, Row[]>;
}

export interface ParsedImport {
  file: Pick<ExportFile, 'appVersion' | 'exportedAt' | 'schemaVersion'>;
  /** Validated rows for the tables this version knows, in registration order. */
  tables: { table: ExportableTable; rows: Row[] }[];
  warnings: string[];
}

export interface Transfer {
  register(table: ExportableTable): void;
  tables(): readonly ExportableTable[];
  export(): { file: ExportFile; counts: { id: string; label: string; rows: number }[] };
  /** Throws INVALID_INPUT with the first problems found when the text is not a valid export. */
  parse(text: string): ParsedImport;
  preview(parsed: ParsedImport): {
    tables: TablePreview[];
    newRows: { table: ExportableTable; row: Row }[];
    /** Rows whose key exists in the app with different content; only written when the user chooses to replace. */
    conflictRows: { table: ExportableTable; row: Row }[];
  };
  /** Applies in one transaction. */
  apply(parsed: ParsedImport, mode: ImportConflictMode): ImportResult['tables'];
}

export interface TransferOptions {
  db: Db;
  appVersion: string;
  schemaVersion: () => number;
  now?: () => Date;
}

const columnsOf = (table: ExportableTable): string[] => Object.keys(table.schema.shape);
const quote = (name: string): string => `"${name}"`; // names come from registered code, never from a file
const keyText = (table: ExportableTable, row: Row, columns: readonly string[] = table.key): string =>
  JSON.stringify(columns.map((column) => row[column]));
const same = (table: ExportableTable, a: Row, b: Row): boolean => columnsOf(table).every((c) => a[c] === b[c]);

const invalid = (message: string, hint = 'Choose a file that was exported by this app.'): AppError =>
  new AppError('INVALID_INPUT', message, { hint });

export function createTransfer(options: TransferOptions): Transfer {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const registered: ExportableTable[] = [];

  const load = (table: ExportableTable): Row[] => {
    const columns = columnsOf(table).map(quote).join(', ');
    const order = table.orderBy ?? table.key.map(quote).join(', ');
    return db.all<Row>(`SELECT ${columns} FROM ${quote(table.id)} ORDER BY ${order}`);
  };
  const find = (table: ExportableTable, row: Row): Row | undefined =>
    db.get<Row>(
      `SELECT ${columnsOf(table).map(quote).join(', ')} FROM ${quote(table.id)} WHERE ${table.key.map((c) => `${quote(c)} = ?`).join(' AND ')}`,
      ...table.key.map((c) => row[c] as SqlValue),
    );
  const clash = (table: ExportableTable, row: Row): Row | undefined => {
    for (const columns of table.unique ?? []) {
      const other = db.get<Row>(
        `SELECT ${columnsOf(table).map(quote).join(', ')} FROM ${quote(table.id)} WHERE ${columns.map((c) => `${quote(c)} = ?`).join(' AND ')}`,
        ...columns.map((c) => row[c] as SqlValue),
      );
      if (other !== undefined && keyText(table, other) !== keyText(table, row)) return other;
    }
    return undefined;
  };

  /** Decides what applying one row would do. `inFile` knows the parents and unique values of the file's own rows. */
  const classify = (table: ExportableTable, row: Row, inFile: Map<string, Set<string>>): 'added' | 'same' | 'conflict' | 'blocked' => {
    for (const parent of table.parents ?? []) {
      const value = row[parent.column];
      if (value === null || value === undefined) continue;
      const parentTable = registered.find((t) => t.id === parent.table);
      if (parentTable === undefined) return 'blocked';
      const inApp =
        db.get(`SELECT 1 AS found FROM ${quote(parent.table)} WHERE ${quote(parent.parentColumn)} = ?`, value) !== undefined;
      if (!inApp && !inFile.get(`${parent.table}:${parent.parentColumn}`)?.has(String(value))) return 'blocked';
    }
    if (clash(table, row) !== undefined) return 'blocked';
    const existing = find(table, row);
    if (existing === undefined) return 'added';
    return same(table, existing, row) ? 'same' : 'conflict';
  };

  const upsert = (table: ExportableTable, row: Row, replace: boolean): void => {
    const columns = columnsOf(table);
    const sets = columns.filter((c) => !table.key.includes(c)).map((c) => `${quote(c)} = excluded.${quote(c)}`);
    const conflict =
      replace && sets.length > 0 ? `ON CONFLICT (${table.key.map(quote).join(', ')}) DO UPDATE SET ${sets.join(', ')}` : 'ON CONFLICT DO NOTHING';
    db.run(
      `INSERT INTO ${quote(table.id)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ${conflict}`,
      ...columns.map((c) => row[c] as SqlValue),
    );
  };

  return {
    register(table) {
      if (registered.some((t) => t.id === table.id)) throw new AppError('INTERNAL', `The table ${table.id} is already registered for export.`);
      registered.push(table);
    },
    tables: () => registered,

    export() {
      const tables: Record<string, Row[]> = {};
      const counts: { id: string; label: string; rows: number }[] = [];
      // One read transaction, so the file is a consistent snapshot.
      db.transaction(() => {
        for (const table of registered) {
          tables[table.id] = load(table);
          counts.push({ id: table.id, label: table.label, rows: tables[table.id]?.length ?? 0 });
        }
      });
      return {
        file: {
          format: EXPORT_FORMAT,
          formatVersion: EXPORT_FORMAT_VERSION,
          appVersion: options.appVersion,
          schemaVersion: options.schemaVersion(),
          exportedAt: now().toISOString(),
          tables,
        },
        counts,
      };
    },

    parse(text) {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw invalid('That file is not valid JSON.');
      }
      const envelope = z
        .object({
          format: z.literal(EXPORT_FORMAT),
          formatVersion: z.number().int(),
          appVersion: z.string().max(40),
          schemaVersion: z.number().int().nonnegative(),
          exportedAt: z.iso.datetime(),
          tables: z.record(z.string().max(60), z.array(z.unknown())),
        })
        .safeParse(data);
      if (!envelope.success) throw invalid('That file is not an export from this app.');
      const file = envelope.data;
      if (file.formatVersion > EXPORT_FORMAT_VERSION)
        throw invalid('That export was made by a newer version of the app.', 'Install the newer version, or export again from the version that made the file.');
      if (file.formatVersion < 1) throw invalid('That export has an unknown format version.');

      const warnings: string[] = [];
      for (const id of Object.keys(file.tables))
        if (!registered.some((t) => t.id === id)) warnings.push(`The file has a "${id}" table this version does not know; it was ignored.`);

      const problems: string[] = [];
      const tables: ParsedImport['tables'] = [];
      for (const table of registered) {
        const raw = file.tables[table.id];
        if (raw === undefined) continue;
        const rows: Row[] = [];
        const seen = new Set<string>();
        raw.forEach((item, index) => {
          if (problems.length >= 20) return;
          const parsed = table.schema.safeParse(item);
          if (!parsed.success) {
            const issue = parsed.error.issues[0];
            problems.push(`${table.label}, row ${index + 1}: ${issue?.path.join('.') || 'row'} ${issue?.message ?? 'is not valid'}`);
            return;
          }
          const row: Row = parsed.data;
          const message = table.check?.(row);
          if (message !== undefined) {
            problems.push(`${table.label}, row ${index + 1}: ${message}`);
            return;
          }
          const key = keyText(table, row);
          if (seen.has(key)) {
            problems.push(`${table.label}, row ${index + 1}: appears twice in the file`);
            return;
          }
          seen.add(key);
          for (const columns of table.unique ?? []) {
            const unique = `${columns.join('+')}:${keyText(table, row, columns)}`;
            if (seen.has(unique)) {
              problems.push(`${table.label}, row ${index + 1}: repeats a value that must be unique (${columns.join(', ')})`);
              return;
            }
            seen.add(unique);
          }
          rows.push(row);
        });
        tables.push({ table, rows });
      }
      if (problems.length > 0)
        throw invalid(`The file has problems, so nothing can be imported: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''}.`, 'Export again from the app, or fix the file. Nothing was changed.');
      return { file: { appVersion: file.appVersion, exportedAt: file.exportedAt, schemaVersion: file.schemaVersion }, tables, warnings };
    },

    preview(parsed) {
      // Rows that will be added so far, by "table:column", so a child row can rely on a parent that arrives in the same file.
      const inFile = new Map<string, Set<string>>();
      const newRows: { table: ExportableTable; row: Row }[] = [];
      const conflictRows: { table: ExportableTable; row: Row }[] = [];
      const tables = parsed.tables.map(({ table, rows }): TablePreview => {
        const counts = { added: 0, same: 0, conflicts: 0, blocked: 0 };
        for (const row of rows) {
          const kind = classify(table, row, inFile);
          if (kind === 'added') {
            counts.added++;
            newRows.push({ table, row });
            for (const column of columnsOf(table)) {
              const set = inFile.get(`${table.id}:${column}`) ?? new Set<string>();
              set.add(String(row[column]));
              inFile.set(`${table.id}:${column}`, set);
            }
          } else if (kind === 'same') counts.same++;
          else if (kind === 'conflict') counts.conflicts++;
          else counts.blocked++;
        }
        return { id: table.id, label: table.label, total: rows.length, ...counts };
      });
      return { tables, newRows, conflictRows };
    },

    apply(parsed, mode) {
      const inFile = new Map<string, Set<string>>(); // parents imported earlier in this transaction are already in the database
      return db.transaction(() =>
        parsed.tables.map(({ table, rows }) => {
          const result = { id: table.id, label: table.label, added: 0, replaced: 0, skipped: 0 };
          for (const row of rows) {
            // Parents come first (registration order), so by now an imported parent row is already in the database.
            const kind = classify(table, row, inFile);
            if (kind === 'added') {
              upsert(table, row, false);
              result.added++;
            } else if (kind === 'conflict' && mode === 'replace') {
              upsert(table, row, true);
              result.replaced++;
            } else if (kind !== 'same') result.skipped++;
          }
          return result;
        }),
      );
    },
  };
}

export type { ImportPreview };

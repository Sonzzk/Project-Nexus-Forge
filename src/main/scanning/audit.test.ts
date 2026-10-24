import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditReport, AuditSection, Finding, GitSummary, SectionId } from '@shared/audit';
import { AuditReportSchema } from '@shared/audit';
import type { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture, snapshotTree } from '../../../test/helpers/tree';
import { createGitService } from '../git';
import { createActivityLog, createRedactor } from '../logging';
import { createProjectRegistry } from '../projects';
import { analyze } from './analyzers';
import { createAuditService, KEEP_PER_PROJECT } from './audit';
import { createProjectReader } from './reader';
import { scanProject } from './scanner';

afterEach(removeTempDirs);

const noGit: GitSummary = { available: true, isRepository: false, message: 'Not a Git repository.' };

async function audit(root: string, git: GitSummary = noGit, projectType: Parameters<typeof analyze>[0]['projectType'] = 'custom') {
  const redactor = createRedactor();
  const scan = await scanProject(root);
  const sections = analyze({ scan, reader: createProjectReader(root), git, projectType, redact: (text) => redactor.redact(text) });
  const section = (id: SectionId): AuditSection => {
    const found = sections.find((s) => s.id === id);
    if (found === undefined) throw new Error(`no section ${id}`);
    return found;
  };
  const titles = (id: SectionId): string[] => section(id).findings.map((f) => f.title);
  const find = (id: SectionId, text: string | RegExp): Finding => {
    const found = section(id).findings.find((f) => (typeof text === 'string' ? f.title.includes(text) : text.test(f.title)));
    if (found === undefined) throw new Error(`no finding "${String(text)}" in ${id}: ${titles(id).join(' | ')}`);
    return found;
  };
  return { sections, section, titles, find, scan };
}

describe('analyzers: a Godot project', () => {
  it('identifies the engine and version from the project file, as confirmed with its path', async () => {
    const { find } = await audit(copyFixture('audit-godot'));
    const finding = find('engine', 'Godot project, engine 4.3');
    expect(finding.kind).toBe('confirmed');
    expect(finding.evidence.map((e) => e.path)).toEqual(['project.godot']);
  });

  it('finds the main scene and the Unreal map settings as confirmed entry points with line numbers', async () => {
    const { find } = await audit(copyFixture('audit-godot'));
    const scene = find('entry-points', 'Godot main scene: res://scenes/main.tscn');
    expect(scene).toMatchObject({ kind: 'confirmed' });
    expect(scene.evidence[0]).toMatchObject({ path: 'project.godot', line: 7 });
    expect(find('entry-points', 'GameDefaultMap').evidence[0]?.path).toBe('Config/DefaultEngine.ini');
  });

  it('counts languages, folders and existing docs from the files', async () => {
    const { titles, find } = await audit(copyFixture('audit-godot'));
    expect(find('languages', 'GDScript').title).toMatch(/GDScript: 3 files/);
    expect(titles('structure')).toEqual(expect.arrayContaining([expect.stringMatching(/^scripts\/ holds 2 files/)]));
    expect(titles('documentation').join(' ')).toContain('README.md');
    expect(titles('documentation').join(' ')).toContain('docs/design.md');
  });

  it('finds TODO, FIXME and open checklist items with file and line, and ignores finished ones', async () => {
    const { section } = await audit(copyFixture('audit-godot'));
    const items = section('unfinished').findings;
    const todo = items.find((f) => f.title === 'TODO: add jump');
    expect(todo).toMatchObject({ kind: 'confirmed' });
    expect(todo?.evidence[0]).toEqual({ path: 'scripts/player.gd', line: 5 });
    expect(items.some((f) => f.title.startsWith('FIXME: read this from a setting'))).toBe(true);
    expect(items.some((f) => f.title === 'Open checklist item: write the first level')).toBe(true);
    expect(items.some((f) => f.title.includes('player movement'))).toBe(false);
  });

  it('follows preload and scene references and marks the result Inferred', async () => {
    const { section, find } = await audit(copyFixture('audit-godot'));
    expect(section('relationships').findings.every((f) => f.kind === 'inferred')).toBe(true);
    expect(find('relationships', 'scripts/util.gd is used by 1 other file').evidence.map((e) => e.path)).toContain('scripts/player.gd');
    expect(find('relationships', 'scripts/player.gd is used by 1 other file').evidence.map((e) => e.path)).toContain('scenes/main.tscn');
  });

  it('finds the test file, and offers no invented build commands', async () => {
    const { find, titles } = await audit(copyFixture('audit-godot'));
    expect(find('commands', 'test file').kind).toBe('confirmed');
    expect(titles('commands').some((t) => t.startsWith('npm run'))).toBe(false);
  });
});

describe('analyzers: a Node project', () => {
  it('lists the package.json scripts as confirmed commands and redacts secrets inside them', async () => {
    const result = await audit(copyFixture('audit-node'));
    const script = result.find('commands', 'npm run publish-docs');
    expect(script.kind).toBe('confirmed');
    expect(script.evidence[0]?.path).toBe('package.json');
    expect(JSON.stringify(result.sections)).not.toContain('hunter2hunter2');
    expect(result.find('commands', 'npm run build').evidence[0]?.detail).toBe('vite build');
    expect(result.find('commands', 'make build').evidence[0]?.path).toBe('Makefile');
  });

  it('reads the main entry and the frameworks from package.json', async () => {
    const { find } = await audit(copyFixture('audit-node'));
    expect(find('entry-points', 'package.json "main" points to dist/main.js').kind).toBe('confirmed');
    expect(find('entry-points', 'src/main.ts looks like an entry point').kind).toBe('inferred');
    expect(find('engine', 'Node project using').title).toMatch(/react.*vite|vite.*react/);
  });

  it('resolves relative TypeScript imports and counts how often a file is used', async () => {
    const { find } = await audit(copyFixture('audit-node'));
    const util = find('relationships', 'src/util.ts is used by');
    expect(util.title).toBe('src/util.ts is used by 3 other files');
    expect(util.evidence.map((e) => e.path)).toEqual(expect.arrayContaining(['src/main.ts', 'src/lib/a.ts', 'src/util.test.ts']));
  });
});

describe('analyzers: duplicates, assets and risks', () => {
  it('finds identical files by content, including binary assets, and does not match same-sized different files', async () => {
    const root = copyFixture('audit-godot');
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
    for (const [path, bytes] of [
      ['assets/tex/a.png', png],
      ['assets/copy/a_copy.png', png],
      ['assets/tex/b.png', Buffer.from(png.map((b) => b ^ 1))],
    ] as const) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), bytes);
    }
    const { section, find } = await audit(root);
    const dupes = section('duplicates').findings.filter((f) => f.kind === 'confirmed');
    expect(dupes).toHaveLength(1);
    expect(dupes[0]?.evidence.map((e) => e.path).sort()).toEqual(['assets/copy/a_copy.png', 'assets/tex/a.png']);
    expect(find('assets', 'Textures: 3 files').kind).toBe('confirmed');
    expect(find('assets', 'Asset folder assets/tex').kind).toBe('confirmed');
  });

  it('reports risks from what is actually missing, and names sensitive files without reading them', async () => {
    const root = copyFixture('audit-godot');
    writeFileSync(join(root, '.env'), 'API_KEY=sk-ant-api03-NeverStoredAnywhere01234');
    const { section, find } = await audit(root);
    const risks = section('risks').findings;
    expect(find('risks', 'No version control').kind).toBe('inferred');
    expect(find('risks', 'Files that may hold credentials').evidence.map((e) => e.path)).toEqual(['.env']);
    expect(risks.some((f) => f.title.startsWith('No automated tests'))).toBe(false);
    expect(JSON.stringify(section('overview'))).not.toContain('NeverStoredAnywhere');
  });

  it('warns about a dirty working tree and a missing .gitignore when Git says so', async () => {
    const git: GitSummary = { available: true, isRepository: true, branch: 'main', changes: { staged: 1, modified: 2, untracked: 0, conflicted: 0 }, recentCommits: [] };
    const { find, titles } = await audit(copyFixture('audit-godot'), git);
    expect(find('risks', 'uncommitted work').severity).toBe('warning');
    expect(find('risks', 'no .gitignore').kind).toBe('confirmed');
    expect(titles('git')).toContain('Branch main, no upstream set');
  });

  it('reports "Not a Git repository" instead of failing, and a missing Git as its own finding', async () => {
    const plain = await audit(copyFixture('audit-godot'));
    expect(plain.titles('git')).toEqual(['Not a Git repository.']);
    const missing = await audit(copyFixture('audit-godot'), { available: false, isRepository: false, message: 'Git was not found on this PC.' });
    expect(missing.titles('git')).toEqual(['Git is not installed or could not be run']);
  });

  it('flags a hand-set project type that no file backs up', async () => {
    const { titles } = await audit(copyFixture('audit-node'), noGit, 'unreal');
    expect(titles('engine').some((t) => t.startsWith('The registered project type is not backed'))).toBe(true);
  });

  it('every confirmed finding names a file, every finding is marked, and an empty folder still produces a full report', async () => {
    const { sections } = await audit(copyFixture('empty-custom'));
    expect(sections.map((s) => s.id)).toHaveLength(13);
    for (const finding of sections.flatMap((s) => s.findings)) {
      expect(['confirmed', 'inferred']).toContain(finding.kind);
      if (finding.kind === 'confirmed') expect(finding.evidence.length).toBeGreaterThan(0);
    }
  });

  it('reports a truncated scan prominently', async () => {
    const root = copyFixture('audit-godot');
    const scan = await scanProject(root, { maxFiles: 3 });
    const sections = analyze({ scan, reader: createProjectReader(root), git: noGit, projectType: 'godot' });
    expect(sections.find((s) => s.id === 'overview')?.findings.some((f) => f.title.startsWith('The scan stopped early'))).toBe(true);
  });
});

describe('audit service', () => {
  async function setup() {
    const { db } = await openMigratedDb();
    const logger = memoryLogger();
    const redactor = createRedactor();
    const activity = createActivityLog({ db, redactor, logger });
    const projects = createProjectRegistry({ db, activity, logger });
    let n = 0;
    const git = createGitService({
      runner: { start: () => { throw new Error('no process expected'); } } as never,
      logger,
      locate: () => undefined,
    });
    let clock = Date.parse('2026-10-24T10:00:00Z');
    const service = createAuditService({
      db,
      projects,
      git,
      activity,
      logger,
      redactor,
      limits: () => ({ maxFiles: 20_000, budgetMs: 8000 }),
      now: () => new Date((clock += 1000)),
      newId: () => `audit-${++n}`,
    });
    return { service, projects, db, activity };
  }
  const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
      return undefined;
    } catch (error) {
      return (error as AppError).code;
    }
  };

  it('audits a registered project, stores a valid report, lists and re-reads it, and changes no file', async () => {
    const { service, projects, activity } = await setup();
    const root = copyFixture('audit-godot');
    const project = projects.add(root);
    const before = snapshotTree(root);

    const report = await service.run(project.id);
    expect(AuditReportSchema.safeParse(report).success).toBe(true);
    expect(report.git).toMatchObject({ available: false });
    expect(report.scan.files).toBeGreaterThan(5);
    expect(snapshotTree(root)).toEqual(before);

    expect(service.latest(project.id)).toEqual(report);
    expect(service.get(project.id, report.id)).toEqual(report);
    expect(service.list(project.id)).toEqual([{ id: report.id, projectId: project.id, finishedAt: report.finishedAt, files: report.scan.files }]);
    expect(activity.list({ kinds: ['audit.finished'], limit: 5 })[0]?.summary).toMatch(/Audited "audit-godot"/);
  });

  it('keeps timestamps, re-runs add a newer audit, only the newest ten are kept, and removing the project removes them', async () => {
    const { service, projects, db } = await setup();
    const project = projects.add(copyFixture('audit-node'));
    expect(service.latest(project.id)).toBeNull();
    const reports: AuditReport[] = [];
    for (let i = 0; i < KEEP_PER_PROJECT + 2; i++) reports.push(await service.run(project.id));
    const listed = service.list(project.id);
    expect(listed).toHaveLength(KEEP_PER_PROJECT);
    expect(listed[0]?.id).toBe(reports.at(-1)?.id);
    expect(new Date(reports[1]?.finishedAt ?? 0) > new Date(reports[0]?.finishedAt ?? 0)).toBe(true);
    expect(await codeOf(Promise.resolve().then(() => service.get(project.id, reports[0]?.id ?? '')))).toBe('NOT_FOUND');
    projects.remove(project.id);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM audits')?.n).toBe(0);
  });

  it('refuses a second audit of the same project at once, an unknown project and a vanished folder', async () => {
    const { service, projects } = await setup();
    const project = projects.add(copyFixture('audit-node'));
    const first = service.run(project.id);
    expect(await codeOf(service.run(project.id))).toBe('CONFLICT');
    await first;
    expect(await codeOf(service.run('nope'))).toBe('NOT_FOUND');
    const { rmSync } = await import('node:fs');
    rmSync(project.rootPath, { recursive: true, force: true });
    expect(await codeOf(service.run(project.id))).toBe('NOT_FOUND');
  });
});

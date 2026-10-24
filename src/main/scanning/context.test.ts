import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handoffMarkdown, HANDOFF_FIELDS } from '@shared/context';
import type { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture, snapshotTree } from '../../../test/helpers/tree';
import { createGitService } from '../git';
import { createActivityLog, createRedactor } from '../logging';
import { createProjectRegistry } from '../projects';
import { createAuditService } from './audit';
import { createHandoffService } from './handoffs';
import { createMemoryService } from './memory';
import { createPackService } from './packs';

afterEach(removeTempDirs);

async function env(fixture: string, answer = true) {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const redactor = createRedactor();
  const activity = createActivityLog({ db, redactor, logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const root = copyFixture(fixture);
  const project = projects.add(root);
  const confirms: { message: string; detail?: string }[] = [];
  const answers = { value: answer };
  const memory = createMemoryService({
    db,
    projects,
    activity,
    confirm: (options) => {
      confirms.push({ message: options.message, ...(options.detail === undefined ? {} : { detail: options.detail }) });
      return Promise.resolve(answers.value);
    },
  });
  const git = createGitService({ runner: { start: () => { throw new Error('no process'); } } as never, logger, locate: () => undefined });
  const audits = createAuditService({ db, projects, git, activity, logger, redactor, limits: () => ({ maxFiles: 20_000, budgetMs: 8000 }) });
  const limits = () => ({ maxFiles: 20_000, budgetMs: 8000 });
  const related = { text: '' };
  const packs = createPackService({ db, projects, memory, activity, limits, relatedTasks: () => related.text });
  const handoffs = createHandoffService({ db, projects, git, audits, activity });
  return { db, root, project, projects, memory, packs, handoffs, audits, confirms, answers, activity, related };
}

const codeOf = async (p: Promise<unknown> | (() => unknown)): Promise<string | undefined> => {
  try {
    await (typeof p === 'function' ? Promise.resolve().then(p) : p);
    return undefined;
  } catch (error) {
    return (error as AppError).code;
  }
};
const write = (root: string, rel: string, content: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

describe('project memory: what to propose', () => {
  it('proposes the three core documents for a project with no documentation, and creates nothing', async () => {
    const e = await env('audit-node');
    const before = snapshotTree(e.root);
    const overview = e.memory.overview(e.project.id);
    expect(overview).toMatchObject({ storage: 'app' });
    expect(overview.proposal.map((p) => p.type)).toEqual(['PROJECT_CONTEXT', 'DECISIONS', 'SESSION_HANDOFF']);
    expect(overview.docs.every((d) => !d.exists)).toBe(true);
    expect(snapshotTree(e.root)).toEqual(before);
  });

  it('looks at the project first: documents it already has are not proposed, and are pointed out', async () => {
    const e = await env('audit-node');
    write(e.root, 'docs/DECISIONS.md', '# Decisions\n');
    write(e.root, 'ARCHITECTURE.md', '# Architecture\n');
    const overview = e.memory.overview(e.project.id);
    expect(overview.proposal.map((p) => p.type)).toEqual(['PROJECT_CONTEXT', 'SESSION_HANDOFF']);
    expect(overview.proposal[0]?.reason).toMatch(/already has some documents/);
    expect(overview.docs.find((d) => d.type === 'DECISIONS')).toMatchObject({ exists: false, foundInProject: 'docs/DECISIONS.md' });
    expect(overview.docs.find((d) => d.type === 'ARCHITECTURE')?.foundInProject).toBe('ARCHITECTURE.md');
  });
});

describe('project memory in the app database', () => {
  it('previews a new document, saves it only after the preview, and never touches the project folder', async () => {
    const e = await env('audit-godot');
    const before = snapshotTree(e.root);
    const preview = e.memory.preview(e.project.id, 'PROJECT_CONTEXT', '# Context\n\nA small Godot game.\n');
    expect(preview).toMatchObject({ isNew: true, unchanged: false, createsFolder: false, location: 'App database' });
    expect(preview.diff?.filter((l) => l.kind === 'add')).toHaveLength(3);
    expect(e.memory.read(e.project.id, 'PROJECT_CONTEXT').exists).toBe(false); // a preview saves nothing

    expect(await e.memory.apply(e.project.id, 'PROJECT_CONTEXT')).toEqual({ written: true, location: 'App database' });
    expect(e.memory.read(e.project.id, 'PROJECT_CONTEXT')).toMatchObject({ exists: true, content: '# Context\n\nA small Godot game.\n' });
    expect(e.confirms).toEqual([]); // the app's own database needs no native dialog
    expect(snapshotTree(e.root)).toEqual(before);
  });

  it('shows only the changed lines of an edit, flags an unchanged save, and refuses to save without a preview', async () => {
    const e = await env('audit-godot');
    e.memory.preview(e.project.id, 'DECISIONS', 'one\ntwo\nthree\n');
    await e.memory.apply(e.project.id, 'DECISIONS');
    const edit = e.memory.preview(e.project.id, 'DECISIONS', 'one\nTWO\nthree\n');
    expect(edit.diff?.filter((l) => l.kind === 'add' || l.kind === 'remove').map((l) => `${l.kind}:${'text' in l ? l.text : ''}`)).toEqual(['remove:two', 'add:TWO']);
    expect(e.memory.preview(e.project.id, 'DECISIONS', 'one\ntwo\nthree\n').unchanged).toBe(true);

    const fresh = await env('audit-godot');
    expect(await codeOf(fresh.memory.apply(fresh.project.id, 'DECISIONS'))).toBe('INVALID_INPUT');
    fresh.memory.preview(fresh.project.id, 'DECISIONS', 'x');
    expect(await codeOf(fresh.memory.apply(fresh.project.id, 'TASKS'))).toBe('INVALID_INPUT'); // the preview was for another document
  });

  it('does not save over a document that changed after the preview', async () => {
    const e = await env('audit-godot');
    e.memory.preview(e.project.id, 'TASKS', 'first');
    await e.memory.apply(e.project.id, 'TASKS');
    e.memory.preview(e.project.id, 'TASKS', 'second');
    e.db.run("UPDATE project_docs SET content = 'someone else wrote this' WHERE doc_type = 'TASKS'");
    expect(await codeOf(e.memory.apply(e.project.id, 'TASKS'))).toBe('CONFLICT');
    expect(e.memory.read(e.project.id, 'TASKS').content).toBe('someone else wrote this');
  });

  it('refuses a document that is too large', async () => {
    const e = await env('audit-godot');
    expect(await codeOf(() => e.memory.preview(e.project.id, 'TASKS', 'x'.repeat(300 * 1024)))).toBe('LIMIT_REACHED');
  });
});

describe('project memory inside the project folder', () => {
  it('writes exactly the previewed text after a native confirmation that names the file, and reads it back', async () => {
    const e = await env('audit-godot');
    e.memory.setStorage(e.project.id, 'project', '');
    const text = '# Project context\n\n- Godot 4.3\n- main scene: scenes/main.tscn\n';
    const preview = e.memory.preview(e.project.id, 'PROJECT_CONTEXT', text);
    expect(preview).toMatchObject({ isNew: true, location: 'PROJECT_CONTEXT.md', createsFolder: false });
    expect(existsSync(join(e.root, 'PROJECT_CONTEXT.md'))).toBe(false);

    expect(await e.memory.apply(e.project.id, 'PROJECT_CONTEXT')).toEqual({ written: true, location: 'PROJECT_CONTEXT.md' });
    expect(readFileSync(join(e.root, 'PROJECT_CONTEXT.md'), 'utf8')).toBe(text);
    expect(e.confirms).toHaveLength(1);
    expect(e.confirms[0]?.message).toContain('PROJECT_CONTEXT.md');
    expect(e.confirms[0]?.detail).toContain('creates the file');
  });

  it('writes nothing when the user declines, and leaves no temporary file', async () => {
    const e = await env('audit-godot', false);
    e.memory.setStorage(e.project.id, 'project', '');
    const before = snapshotTree(e.root);
    e.memory.preview(e.project.id, 'DECISIONS', '# Decisions\n');
    expect(await e.memory.apply(e.project.id, 'DECISIONS')).toEqual({ written: false, location: 'DECISIONS.md' });
    expect(snapshotTree(e.root)).toEqual(before);
  });

  it('edits an existing document where it already is, shows the difference, keeps its line endings, and replaces only that file', async () => {
    const e = await env('audit-godot');
    write(e.root, 'docs/DECISIONS.md', '# Decisions\r\n\r\n- Use Godot\r\n');
    e.memory.setStorage(e.project.id, 'project', '');
    const before = snapshotTree(e.root);
    const preview = e.memory.preview(e.project.id, 'DECISIONS', '# Decisions\n\n- Use Godot\n- Keep scenes small\n');
    expect(preview).toMatchObject({ isNew: false, unchanged: false, location: 'docs/DECISIONS.md' });
    expect(preview.diff?.filter((l) => l.kind === 'add')).toEqual([{ kind: 'add', text: '- Keep scenes small' }]);
    await e.memory.apply(e.project.id, 'DECISIONS');
    expect(readFileSync(join(e.root, 'docs/DECISIONS.md'), 'utf8')).toBe('# Decisions\r\n\r\n- Use Godot\r\n- Keep scenes small\r\n');
    const after = snapshotTree(e.root);
    const changed = Object.keys(after).filter((key) => after[key] !== before[key]);
    expect(changed.filter((key) => !key.endsWith('/'))).toEqual(['docs/DECISIONS.md']); // nothing else changed
  });

  it('will not replace a file that changed after the preview', async () => {
    const e = await env('audit-godot');
    write(e.root, 'ROADMAP.md', 'v1');
    e.memory.setStorage(e.project.id, 'project', '');
    e.memory.preview(e.project.id, 'ROADMAP', 'v2');
    write(e.root, 'ROADMAP.md', 'edited in an editor');
    expect(await codeOf(e.memory.apply(e.project.id, 'ROADMAP'))).toBe('CONFLICT');
    expect(readFileSync(join(e.root, 'ROADMAP.md'), 'utf8')).toBe('edited in an editor');
  });

  it('uses a documentation folder inside the project, creating it after the confirmation says so', async () => {
    const e = await env('audit-godot');
    e.memory.setStorage(e.project.id, 'docs-dir', 'Documentation/ai');
    const preview = e.memory.preview(e.project.id, 'SESSION_HANDOFF', '# Handoff\n');
    expect(preview).toMatchObject({ location: 'Documentation/ai/SESSION_HANDOFF.md', createsFolder: true });
    await e.memory.apply(e.project.id, 'SESSION_HANDOFF');
    expect(e.confirms[0]?.detail).toContain('will be created');
    expect(readFileSync(join(e.root, 'Documentation/ai/SESSION_HANDOFF.md'), 'utf8')).toBe('# Handoff\n');
  });

  it('rejects documentation folders that leave the project or are not folders', async () => {
    const e = await env('audit-godot');
    for (const bad of ['..', '../outside', 'docs/../../x', 'C:\\Users\\me', '\\\\server\\share', '', 'a:b'])
      expect(await codeOf(() => e.memory.setStorage(e.project.id, 'docs-dir', bad)), bad).toBe('INVALID_INPUT');
    expect(e.memory.overview(e.project.id).storage).toBe('app');
  });

  it('does not follow a link out of the project', async () => {
    const e = await env('audit-godot');
    const outside = join(e.root, '..', 'outside-target');
    mkdirSync(outside);
    try {
      const { symlinkSync } = await import('node:fs');
      symlinkSync(outside, join(e.root, 'linked'), 'junction');
    } catch {
      return; // links cannot be created here
    }
    e.memory.setStorage(e.project.id, 'docs-dir', 'linked');
    expect(await codeOf(() => e.memory.preview(e.project.id, 'TASKS', 'x'))).toBe('PATH_OUTSIDE_PROJECT');
    expect(existsSync(join(outside, 'TASKS.md'))).toBe(false);
  });
});

describe('context packs', () => {
  const request = (e: Awaited<ReturnType<typeof env>>, task: string, extra: Partial<{ budget: number; extraFiles: string[] }> = {}) => ({
    projectId: e.project.id,
    task,
    budget: extra.budget ?? 8000,
    extraFiles: extra.extraFiles ?? [],
    destination: 'Claude Code (cloud)',
  });

  it('selects files that match the task, says why, stays inside the budget, and changes nothing', async () => {
    const e = await env('audit-godot');
    const before = snapshotTree(e.root);
    const pack = await e.packs.build(request(e, 'Make the player faster: change the speed in util'));
    const paths = pack.items.map((i) => i.path);
    expect(paths).toContain('scripts/util.gd');
    expect(paths).toContain('scripts/player.gd');
    expect(pack.items.find((i) => i.path === 'scripts/util.gd')?.reason).toMatch(/util|speed/);
    expect(pack.estimate).toBeLessThanOrEqual(8000);
    expect(pack.text).toContain('## File: scripts/util.gd');
    expect(pack.text).toContain('Task: Make the player faster');
    expect(pack.destination).toBe('Claude Code (cloud)');
    expect(pack.saved).toBe(false);
    expect(snapshotTree(e.root)).toEqual(before);
  });

  it('leaves binary and unrelated files out, and names a reason when something picked by hand is refused', async () => {
    const e = await env('audit-godot');
    writeFileSync(join(e.root, 'logo.png'), Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]));
    writeFileSync(join(e.root, '.env'), 'API_KEY=sk-ant-api03-NeverInAPack0123456789');
    writeFileSync(join(e.root, 'notes-secret.txt'), 'the combination is 1234');
    write(e.root, 'big.gd', `# player\n${'x = 1\n'.repeat(20_000)}`);
    const pack = await e.packs.build(request(e, 'player movement', { extraFiles: ['logo.png', '.env', 'notes-secret.txt', 'big.gd', 'missing.gd', 'scripts/util.gd'] }));
    const why = Object.fromEntries(pack.excluded.map((x) => [x.path, x.reason]));
    expect(why['logo.png']).toMatch(/binary/);
    expect(why['.env']).toMatch(/credentials/);
    expect(why['notes-secret.txt']).toMatch(/credentials/);
    expect(why['big.gd']).toMatch(/too large/);
    expect(why['missing.gd']).toMatch(/not found/);
    expect(pack.items[0]?.path).toBe('scripts/util.gd'); // picked by hand, so first
    expect(pack.items.map((i) => i.path)).not.toContain('logo.png');
    expect(pack.text).not.toContain('NeverInAPack');
    expect(pack.text).not.toContain('1234');
  });

  it('rejects the whole request when a picked path leaves the project', async () => {
    const e = await env('audit-godot');
    for (const bad of ['../outside.txt', 'C:\\Windows\\win.ini', '\\\\server\\share\\x'])
      expect(await codeOf(e.packs.build(request(e, 'x y z', { extraFiles: [bad] }))), bad).toBe('PATH_OUTSIDE_PROJECT');
  });

  it('puts project instructions and memory first, and respects a small budget by dropping the lowest-ranked files', async () => {
    const e = await env('audit-godot');
    e.projects.update({ id: e.project.id, instructions: 'Use tabs. Never edit main.tscn by hand.' });
    e.memory.preview(e.project.id, 'PROJECT_CONTEXT', '# Context\nA tiny platformer.');
    await e.memory.apply(e.project.id, 'PROJECT_CONTEXT');
    const roomy = await e.packs.build(request(e, 'player speed util scene main'));
    expect(roomy.items.slice(0, 2).map((i) => i.kind)).toEqual(['instructions', 'memory']);
    expect(roomy.text).toContain('Never edit main.tscn by hand');
    const tight = await e.packs.build(request(e, 'player speed util scene main', { budget: 150 }));
    expect(tight.estimate).toBeLessThanOrEqual(150);
    expect(tight.items.length).toBeLessThan(roomy.items.length);
    expect(tight.excluded.some((x) => x.reason === 'over the token budget')).toBe(true);
  });

  it('includes open tasks that mention the same things, and goes stale when they change', async () => {
    const e = await env('audit-godot');
    e.related.text = '- Tune the player speed (ready): speed is configurable';
    const pack = await e.packs.build(request(e, 'player speed'));
    expect(pack.items.find((i) => i.kind === 'tasks')).toMatchObject({ path: 'tasks', reason: 'Open tasks that mention the same things' });
    expect(pack.text).toContain('## Related tasks');
    expect(pack.text).toContain('Tune the player speed');
    const saved = e.packs.save(e.project.id, 'With tasks');
    expect((await e.packs.get(e.project.id, saved.id)).stale).toEqual([]);
    e.related.text = '- Tune the player speed (done)';
    expect((await e.packs.get(e.project.id, saved.id)).stale).toEqual([{ path: 'tasks', change: 'changed' }]);
    e.related.text = '';
    const without = await e.packs.build(request(e, 'player speed'));
    expect(without.items.some((i) => i.kind === 'tasks')).toBe(false);
  });

  it('says when nothing matched instead of padding the pack', async () => {
    const e = await env('audit-godot');
    const pack = await e.packs.build(request(e, 'zzzqqq xylophone'));
    expect(pack.items).toEqual([]);
    expect(pack.excluded[0]?.reason).toMatch(/No file matched/);
  });

  it('a saved pack goes stale when an included file changes or disappears, not when it is only touched, and a refresh makes it fresh', async () => {
    const e = await env('audit-godot');
    await e.packs.build(request(e, 'player speed util'));
    const saved = e.packs.save(e.project.id, 'Player speed');
    expect(saved).toMatchObject({ saved: true, title: 'Player speed' });
    expect(e.packs.list(e.project.id)).toMatchObject([{ id: saved.id, title: 'Player speed', stale: 0 }]);
    expect((await e.packs.get(e.project.id, saved.id)).stale).toEqual([]);

    const util = join(e.root, 'scripts', 'util.gd');
    utimesSync(util, new Date(), new Date(Date.now() + 5000)); // touched: time moves, content does not
    expect(e.packs.list(e.project.id)[0]?.stale).toBe(0);

    writeFileSync(util, `${readFileSync(util, 'utf8')}\n# changed\n`);
    const changed = await e.packs.get(e.project.id, saved.id);
    expect(changed.stale).toEqual([{ path: 'scripts/util.gd', change: 'changed' }]);
    expect(e.packs.list(e.project.id)[0]?.stale).toBe(1);
    expect(changed.text).toContain('# changed'); // the preview shows the files as they are now

    const refreshed = await e.packs.refresh(e.project.id, saved.id);
    expect(refreshed.items.find((i) => i.path === 'scripts/util.gd')?.sha256).not.toBe(saved.items.find((i) => i.path === 'scripts/util.gd')?.sha256);
    expect(e.packs.list(e.project.id)[0]?.stale).toBe(0);

    const { rmSync } = await import('node:fs');
    rmSync(util);
    expect((await e.packs.get(e.project.id, saved.id)).stale).toEqual([{ path: 'scripts/util.gd', change: 'missing' }]);
  });

  it('a saved pack is stale when the memory document or the instructions it used change', async () => {
    const e = await env('audit-godot');
    e.projects.update({ id: e.project.id, instructions: 'Keep it small.' });
    e.memory.preview(e.project.id, 'DECISIONS', '# Decisions\n- one');
    await e.memory.apply(e.project.id, 'DECISIONS');
    await e.packs.build(request(e, 'util'));
    const saved = e.packs.save(e.project.id, '');
    expect(e.packs.list(e.project.id)[0]?.stale).toBe(0);
    e.memory.preview(e.project.id, 'DECISIONS', '# Decisions\n- one\n- two');
    await e.memory.apply(e.project.id, 'DECISIONS');
    e.projects.update({ id: e.project.id, instructions: 'Keep it tiny.' });
    expect((await e.packs.get(e.project.id, saved.id)).stale.map((s) => s.path).sort()).toEqual(['app:DECISIONS', 'instructions']);
  });

  it('saving needs a draft, deleting removes the pack, and removing the project removes its packs', async () => {
    const e = await env('audit-godot');
    expect(await codeOf(() => e.packs.save(e.project.id, 'x'))).toBe('INVALID_INPUT');
    await e.packs.build(request(e, 'util'));
    const saved = e.packs.save(e.project.id, 'a');
    e.packs.remove(e.project.id, saved.id);
    expect(e.packs.list(e.project.id)).toEqual([]);
    expect(await codeOf(e.packs.get(e.project.id, saved.id))).toBe('NOT_FOUND');
    await e.packs.build(request(e, 'util'));
    e.packs.save(e.project.id, 'b');
    e.projects.remove(e.project.id);
    expect(e.db.get<{ n: number }>('SELECT count(*) AS n FROM context_packs')?.n).toBe(0);
  });
});

describe('session handoffs', () => {
  it('drafts from what the app knows (the latest audit), leaving the rest to the person', async () => {
    const e = await env('audit-godot');
    const empty = await e.handoffs.draft(e.project.id);
    expect(empty.unfinished).toBe('');
    await e.audits.run(e.project.id);
    const draft = await e.handoffs.draft(e.project.id);
    expect(draft.unfinished).toContain('TODO: add jump');
    expect(draft.unfinished).toContain('scripts/player.gd:5');
    expect(draft.risks).toContain('No version control');
    expect(draft.requested).toBe('');
    expect(draft.nextTask).toBe('');
  });

  it('saves all seven fields per project, lists newest first, and exposes the latest', async () => {
    const e = await env('audit-godot');
    expect(e.handoffs.latest(e.project.id)).toBeNull();
    const fields = { requested: 'Add jumping', changed: 'player.gd', verified: 'ran the scene', unfinished: 'coyote time', risks: 'none known', files: 'scripts/player.gd', nextTask: 'tune the jump' };
    const first = e.handoffs.save(e.project.id, fields);
    expect(HANDOFF_FIELDS.every((key) => first[key] === fields[key])).toBe(true);
    const second = e.handoffs.save(e.project.id, { ...fields, nextTask: 'add double jump' });
    expect(e.handoffs.latest(e.project.id)?.id).toBe(second.id);
    expect(e.handoffs.list(e.project.id).map((h) => h.id)).toEqual([second.id, first.id]);
  });

  it('refuses an empty handoff, and renders the Markdown in the order of the spec', async () => {
    const e = await env('audit-godot');
    expect(await codeOf(() => e.handoffs.save(e.project.id, { requested: '', changed: ' ', verified: '', unfinished: '', risks: '', files: '', nextTask: '' }))).toBe('INVALID_INPUT');
    const md = handoffMarkdown({ requested: 'A', changed: 'B', verified: '', unfinished: 'D', risks: 'E', files: 'F', nextTask: 'G' }, 'Game', '2026-10-24');
    expect([...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([
      'What was requested', 'What changed', 'What was verified', 'What remains unfinished', 'Known bugs and risks', 'Relevant files and systems', 'Next recommended task',
    ]);
    expect(md).toContain('_Nothing recorded._');
  });
});

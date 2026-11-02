import { BACKROOMS_DOMAINS, CHECKLIST_IDS, DOMAIN_IDS, HORROR_CHECKLIST, type BackroomsDomainId, type ChecklistId, type ProfileView } from '@shared/backrooms';
import { AppError } from '@shared/errors';
import { SCOPE_TIERS } from '@shared/tasks';
import type { ActivityLog } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';
import { describeUnrealProject } from './unreal/project';

// The Backrooms game profile (spec §19), optional and per project. Nothing is switched on or assumed: the profile starts off, every
// domain starts unconfirmed, and what the project's files suggest is shown as a hint to check. A domain becomes a subsystem for tasks
// only once the person confirms it. Flags come from what was confirmed, so a feature that is not in the game is never flagged.

export interface ProfileService {
  get(projectId: string): ProfileView;
  set(patch: { projectId: string; enabled?: boolean | undefined; confirmedDomains?: readonly BackroomsDomainId[] | undefined; checked?: readonly ChecklistId[] | undefined }): ProfileView;
}

export interface ProfileServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  activity: ActivityLog;
  now?: () => Date;
}

interface Row {
  enabled: number;
  domains_json: string;
  checklist_json: string;
}

/** Names in the project that hint at a domain: C++ targets and modules, plugins, Content folders and maps, or (for other engines) top-level folders. */
function hintsFor(rootPath: string): Map<BackroomsDomainId, string[]> {
  const names: { label: string; text: string }[] = [];
  try {
    const p = describeUnrealProject(rootPath);
    if (p !== undefined) {
      for (const t of p.targets) names.push({ label: `Target ${t.name}`, text: t.name });
      for (const m of p.modules) names.push({ label: `Module ${m.name}`, text: m.name });
      for (const x of p.plugins.filter((q) => q.enabled)) names.push({ label: `Plugin ${x.name}`, text: x.name });
      for (const x of p.projectPlugins) names.push({ label: `Project plugin ${x}`, text: x });
      for (const f of p.content.topFolders) names.push({ label: `Content folder ${f.name}`, text: f.name });
      for (const m of p.content.maps) names.push({ label: `Map ${m}`, text: m });
    }
  } catch {
    // an unreadable project simply gives no hints
  }
  const found = new Map<BackroomsDomainId, string[]>();
  for (const domain of BACKROOMS_DOMAINS)
    for (const { label, text } of names) {
      const lower = text.toLowerCase();
      if (domain.keywords.some((k) => lower.includes(k))) {
        const list = found.get(domain.id) ?? [];
        if (list.length < 6 && !list.includes(label)) list.push(label);
        found.set(domain.id, list);
      }
    }
  return found;
}

export function createProfileService(options: ProfileServiceOptions): ProfileService {
  const { db, projects, activity } = options;
  const now = options.now ?? (() => new Date());
  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };

  const view = (projectId: string): ProfileView => {
    const project = projectOf(projectId);
    const row = db.get<Row>("SELECT enabled, domains_json, checklist_json FROM project_profiles WHERE project_id = ? AND profile = 'backrooms'", projectId);
    const enabled = row?.enabled === 1;
    const confirmed = new Set<string>(row === undefined ? [] : (JSON.parse(row.domains_json) as string[]));
    const checked = new Set<string>(row === undefined ? [] : (JSON.parse(row.checklist_json) as string[]));
    const hints = enabled ? hintsFor(project.rootPath) : new Map<BackroomsDomainId, string[]>();
    const flags: ProfileView['flags'] = [];
    if (confirmed.has('multiplayer'))
      flags.push({ id: 'multiplayer', title: 'Multiplayer and networking is in scope', detail: 'Networking multiplies design, testing and bug-fixing work for every other system, and it is hard to add late. Check that it belongs in the release scope and not only in the dream, and prototype it before building content on top of it.' });
    if (confirmed.has('procedural'))
      flags.push({ id: 'procedural', title: 'Procedural generation is in scope', detail: 'An elaborate generator needs tools, seeds, validation and a lot of debugging, and it can make pacing and performance harder to control. Decide what is generated and what is authored, and ship a small authored slice first.' });
    const assets = (() => {
      try {
        return describeUnrealProject(project.rootPath)?.content.assets ?? 0;
      } catch {
        return 0;
      }
    })();
    if (confirmed.size >= 10 || assets > 5000)
      flags.push({ id: 'content', title: 'A large content plan', detail: `${confirmed.size >= 10 ? `${confirmed.size} systems are confirmed. ` : ''}${assets > 5000 ? `The project already has ${assets.toLocaleString('en-US')} assets. ` : ''}Large-scale content production and many systems threaten the budget and timeline of an indie project. Pick a small number of high-impact features and finish them before adding more.` });
    const tiers = SCOPE_TIERS.map((tier) => ({ tier, milestones: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM milestones WHERE project_id = ? AND scope_tier = ?', projectId, tier)?.n ?? 0 }));
    return {
      enabled,
      domains: BACKROOMS_DOMAINS.map((d) => ({ id: d.id, label: d.label, confirmed: confirmed.has(d.id), hints: hints.get(d.id) ?? [] })),
      checklist: HORROR_CHECKLIST.map((c) => ({ id: c.id, label: c.label, question: c.question, checked: checked.has(c.id) })),
      flags: enabled ? flags : [],
      tiers,
      note: enabled ? (confirmed.size === 0 ? 'No system is confirmed yet. The hints below only suggest what the project files contain; confirm what is really in the game and its design.' : '') : 'The profile is off. Turning it on changes nothing in the project; it adds the subsystem list, the checklist and the risk flags to this app.',
    };
  };

  return {
    get: view,
    set({ projectId, enabled, confirmedDomains, checked }) {
      projectOf(projectId);
      const row = db.get<Row>("SELECT enabled, domains_json, checklist_json FROM project_profiles WHERE project_id = ? AND profile = 'backrooms'", projectId);
      const domains = confirmedDomains === undefined ? (row === undefined ? [] : (JSON.parse(row.domains_json) as string[])) : [...new Set(confirmedDomains.filter((d) => DOMAIN_IDS.includes(d)))];
      const list = checked === undefined ? (row === undefined ? [] : (JSON.parse(row.checklist_json) as string[])) : [...new Set(checked.filter((c) => CHECKLIST_IDS.includes(c)))];
      const on = enabled ?? row?.enabled === 1;
      db.run(
        `INSERT INTO project_profiles (project_id, profile, enabled, domains_json, checklist_json, updated_at) VALUES (?, 'backrooms', ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, domains_json = excluded.domains_json, checklist_json = excluded.checklist_json, updated_at = excluded.updated_at`,
        projectId, on ? 1 : 0, JSON.stringify(domains), JSON.stringify(list), now().toISOString(),
      );
      if (enabled !== undefined && enabled !== (row?.enabled === 1)) activity.record({ kind: 'profile.toggled', severity: 'info', summary: `You turned the Backrooms profile ${enabled ? 'on' : 'off'} for "${projectOf(projectId).name}".`, projectId });
      if (confirmedDomains !== undefined) activity.record({ kind: 'profile.domains', severity: 'info', summary: `You confirmed ${domains.length} system${domains.length === 1 ? '' : 's'} for the Backrooms profile of "${projectOf(projectId).name}".`, projectId, details: { domains } });
      return view(projectId);
    },
  };
}

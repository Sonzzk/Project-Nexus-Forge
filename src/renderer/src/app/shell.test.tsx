// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURES, isUsable } from '@shared/feature-status';
import { COMPLETED_THROUGH_STEP } from '@shared/roadmap-steps';
import { allowedNext } from '@shared/tasks';
import { createFakeApi, sampleEvent, samplePack, sampleProject, sampleReport, type FakeApi } from '../../../../test/mocks/fake-api';
import { attachPlanning, sampleTask, type FakePlanning } from '../../../../test/mocks/fake-planning';
import { App } from '../App';
import { createActionHandlers } from './actions';

let fake: FakeApi;

async function setup(options: Parameters<typeof createFakeApi>[0] = {}) {
  fake = createFakeApi(options);
  window.api = fake.api;
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('navigation', { name: 'Main' });
  return user;
}

const sidebar = () => screen.getByRole('navigation', { name: 'Main' });
const savedSettings = () => fake.calls.filter((c) => c.channel === 'settings:set').map((c) => c.input);

beforeEach(() => {
  document.documentElement.removeAttribute('data-density');
});
afterEach(() => vi.restoreAllMocks());

describe('manifest wiring', () => {
  it('has a handler for every usable navigation item and action, and each handler does something', () => {
    const calls: string[] = [];
    const handlers = createActionHandlers({
      go: (section) => calls.push(`go:${section}`),
      toggleSidebar: () => calls.push('sidebar'),
      toggleInspector: () => calls.push('inspector'),
      toggleDensity: () => calls.push('density'),
      addProject: () => calls.push('add'),
    });
    for (const feature of FEATURES.filter((f) => f.kind !== 'card' && isUsable(f))) {
      const handler = handlers[feature.id];
      expect(handler, `${feature.id} is available but has no handler`).toBeDefined();
      const before = calls.length;
      handler?.();
      expect(calls.length, feature.id).toBe(before + 1);
    }
  });

  it('shows exactly the manifest items in the sidebar, and labels every upcoming one', async () => {
    await setup();
    await screen.findByRole('heading', { name: 'Dashboard' });
    const buttons = within(sidebar()).getAllByRole('button');
    const nav = FEATURES.filter((f) => f.kind === 'navigation');
    expect(buttons.map((b) => b.getAttribute('data-feature'))).toEqual(nav.map((f) => f.id));
    for (const feature of nav) {
      const button = buttons.find((b) => b.getAttribute('data-feature') === feature.id);
      if (feature.state === 'upcoming')
        expect(button?.textContent, feature.id).toContain(`Upcoming · Step ${feature.step}`);
      else expect(button?.textContent, feature.id).not.toContain('Upcoming');
    }
  });

  it('shows every upcoming dashboard card with its step, and no card without a manifest entry', async () => {
    await setup();
    await screen.findByRole('heading', { name: 'Dashboard' });
    const cards = [...document.querySelectorAll('[data-feature^="card."]')];
    const manifest = FEATURES.filter((f) => f.kind === 'card');
    expect(cards.map((c) => c.getAttribute('data-feature')).sort()).toEqual(manifest.map((f) => f.id).sort());
    for (const feature of manifest.filter((f) => f.state === 'upcoming')) {
      const card = document.querySelector(`[data-feature="${feature.id}"]`);
      expect(card?.textContent).toContain(`Upcoming · Step ${feature.step}`);
    }
  });
});

describe('navigation', () => {
  it('opens a page for each section; an upcoming one says which step builds it and offers no controls', async () => {
    const user = await setup();
    await user.click(within(sidebar()).getByRole('button', { name: /^Testing/ }));
    expect(screen.getByRole('heading', { name: 'Testing' })).toBeTruthy();
    expect(screen.getByText(/arrives in Step 23/)).toBeTruthy();
    expect(within(document.querySelector('.workspace') as HTMLElement).queryAllByRole('button')).toEqual([]);
    expect(
      within(sidebar())
        .getByRole('button', { name: /^Testing/ })
        .getAttribute('aria-current'),
    ).toBe('page');

    await user.click(within(sidebar()).getByRole('button', { name: 'Implementation Status' }));
    const steps = within(screen.getByRole('list', { name: 'Build steps' })).getAllByRole('listitem');
    expect(steps).toHaveLength(29);
    expect(steps[COMPLETED_THROUGH_STEP - 1]?.textContent).toContain('Done');
    expect(steps[COMPLETED_THROUGH_STEP]?.textContent).toContain('Next');
    expect(steps[4]?.textContent).toContain('Dashboard and UI');
  });

  it('moves focus with the arrow keys, Home and End', async () => {
    const user = await setup();
    await screen.findByRole('heading', { name: 'Dashboard' });
    const buttons = within(sidebar()).getAllByRole('button');
    buttons[0]?.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(buttons[1]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(buttons.at(-1));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(buttons[0]);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(buttons.at(-1));
  });
});

describe('command palette', () => {
  it('opens with Ctrl+K, filters, and Enter runs the navigation', async () => {
    const user = await setup();
    await screen.findByRole('heading', { name: 'Dashboard' });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Command palette' });
    await user.type(input, 'settings');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Command palette' })).toBeNull();
  });

  it('lists every navigation item and action, disables upcoming actions with their step, and closes on Escape', async () => {
    const user = await setup();
    await screen.findByRole('heading', { name: 'Dashboard' });
    await user.click(screen.getByRole('button', { name: 'Open the command palette' }));
    await screen.findByRole('combobox', { name: 'Command palette' });
    const items = [...document.querySelectorAll('[cmdk-item]')];
    const expected = FEATURES.filter((f) => f.kind !== 'card');
    expect(items.map((item) => item.getAttribute('data-feature')).sort()).toEqual(
      expected.map((f) => f.id).sort(),
    );
    for (const feature of expected.filter((f) => f.kind === 'action' && f.state === 'upcoming')) {
      const item = items.find((i) => i.getAttribute('data-feature') === feature.id);
      expect(item?.getAttribute('aria-disabled')).toBe('true');
      expect(item?.textContent).toContain(`Upcoming · Step ${feature.step}`);
    }
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox', { name: 'Command palette' })).toBeNull();
  });

  it('runs an action: switching density changes the page and is saved', async () => {
    const user = await setup();
    await screen.findByRole('heading', { name: 'Dashboard' });
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Command palette' }), 'density');
    await user.keyboard('{Enter}');
    await vi.waitFor(() => expect(document.documentElement.dataset['density']).toBe('compact'));
    expect(savedSettings()).toContainEqual({ key: 'ui.density', value: 'compact' });
  });
});

describe('layout controls and persistence', () => {
  it('collapses the sidebar from the button and from Ctrl+B, saving each change', async () => {
    const user = await setup();
    await screen.findByRole('heading', { name: 'Dashboard' });
    const app = document.querySelector('.app') as HTMLElement;
    expect(app.dataset['sidebar']).toBe('expanded');
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(app.dataset['sidebar']).toBe('collapsed');
    await user.keyboard('{Control>}b{/Control}');
    expect(app.dataset['sidebar']).toBe('expanded');
    expect(savedSettings()).toEqual([
      { key: 'ui.sidebarCollapsed', value: true },
      { key: 'ui.sidebarCollapsed', value: false },
    ]);
  });

  it('starts the way the saved settings say', async () => {
    await setup({
      settings: {
        'ui.sidebarCollapsed': true,
        'ui.inspectorOpen': true,
        'ui.density': 'compact',
        'ui.layout': { main: 60, inspector: 40 },
      },
    });
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect((document.querySelector('.app') as HTMLElement).dataset['sidebar']).toBe('collapsed');
    expect(document.documentElement.dataset['density']).toBe('compact');
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });

  it('shows the inspector with Ctrl+J and fills it from a picked activity entry', async () => {
    const user = await setup({ events: [sampleEvent(1, { details: { version: '1.0' } }), sampleEvent(2)] });
    await screen.findByText('Event number 2');
    await user.keyboard('{Control>}j{/Control}');
    const inspector = await screen.findByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByText(/Pick an item/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Event number 1/ }));
    expect(within(inspector).getByText('Event number 1')).toBeTruthy();
    expect(within(inspector).getByText(/"version": "1.0"/)).toBeTruthy();
    expect(savedSettings()).toContainEqual({ key: 'ui.inspectorOpen', value: true });
  });
});

describe('pages with real data', () => {
  it('shows recent activity on the dashboard and adds new events as main reports them', async () => {
    await setup({ events: [sampleEvent(2), sampleEvent(1)] });
    expect(await screen.findByText('Event number 2')).toBeTruthy();
    expect(screen.getByText('Event number 1')).toBeTruthy();
    act(() => fake.emit('activity:appended', sampleEvent(3)));
    expect(await screen.findByText('Event number 3')).toBeTruthy();
    const rows = within(screen.getByRole('region', { name: 'Recent activity' })).getAllByRole('button');
    expect(rows[0]?.textContent).toContain('Event number 3');
  });

  it('says so when nothing has happened yet', async () => {
    await setup();
    expect(await screen.findByText('Nothing has happened yet.')).toBeTruthy();
  });

  it('changes settings from the Settings page and reports a refused value', async () => {
    const user = await setup();
    await user.click(within(sidebar()).getByRole('button', { name: 'Settings' }));
    await user.selectOptions(screen.getByLabelText(/Interface density/), 'compact');
    await user.selectOptions(screen.getByLabelText(/Log level/), 'debug');
    expect(savedSettings()).toEqual([
      { key: 'ui.density', value: 'compact' },
      { key: 'logging.level', value: 'debug' },
    ]);
    expect(document.documentElement.dataset['density']).toBe('compact');
  });
});

describe('projects', () => {
  it('says there are no projects, offers to add one, and the empty switcher still opens', async () => {
    const user = await setup();
    await screen.findByRole('heading', { name: 'Dashboard' });
    const card = screen.getByRole('region', { name: 'Projects' });
    expect(within(card).getByText('No projects registered yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Project switcher' }));
    expect(await screen.findByText('No projects registered yet')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Add a project…' })).toBeTruthy();
  });

  it('adds a project from the switcher: the picker runs in main, the new project is selected and shown', async () => {
    const user = await setup();
    fake.nextPick = sampleProject(1, {
      name: 'Backrooms',
      type: 'unreal',
      engine: 'Unreal Engine',
      engineVersion: '5.4',
    });
    await screen.findByRole('heading', { name: 'Dashboard' });
    await user.click(screen.getByRole('button', { name: 'Project switcher' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add a project…' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Project switcher' }).textContent).toContain('Backrooms'),
    );
    expect(fake.calls.filter((c) => c.channel === 'projects:pickAndAdd')).toHaveLength(1);
    // No path was sent to main: the request is empty.
    expect(fake.calls.find((c) => c.channel === 'projects:pickAndAdd')?.input).toEqual({});
    expect(savedSettings()).toContainEqual({ key: 'projects.selectedId', value: 'project-1' });
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
  });

  it('runs the Add a project palette action', async () => {
    const user = await setup();
    fake.nextPick = sampleProject(2, { name: 'Palette Game' });
    await screen.findByRole('heading', { name: 'Dashboard' });
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Command palette' }), 'add a project');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
    await vi.waitFor(() => expect(fake.projects.map((p) => p.name)).toEqual(['Palette Game']));
  });

  it('lists projects with their type, shows the evidence, and selects one', async () => {
    const user = await setup({
      projects: [
        sampleProject(1, { name: 'Alpha' }),
        sampleProject(2, { name: 'Beta', type: 'web-vite', status: 'paused', folderExists: false }),
      ],
    });
    await user.click(within(sidebar()).getByRole('button', { name: 'Projects' }));
    const list = await screen.findByRole('list', { name: 'Registered projects' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText(/Paused/)).toBeTruthy();
    expect(within(list).getByText(/folder not found/)).toBeTruthy();
    expect(screen.getByText(/Evidence from the folder \(1\)/)).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: 'Select Beta' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Project switcher' }).textContent).toContain('Beta'),
    );
    expect(within(list).getByRole('button', { name: 'Beta is selected' })).toBeTruthy();
  });

  it('edits a project: name, tags and the type override are sent, and nothing but the project id and fields travels', async () => {
    const user = await setup({ projects: [sampleProject(1, { name: 'Alpha' })] });
    await user.click(within(sidebar()).getByRole('button', { name: 'Projects' }));
    const detail = await screen.findByRole('region', { name: 'Details of Alpha' });
    await user.clear(within(detail).getByLabelText('Name'));
    await user.type(within(detail).getByLabelText('Name'), 'Alpha Prime');
    await user.type(within(detail).getByLabelText(/Tags/), 'horror, ue5');
    await user.selectOptions(within(detail).getByLabelText('Project type'), 'custom');
    await user.click(within(detail).getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(fake.calls.some((c) => c.channel === 'projects:update')).toBe(true));
    expect(fake.calls.find((c) => c.channel === 'projects:update')?.input).toMatchObject({
      id: 'project-1',
      name: 'Alpha Prime',
      tags: ['horror', 'ue5'],
      typeOverride: 'custom',
    });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('removes a project only after a confirmation that says its folder is not touched', async () => {
    const user = await setup({
      projects: [sampleProject(1, { name: 'Alpha' })],
      settings: { 'projects.selectedId': 'project-1' },
    });
    await user.click(within(sidebar()).getByRole('button', { name: 'Projects' }));
    await user.click(await screen.findByRole('button', { name: 'Remove from the registry' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Its folder and every file in it stay exactly as they are');
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(fake.projects).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Remove from the registry' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await vi.waitFor(() => expect(fake.projects).toEqual([]));
    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
  });
});

describe('audit and Git', () => {
  const withProject = () =>
    setup({ projects: [sampleProject(1, { name: 'Alpha' })], settings: { 'projects.selectedId': 'project-1' } });

  it('offers to run the first audit, shows the report with Confirmed and Inferred marks, and links evidence to Explorer', async () => {
    const user = await withProject();
    await user.click(within(sidebar()).getByRole('button', { name: 'Projects' }));
    const panel = await screen.findByRole('region', { name: 'Audit of Alpha' });
    expect(await within(panel).findByText('This project has not been audited yet.')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Run an audit' }));
    expect(fake.calls.find((c) => c.channel === 'audit:run')?.input).toEqual({ projectId: 'project-1' });
    await within(panel).findByText(/Audited/);
    expect(within(panel).getAllByText('Confirmed').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('Inferred')).toHaveLength(1);
    await user.click(within(panel).getByText(/Engine and version/));
    await user.click(within(panel).getByRole('button', { name: 'Show project.godot in Explorer' }));
    expect(fake.revealed).toEqual(['project.godot']);
    // The page sends a project id and a project-relative path, never a folder.
    expect(fake.calls.find((c) => c.channel === 'audit:reveal')?.input).toEqual({ projectId: 'project-1', relativePath: 'project.godot' });
    expect(within(panel).getByRole('button', { name: 'Run the audit again' })).toBeTruthy();
  });

  it('warns when the scan stopped early', async () => {
    const base = sampleReport(2);
    const user = await setup({ projects: [sampleProject(1, { name: 'Alpha' })], settings: { 'projects.selectedId': 'project-1' } });
    fake.report = { ...base, scan: { ...base.scan, truncated: ['files'] } };
    await user.click(within(sidebar()).getByRole('button', { name: 'Projects' }));
    expect(await screen.findByText(/The scan stopped early \(files limit\)/)).toBeTruthy();
  });

  it('shows Git facts for the selected project, and "Not a Git repository." instead of an error', async () => {
    const user = await withProject();
    await user.click(within(sidebar()).getByRole('button', { name: /^Git and Changes/ }));
    const card = await screen.findByRole('region', { name: 'Git status of Alpha' });
    expect(await within(card).findByText('Not a Git repository.')).toBeTruthy();

    fake.git = {
      available: true,
      isRepository: true,
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      changes: { staged: 0, modified: 2, untracked: 1, conflicted: 0 },
      recentCommits: [{ hash: 'a'.repeat(40), author: 'Sam', date: '2026-10-24T01:00:00Z', subject: 'Add jump' }],
    };
    await user.click(within(card).getByRole('button', { name: 'Refresh' }));
    expect(await within(card).findByText('main')).toBeTruthy();
    expect(within(card).getByText('0 staged · 2 modified · 1 untracked')).toBeTruthy();
    expect(within(card).getByText('Add jump')).toBeTruthy();
  });

  it('asks for a project first on the Git page, and shows the same facts on the dashboard card', async () => {
    const user = await setup();
    await user.click(within(sidebar()).getByRole('button', { name: /^Git and Changes/ }));
    expect(await screen.findByText('Select a project to see its Git status.')).toBeTruthy();
    await user.click(within(sidebar()).getByRole('button', { name: 'Dashboard' }));
    expect(within(await screen.findByRole('region', { name: 'Recent changes' })).getByText(/Select a project/)).toBeTruthy();
  });
});

describe('data and backups', () => {
  const openSettings = async () => {
    const user = await setup();
    await user.click(within(sidebar()).getByRole('button', { name: /^Settings/ }));
    return { user, section: await screen.findByRole('region', { name: 'Data and backups' }) };
  };

  it('says there are no backups, makes one on request and lists it, and saves the schedule settings', async () => {
    const { user, section } = await openSettings();
    expect(await within(section).findByText('No backups yet.')).toBeTruthy();
    await user.click(within(section).getByRole('button', { name: 'Back up now' }));
    const list = await within(section).findByRole('list', { name: 'Backups' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Manual')).toBeTruthy();

    await user.click(within(section).getByLabelText('Back up automatically'));
    expect(savedSettings()).toContainEqual({ key: 'backup.scheduleEnabled', value: true });
    await user.selectOptions(within(section).getByLabelText('every'), '72');
    expect(savedSettings()).toContainEqual({ key: 'backup.intervalHours', value: 72 });
  });

  it('restore sends only the backup file name; main does the confirming and the restart', async () => {
    const { user, section } = await openSettings();
    fake.backups = [{ id: 'gdcc-20261024T010000000Z-scheduled.db', createdAt: '2026-10-24T01:00:00.000Z', reason: 'scheduled', sizeBytes: 5000 }];
    await user.click(within(section).getByRole('button', { name: 'Back up now' }));
    const restoreButtons = await within(section).findAllByRole('button', { name: /^Restore the backup from/ });
    await user.click(restoreButtons[restoreButtons.length - 1] as HTMLElement);
    expect(fake.calls.find((c) => c.channel === 'storage:restore')?.input).toEqual({ backupId: 'gdcc-20261024T010000000Z-scheduled.db' });
    expect(await within(section).findByText(/the app is restarting/)).toBeTruthy();
  });

  it('shows what an import would do before anything changes, defaults to keeping existing data, and sends only the choice', async () => {
    const { user, section } = await openSettings();
    fake.importPreview = {
      staged: true,
      fileName: 'gdcc-export.json',
      exportedAt: '2026-10-24T01:00:00.000Z',
      appVersion: '0.1.0',
      tables: [{ id: 'projects', label: 'Projects', total: 3, added: 1, same: 1, conflicts: 1, blocked: 0 }],
      projectFolders: ['D:\\Games\\New'],
      warnings: [],
    };
    await user.click(within(section).getByRole('button', { name: 'Choose a file to import…' }));
    const preview = await within(section).findByRole('region', { name: 'Import preview' });
    expect(within(preview).getByText('gdcc-export.json')).toBeTruthy();
    expect(within(preview).getByText('D:\\Games\\New')).toBeTruthy();
    expect(within(preview).getByLabelText<HTMLInputElement>(/Keep what I have/).checked).toBe(true);
    expect(fake.calls.some((c) => c.channel === 'storage:applyImport')).toBe(false);

    await user.click(within(preview).getByLabelText(/Replace with the file/));
    await user.click(within(preview).getByRole('button', { name: 'Import' }));
    expect(fake.calls.find((c) => c.channel === 'storage:applyImport')?.input).toEqual({ conflict: 'replace' });
  });

  it('does not show an import preview when the file dialog was cancelled, and reports a declined import', async () => {
    const { user, section } = await openSettings();
    await user.click(within(section).getByRole('button', { name: 'Choose a file to import…' }));
    await vi.waitFor(() => expect(fake.calls.some((c) => c.channel === 'storage:previewImport')).toBe(true));
    expect(within(section).queryByRole('region', { name: 'Import preview' })).toBeNull();

    fake.importPreview = { staged: true, fileName: 'x.json', tables: [], projectFolders: [], warnings: [] };
    fake.importResult = { applied: false, tables: [] };
    await user.click(within(section).getByRole('button', { name: 'Choose a file to import…' }));
    await user.click(await within(section).findByRole('button', { name: 'Import' }));
    expect(await within(section).findByText('Nothing was imported.')).toBeTruthy();
  });

  it('reports an export, or its cancellation', async () => {
    const { user, section } = await openSettings();
    await user.click(within(section).getByRole('button', { name: 'Export data…' }));
    expect(await within(section).findByText('Saved 2 rows.')).toBeTruthy();
    fake.exportResult = { saved: false, tables: [] };
    await user.click(within(section).getByRole('button', { name: 'Export data…' }));
    expect(await within(section).findByText('Export cancelled.')).toBeTruthy();
  });
});

describe('project context', () => {
  const openContext = async () => {
    const user = await setup({ projects: [sampleProject(1, { name: 'Alpha' })], settings: { 'projects.selectedId': 'project-1' } });
    await user.click(within(sidebar()).getByRole('button', { name: /^Project Context/ }));
    await screen.findByRole('heading', { name: 'Project Context' });
    return user;
  };

  it('asks for a project first', async () => {
    const user = await setup();
    await user.click(within(sidebar()).getByRole('button', { name: /^Project Context/ }));
    expect(await screen.findByText(/Select a project to see its memory/)).toBeTruthy();
  });

  it('memory: suggests a minimal set, previews a change before saving, and saving is only possible after the preview', async () => {
    const user = await openContext();
    const suggested = await screen.findByRole('region', { name: 'Suggested documents' });
    expect(within(suggested).getByText('Project context')).toBeTruthy();
    await user.click(within(suggested).getAllByRole('button', { name: 'Start it…' })[1] as HTMLElement); // Decisions
    const editor = await screen.findByRole('region', { name: 'Editing Decisions' });
    const save = within(editor).getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true); // nothing to save until the change was previewed
    expect(within(editor).getByLabelText<HTMLTextAreaElement>('Document text').value).toContain('# Decisions: Alpha');

    await user.click(within(editor).getByRole('button', { name: 'Preview changes' }));
    expect(fake.calls.find((c) => c.channel === 'memory:preview')?.input).toMatchObject({ projectId: 'project-1', docType: 'DECISIONS' });
    expect(await within(editor).findByLabelText('Changes')).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await user.click(save);
    expect(fake.calls.find((c) => c.channel === 'memory:save')?.input).toEqual({ projectId: 'project-1', docType: 'DECISIONS' });
    expect(await within(editor).findByText('Saved to App database.')).toBeTruthy();
  });

  it('memory: changing the text clears the preview so an old preview cannot be saved', async () => {
    const user = await openContext();
    await user.click((await screen.findAllByRole('button', { name: 'Create Project context' }))[0] as HTMLElement);
    const editor = await screen.findByRole('region', { name: 'Editing Project context' });
    await user.click(within(editor).getByRole('button', { name: 'Preview changes' }));
    await within(editor).findByLabelText('Changes');
    await user.type(within(editor).getByLabelText('Document text'), ' more');
    expect(within(editor).queryByLabelText('Changes')).toBeNull();
    expect(within(editor).getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
  });

  it('memory: switching to the project folder is a setting change that writes nothing, and saving then says it asks first', async () => {
    const user = await openContext();
    const where = await screen.findByRole('region', { name: 'Where memory is stored' });
    await user.selectOptions(within(where).getByLabelText('Store project memory'), 'project');
    await user.click(within(where).getByRole('button', { name: 'Use this' }));
    expect(fake.calls.find((c) => c.channel === 'memory:setStorage')?.input).toEqual({ projectId: 'project-1', storage: 'project', docsDir: 'docs' });
    expect(fake.calls.some((c) => c.channel === 'memory:save')).toBe(false);
    await user.click((await screen.findAllByRole('button', { name: 'Create Project context' }))[0] as HTMLElement);
    expect(within(await screen.findByRole('region', { name: 'Editing Project context' })).getByRole('button', { name: 'Save into the project…' })).toBeTruthy();
  });

  it('packs: builds a preview with reasons and exclusions, shows the destination and the full text, and saves it by name', async () => {
    const user = await openContext();
    await user.click(screen.getByRole('tab', { name: 'Context packs' }));
    const form = await screen.findByRole('region', { name: 'Build a context pack' });
    const build = within(form).getByRole('button', { name: 'Build the pack' });
    expect((build as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(form).getByLabelText('What is the task?'), 'Make the player faster');
    await user.selectOptions(within(form).getByLabelText('Destination'), 'Claude Code (cloud)');
    await user.click(build);
    expect(fake.calls.find((c) => c.channel === 'packs:build')?.input).toEqual({
      projectId: 'project-1', task: 'Make the player faster', budget: 8000, extraFiles: [], destination: 'Claude Code (cloud)',
    });
    const preview = await screen.findByRole('region', { name: 'Context pack preview' });
    expect(within(preview).getByText('scripts/player.gd')).toBeTruthy();
    expect(within(preview).getByText('logo.png')).toBeTruthy();
    expect(within(preview).getByText(/about 420 of 8,000 tokens \(estimate\)/)).toBeTruthy();
    expect(within(preview).getByText(/everything that would be sent/)).toBeTruthy();
    expect(within(preview).getByLabelText('Pack text').textContent).toContain('## File: scripts/player.gd');

    await user.clear(within(preview).getByLabelText('Pack name'));
    await user.type(within(preview).getByLabelText('Pack name'), 'Speed work');
    await user.click(within(preview).getByRole('button', { name: 'Save the pack' }));
    expect(fake.calls.find((c) => c.channel === 'packs:save')?.input).toEqual({ projectId: 'project-1', title: 'Speed work' });
    const saved = await screen.findByRole('list', { name: 'Saved packs' });
    expect(await within(saved).findByText('Speed work')).toBeTruthy();
    expect(within(saved).getByText('Up to date')).toBeTruthy();
  });

  it('packs: shows which files made a saved pack out of date', async () => {
    const user = await setup({ projects: [sampleProject(1, { name: 'Alpha' })], settings: { 'projects.selectedId': 'project-1' } });
    fake.packList = [{ id: 'pack-9', title: 'Old pack', destination: 'Ollama (local)', estimate: 300, files: 2, createdAt: '2026-10-23T04:00:00.000Z', stale: 1 }];
    fake.packResult = { ...samplePack(), id: 'pack-9', title: 'Old pack', saved: true, stale: [{ path: 'scripts/util.gd', change: 'changed' }] };
    await user.click(within(sidebar()).getByRole('button', { name: /^Project Context/ }));
    await user.click(await screen.findByRole('tab', { name: 'Context packs' }));
    const list = await screen.findByRole('list', { name: 'Saved packs' });
    expect(await within(list).findByText('Out of date (1)')).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: 'Open Old pack' }));
    expect((await screen.findByRole('alert')).textContent).toContain('scripts/util.gd (changed)');
    await user.click(screen.getByRole('button', { name: 'Rebuild with the current files' }));
    expect(fake.calls.some((c) => c.channel === 'packs:refresh')).toBe(true);
  });

  it('handoffs: drafts from the project, saves all seven fields, lists the result, and can send it to the Session handoff document', async () => {
    const user = await openContext();
    await user.click(screen.getByRole('tab', { name: 'Session handoffs' }));
    const form = await screen.findByRole('region', { name: 'New session handoff' });
    await user.click(within(form).getByRole('button', { name: 'Draft from the project' }));
    expect(within(form).getByLabelText<HTMLTextAreaElement>('What remains unfinished').value).toContain('TODO: add jump');
    await user.type(within(form).getByLabelText('What was requested'), 'Add jumping');
    await user.type(within(form).getByLabelText('Next recommended task'), 'Tune the jump');
    await user.click(within(form).getByRole('button', { name: 'Save the handoff' }));
    const sent = fake.calls.find((c) => c.channel === 'handoffs:save')?.input as { fields: Record<string, string> };
    expect(Object.keys(sent.fields).sort()).toEqual(['changed', 'files', 'nextTask', 'requested', 'risks', 'unfinished', 'verified']);
    expect(sent.fields['requested']).toBe('Add jumping');

    const history = await screen.findByRole('region', { name: 'Saved handoffs' });
    expect(await within(history).findByText(/next: Tune the jump/)).toBeTruthy();
    await user.click(within(history).getByRole('button', { name: /Use as the Session handoff document/ }));
    const editor = await screen.findByRole('region', { name: 'Editing Session handoff' });
    expect(within(editor).getByLabelText<HTMLTextAreaElement>('Document text').value).toContain('## What was requested\n\nAdd jumping');
  });

  it('the dashboard card shows the latest handoff of the selected project', async () => {
    const user = await setup({ projects: [sampleProject(1, { name: 'Alpha' })], settings: { 'projects.selectedId': 'project-1' } });
    expect(await within(await screen.findByRole('region', { name: 'Latest session handoff' })).findByText('No handoff saved for this project yet.')).toBeTruthy();
    fake.handoffs = [{ id: 'h1', projectId: 'project-1', createdAt: '2026-10-24T05:00:00.000Z', requested: 'Add jumping', changed: '', verified: '', unfinished: '', risks: '', files: '', nextTask: 'Tune the jump' }];
    await user.click(within(sidebar()).getByRole('button', { name: 'Projects' }));
    await user.click(within(sidebar()).getByRole('button', { name: 'Dashboard' }));
    const card = await screen.findByRole('region', { name: 'Latest session handoff' });
    expect(await within(card).findByText('Tune the jump')).toBeTruthy();
    expect(within(card).getByText('Add jumping')).toBeTruthy();
  });
});

describe('tasks and roadmap', () => {
  let planning: FakePlanning;
  const openTasks = async (seed: Parameters<typeof attachPlanning>[1] = {}, projects = true) => {
    const user = await setup(projects ? { projects: [sampleProject(1, { name: 'Alpha' })], settings: { 'projects.selectedId': 'project-1' } } : {});
    planning = attachPlanning(fake, seed);
    await user.click(within(sidebar()).getByRole('button', { name: /^Tasks and Roadmap/ }));
    await screen.findByRole('heading', { name: 'Tasks and Roadmap' });
    return user;
  };
  const column = (name: string) => within(screen.getByRole('region', { name }));

  it('asks for a project first', async () => {
    await openTasks({}, false);
    expect(await screen.findByText('Select a project to plan its tasks.')).toBeTruthy();
  });

  it('starts empty with a clear next step, and creates a task from a template with its fields prefilled and editable', async () => {
    const user = await openTasks();
    expect(await screen.findByText(/No tasks yet\. Add one/)).toBeTruthy();
    expect(screen.getByText(/There are no tasks yet/)).toBeTruthy(); // the recommendation says why it has nothing to offer
    await user.click(screen.getByRole('button', { name: 'New task…' }));
    const form = await screen.findByRole('region', { name: 'New task' });
    await user.selectOptions(within(form).getByLabelText('Start from a template'), 'bug-fixing');
    expect((within(form).getByLabelText<HTMLSelectElement>('Suggested agent role')).value).toBe('qa');
    await user.type(within(form).getByLabelText('Title'), 'Fix the crash on load');
    expect(within(form).getByLabelText<HTMLTextAreaElement>(/Acceptance criteria/).value).toContain('The bug no longer reproduces');
    await user.click(within(form).getByRole('button', { name: 'Add to the Inbox' }));
    const sent = fake.calls.find((c) => c.channel === 'tasks:create')?.input as Record<string, unknown>;
    expect(sent).toMatchObject({ projectId: 'project-1', title: 'Fix the crash on load', category: 'bug-fixing', role: 'qa', status: 'inbox' });
    expect(sent['acceptance']).toEqual(expect.arrayContaining(['The bug no longer reproduces with the recorded steps']));
    expect(await column('Inbox').findByText('Fix the crash on load')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Task Fix the crash on load' })).toBeTruthy(); // the new task opens for editing
  });

  it('moves a task along its lifecycle with only the valid next steps offered, and shows the board columns change', async () => {
    const user = await openTasks({ tasks: [sampleTask(1, { title: 'Add jumping' })] });
    await user.click(await column('Inbox').findByRole('button', { name: /Add jumping/ }));
    const detail = await screen.findByRole('region', { name: 'Task Add jumping' });
    const moves = within(within(detail).getByRole('group', { name: 'Move this task' })).getAllByRole('button').map((b) => b.textContent);
    expect(moves).toEqual(['Move to Planned', 'Move to Cancelled']);
    await user.click(within(detail).getByRole('button', { name: 'Move to Planned' }));
    expect(await column('Planned').findByText('Add jumping')).toBeTruthy();
    expect(column('Inbox').queryByText('Add jumping')).toBeNull();
    await user.click(within(screen.getByRole('region', { name: 'Task Add jumping' })).getByRole('button', { name: 'Move to Ready' }));
    expect(await column('Ready').findByText('Add jumping')).toBeTruthy();
  });

  it('shows what a task waits on, refuses to start it early with the reason, and lets dependencies be set from the detail panel', async () => {
    const first = sampleTask(1, { title: 'Build the level', status: 'in-progress', allowedNext: allowedNext('in-progress', null) });
    const second = sampleTask(2, { title: 'Light the level', status: 'ready', allowedNext: allowedNext('ready', null) });
    const user = await openTasks({ tasks: [first, second] });
    await user.click(await column('Ready').findByRole('button', { name: /Light the level/ }));
    let detail = await screen.findByRole('region', { name: 'Task Light the level' });
    await user.click(within(within(detail).getByRole('list', { name: 'Dependencies' })).getByLabelText(/Build the level/));
    expect(fake.calls.find((c) => c.channel === 'tasks:setDependencies')?.input).toEqual({ id: 'task-2', dependsOn: ['task-1'] });
    detail = await screen.findByRole('region', { name: 'Task Light the level' });
    expect(await within(detail).findByText(/Waiting on: Build the level \(In progress\)/)).toBeTruthy();
    expect(await column('Ready').findByText('Waiting on 1')).toBeTruthy();
    await user.click(within(detail).getByRole('button', { name: 'Move to In progress' }));
    expect((await screen.findByRole('alert')).textContent).toContain('waiting on: "Build the level"');
    expect(column('Ready').getByText('Light the level')).toBeTruthy(); // nothing moved
  });

  it('approves and withdraws a plan, saves edited fields, and keeps notes', async () => {
    const user = await openTasks({ tasks: [sampleTask(1, { title: 'Dash', status: 'ready', allowedNext: allowedNext('ready', null) })] });
    await user.click(await column('Ready').findByRole('button', { name: /Dash/ }));
    const detail = await screen.findByRole('region', { name: 'Task Dash' });
    expect(within(detail).getByText('Plan not approved yet.')).toBeTruthy();
    await user.click(within(detail).getByRole('button', { name: 'Approve the plan' }));
    expect(await within(await screen.findByRole('region', { name: 'Task Dash' })).findByRole('button', { name: 'Withdraw approval' })).toBeTruthy();

    const again = screen.getByRole('region', { name: 'Task Dash' });
    await user.type(within(again).getByLabelText(/Acceptance criteria/), 'It covers two meters');
    await user.click(within(again).getByRole('button', { name: 'Save changes' }));
    expect(fake.calls.find((c) => c.channel === 'tasks:update')?.input).toMatchObject({ id: 'task-1', acceptance: ['It covers two meters'] });
    expect(await within(screen.getByRole('region', { name: 'Task Dash' })).findByText('Saved.')).toBeTruthy();

    await user.type(within(again).getByLabelText('New note'), 'Ask about the cooldown');
    await user.click(within(again).getByRole('button', { name: 'Add note' }));
    expect(await within(again).findByText('Ask about the cooldown')).toBeTruthy();
  });

  it('breaks a feature down from plain text into a parent and steps with acceptance criteria', async () => {
    const user = await openTasks();
    await user.click(screen.getByRole('button', { name: 'Break a feature down…' }));
    const form = await screen.findByRole('region', { name: 'Break a feature down' });
    const create = within(form).getByRole('button', { name: /^Create/ });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(form).getByLabelText('Feature'), 'Crouching');
    await user.type(within(form).getByLabelText(/^Steps/), 'Add the crouch input :: C toggles crouch | works on a controller{Enter}Lower the camera');
    await user.click(within(form).getByRole('button', { name: 'Create 3 tasks' }));
    const sent = fake.calls.find((c) => c.channel === 'tasks:breakdown')?.input as { steps: { title: string; acceptance: string[] }[]; chain: boolean };
    expect(sent.steps).toEqual([{ title: 'Add the crouch input', acceptance: ['C toggles crouch', 'works on a controller'] }, { title: 'Lower the camera', acceptance: [] }]);
    expect(sent.chain).toBe(true);
    expect(await column('Planned').findByText('Crouching')).toBeTruthy();
    expect(column('Planned').getByText('Lower the camera')).toBeTruthy();
  });

  it('lists tasks with a filter and a search', async () => {
    const user = await openTasks({ tasks: [sampleTask(1, { title: 'Open one' }), sampleTask(2, { title: 'Finished one', status: 'done', allowedNext: allowedNext('done', null) })] });
    await user.click(screen.getByRole('tab', { name: 'List' }));
    const table = await screen.findByRole('table', { name: 'Task list' });
    expect(within(table).getByText('Open one')).toBeTruthy();
    expect(within(table).queryByText('Finished one')).toBeNull(); // open tasks by default
    await user.selectOptions(screen.getByLabelText('Show'), 'all');
    expect(within(screen.getByRole('table', { name: 'Task list' })).getByText('Finished one')).toBeTruthy();
    await user.type(screen.getByLabelText('Search'), 'fini');
    expect(within(screen.getByRole('table', { name: 'Task list' })).queryByText('Open one')).toBeNull();
    expect(savedSettings()).toContainEqual({ key: 'tasks.view', value: 'list' });
  });

  it('roadmap: adds a milestone with its scope, shows progress from stored tasks only, changes its status and takes snapshots', async () => {
    const user = await openTasks();
    await user.click(screen.getByRole('tab', { name: 'Roadmap' }));
    expect(await screen.findByText(/No milestones yet/)).toBeTruthy();
    await user.type(screen.getByLabelText('Title'), 'First playable');
    await user.selectOptions(screen.getByLabelText('Scope'), 'prototype');
    await user.click(screen.getByRole('button', { name: 'Add milestone' }));
    const card = await screen.findByRole('region', { name: 'Milestone First playable' });
    expect(within(card).getByText('First playable prototype')).toBeTruthy();
    expect(within(card).getByText('No tasks yet')).toBeTruthy(); // no invented percentage

    await user.selectOptions(within(card).getByLabelText('Status of First playable'), 'active');
    expect(fake.calls.find((c) => c.channel === 'milestones:update')?.input).toEqual({ id: expect.any(String) as unknown, status: 'active' });
    await user.click(within(card).getByRole('button', { name: 'Take a snapshot' }));
    expect(await within(await screen.findByRole('region', { name: 'Milestone First playable' })).findByRole('list', { name: 'Snapshots of First playable' })).toBeTruthy();
  });

  it('bugs and risks: records one, changes its status, and deletes it', async () => {
    const user = await openTasks();
    await user.click(screen.getByRole('tab', { name: 'Bugs and risks' }));
    expect(await screen.findByText(/Nothing recorded/)).toBeTruthy();
    const form = screen.getByRole('region', { name: 'New bug or risk' });
    await user.selectOptions(within(form).getByLabelText('Severity'), 'high');
    await user.type(within(form).getByLabelText('Title'), 'Crash when loading level 2');
    await user.click(within(form).getByRole('button', { name: 'Record it' }));
    expect(fake.calls.find((c) => c.channel === 'risks:create')?.input).toMatchObject({ kind: 'bug', severity: 'high', title: 'Crash when loading level 2', taskId: null });
    const list = await screen.findByRole('list', { name: 'Bugs and risks' });
    await user.selectOptions(within(list).getByLabelText('Status of Crash when loading level 2'), 'closed');
    expect(fake.calls.find((c) => c.channel === 'risks:update')?.input).toMatchObject({ status: 'closed' });
    await user.click(within(screen.getByRole('list', { name: 'Bugs and risks' })).getByRole('button', { name: 'Delete Crash when loading level 2' }));
    await vi.waitFor(() => expect(planning.risks).toEqual([]));
  });

  it('shows the recommended task with the reasons for it', async () => {
    const task = sampleTask(1, { title: 'Fix the crash', priority: 'high', status: 'ready', allowedNext: allowedNext('ready', null) });
    await openTasks({ tasks: [task], recommendation: { items: [{ task, score: 40, reasons: ['high priority', 'fixes a bug'] }], message: '' } });
    const region = await screen.findByRole('region', { name: 'Next recommended task' });
    expect(within(region).getByText('Fix the crash')).toBeTruthy();
    expect(within(region).getByText('Why: high priority; fixes a bug.')).toBeTruthy();
  });

  it('the dashboard shows the current milestone, active and blocked tasks, the recommendation and the portfolio', async () => {
    const user = await setup({ projects: [sampleProject(1, { name: 'Alpha' }), sampleProject(2, { name: 'Beta', status: 'paused' })], settings: { 'projects.selectedId': 'project-1' } });
    const task = sampleTask(1, { title: 'Fix the crash', status: 'in-progress', allowedNext: allowedNext('in-progress', null) });
    attachPlanning(fake, {
      tasks: [task, sampleTask(2, { title: 'Stuck thing', status: 'blocked', allowedNext: allowedNext('blocked', 'ready') })],
      recommendation: { items: [{ task, score: 20, reasons: ['Already in progress: finish it before starting something new'] }], message: '' },
    });
    await user.click(within(sidebar()).getByRole('button', { name: 'Projects' }));
    await user.click(within(sidebar()).getByRole('button', { name: 'Dashboard' }));
    const current = await screen.findByRole('region', { name: 'Current task and milestone' });
    expect(await within(current).findByText('Fix the crash (In progress)')).toBeTruthy();
    expect(within(current).getByText('Stuck thing')).toBeTruthy();
    expect(within(await screen.findByRole('region', { name: 'Next recommended action' })).getByText(/Already in progress/)).toBeTruthy();
    const portfolio = await screen.findByRole('region', { name: 'Portfolio' });
    expect(await within(portfolio).findByText('Alpha')).toBeTruthy();
    expect(within(portfolio).getByText('Beta')).toBeTruthy();
    expect(within(portfolio).getByText(/paused/)).toBeTruthy();
  });
});

describe('agent work on a task', () => {
  const openTask = async (overrides: Parameters<typeof sampleTask>[1] = {}) => {
    const user = await setup({ projects: [sampleProject(1, { name: 'Alpha' })], settings: { 'projects.selectedId': 'project-1' } });
    attachPlanning(fake, { tasks: [sampleTask(1, { title: 'Add jumping', status: 'ready', allowedNext: allowedNext('ready', null), acceptance: ['Jump is tunable'], ...overrides })] });
    await user.click(within(sidebar()).getByRole('button', { name: /^Tasks and Roadmap/ }));
    await user.click(await within(await screen.findByRole('region', { name: 'Ready' })).findByRole('button', { name: /Add jumping/ }));
    return { user, panel: await screen.findByRole('region', { name: 'Agent work for this task' }) };
  };

  it('says what each role may do: planning is read-only, only the implementer changes files', async () => {
    const { user, panel } = await openTask();
    expect(await within(panel).findByText('Read-only')).toBeTruthy();
    await user.selectOptions(within(panel).getByLabelText('Role'), 'implementer');
    expect(within(panel).getByText('Can change project files')).toBeTruthy();
    await user.selectOptions(within(panel).getByLabelText('Role'), 'reviewer');
    expect(within(panel).getByText('Read-only')).toBeTruthy();
  });

  it('previews the exact prompt from the task and says nothing is sent', async () => {
    const { user, panel } = await openTask();
    await user.click(within(panel).getByRole('button', { name: 'Preview the prompt' }));
    const preview = await within(panel).findByLabelText('Prompt preview');
    expect(preview.textContent).toContain('Task: Add jumping');
    expect(preview.textContent).toContain('- Jump is tunable');
    expect(within(panel).getByText(/Nothing is sent/)).toBeTruthy();
  });

  it('shows the plan with the action and provider of each step, keeps reviewer and QA off until chosen, and flags the missing plan approval', async () => {
    const { user, panel } = await openTask({ provider: 'Claude Code' });
    await user.click(within(panel).getByRole('button', { name: 'Show the plan' }));
    const steps = await within(panel).findByRole('list', { name: 'Workflow plan' });
    expect(within(steps).getByText('Code reviewer').closest('li')?.textContent).toContain('Optional · off');
    expect(within(steps).getByText('QA and debugging').closest('li')?.textContent).toContain('Optional · off');
    const implementer = within(steps).getByText('Implementer').closest('li') as HTMLElement;
    expect(implementer.textContent).toContain('Writes files');
    expect(implementer.textContent).toContain('Provider: Claude Code');
    expect(implementer.textContent).toContain('Blocked: Needs an approved plan');
    expect(within(steps).getByText('Planner / architect').closest('li')?.textContent).toContain('Read-only');

    await user.click(within(panel).getByLabelText('Also ask a reviewer'));
    expect(within(panel).queryByRole('list', { name: 'Workflow plan' })).toBeNull(); // the old plan no longer matches the choice
    await user.click(within(panel).getByRole('button', { name: 'Show the plan' }));
    expect(within(await within(panel).findByRole('list', { name: 'Workflow plan' })).getByText('Code reviewer').closest('li')?.textContent).toContain('Optional · included');
    expect(fake.calls.filter((c) => c.channel === 'agents:preview').at(-1)?.input).toEqual({ taskId: 'task-1', workflow: 'implement', includeReviewer: true, includeQa: false });
  });

  it('saves queued run records, lists them, lets you record an outcome by hand, and never offers to run them', async () => {
    const { user, panel } = await openTask();
    const run = within(panel).getByRole('button', { name: /^Run the workflow/ });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    expect(run.textContent).toContain('Upcoming · Step 12');
    expect(within(panel).getByRole<HTMLButtonElement>("button", { name: "Save as queued runs" }).disabled).toBe(true); // show the plan first
    await user.click(within(panel).getByRole('button', { name: 'Show the plan' }));
    await user.click(await within(panel).findByRole('button', { name: 'Save as queued runs' }));
    const runs = await within(panel).findByRole('list', { name: 'Runs' });
    expect(within(runs).getAllByRole('listitem')).toHaveLength(2);
    expect(within(runs).getAllByText('Queued')).toHaveLength(2);
    expect(within(runs).queryByRole('button', { name: /start|launch|^run/i })).toBeNull();

    await user.click(within(runs).getByRole('button', { name: 'Record Planner / architect run as completed' }));
    expect(await within(panel).findByText('Completed')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Record Planner / architect run as completed' })).toBeNull();
  });
});

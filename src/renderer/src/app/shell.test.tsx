// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURES, isUsable } from '@shared/feature-status';
import { COMPLETED_THROUGH_STEP } from '@shared/roadmap-steps';
import { createFakeApi, sampleEvent, sampleProject, sampleReport, type FakeApi } from '../../../../test/mocks/fake-api';
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
    fake = undefined as never;
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

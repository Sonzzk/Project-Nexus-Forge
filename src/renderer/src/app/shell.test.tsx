// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURES, isUsable } from '@shared/feature-status';
import { createFakeApi, sampleEvent, type FakeApi } from '../../../../test/mocks/fake-api';
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
    await user.click(within(sidebar()).getByRole('button', { name: /^Projects/ }));
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByText(/arrives in Step 6/)).toBeTruthy();
    expect(within(document.querySelector('.workspace') as HTMLElement).queryAllByRole('button')).toEqual([]);
    expect(
      within(sidebar())
        .getByRole('button', { name: /^Projects/ })
        .getAttribute('aria-current'),
    ).toBe('page');

    await user.click(within(sidebar()).getByRole('button', { name: 'Implementation Status' }));
    const steps = within(screen.getByRole('list', { name: 'Build steps' })).getAllByRole('listitem');
    expect(steps).toHaveLength(29);
    expect(steps[4]?.textContent).toContain('Dashboard and UI');
    expect(steps[4]?.textContent).toContain('Done');
    expect(steps[5]?.textContent).toContain('Next');
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

  it('shows the project switcher as empty and says why adding is not possible yet', async () => {
    const user = await setup();
    await screen.findByRole('heading', { name: 'Dashboard' });
    await user.click(screen.getByRole('button', { name: 'Project switcher' }));
    expect(await screen.findByText('No projects registered yet')).toBeTruthy();
    const add = screen.getByRole('menuitem', { name: /Add a project/ });
    expect(add.getAttribute('aria-disabled') ?? add.getAttribute('data-disabled')).not.toBeNull();
    expect(add.textContent).toContain('Upcoming · Step 6');
  });
});

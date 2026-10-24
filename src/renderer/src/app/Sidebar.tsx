import type { KeyboardEvent } from 'react';
import { FEATURES, stateLabel, type NavSection } from '@shared/feature-status';
import logo from '../../../../assets/icon/nexus-ai.png';
import { SECTION_ICONS } from './icons';

const ITEMS = FEATURES.filter((feature) => feature.kind === 'navigation');

interface SidebarProps {
  collapsed: boolean;
  current: NavSection;
  onNavigate: (section: NavSection) => void;
}

export function Sidebar({ collapsed, current, onNavigate }: SidebarProps) {
  // Up and Down move between items (Tab also works); Home and End jump to the first and last.
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.findIndex((button) => button === document.activeElement);
    const target =
      event.key === 'ArrowDown'
        ? (buttons[index + 1] ?? buttons[0])
        : event.key === 'ArrowUp'
          ? (buttons[index - 1] ?? buttons.at(-1))
          : event.key === 'Home'
            ? buttons[0]
            : event.key === 'End'
              ? buttons.at(-1)
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar__brand">
        <img src={logo} alt="" width={24} height={24} />
        <span className="sidebar__title">GameDev Command Center</span>
      </div>
      <ul className="sidebar__list" onKeyDown={onKeyDown}>
        {ITEMS.map((feature) => {
          const Icon = SECTION_ICONS[feature.section];
          const label = stateLabel(feature);
          return (
            <li key={feature.id}>
              <button
                type="button"
                className="nav-item"
                data-feature={feature.id}
                aria-current={current === feature.section ? 'page' : undefined}
                aria-label={label === undefined ? feature.label : `${feature.label}, ${label}`}
                title={
                  collapsed
                    ? label === undefined
                      ? feature.label
                      : `${feature.label} (${label})`
                    : undefined
                }
                onClick={() => onNavigate(feature.section)}
              >
                <Icon size={18} aria-hidden />
                <span className="nav-item__text">
                  <span className="nav-item__label">{feature.label}</span>
                  {label !== undefined && <span className="nav-item__sub">{label}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

import { Command } from 'cmdk';
import { FEATURES, isUsable, stateLabel, type FeatureStatus } from '@shared/feature-status';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  handlers: Record<string, () => void>;
}

const NAVIGATION = FEATURES.filter((feature) => feature.kind === 'navigation');
const ACTIONS = FEATURES.filter((feature) => feature.kind === 'action');

export function CommandPalette({ open, onOpenChange, handlers }: CommandPaletteProps) {
  const choose = (feature: FeatureStatus): void => {
    handlers[feature.id]?.();
    onOpenChange(false);
  };

  const item = (feature: FeatureStatus) => {
    const label = stateLabel(feature);
    // Sidebar items always navigate (an upcoming one opens its explanation); an upcoming action is disabled.
    const disabled = feature.kind === 'action' && !isUsable(feature);
    return (
      <Command.Item
        key={feature.id}
        value={feature.label}
        disabled={disabled}
        data-feature={feature.id}
        onSelect={() => choose(feature)}
      >
        <span>{feature.label}</span>
        {label !== undefined && <span className="badge">{label}</span>}
      </Command.Item>
    );
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      overlayClassName="overlay"
      contentClassName="palette"
      loop
    >
      <Command.Input placeholder="Type a command or a section name" />
      <Command.List>
        <Command.Empty>No matching command.</Command.Empty>
        <Command.Group heading="Go to">{NAVIGATION.map(item)}</Command.Group>
        <Command.Group heading="Actions">{ACTIONS.map(item)}</Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}

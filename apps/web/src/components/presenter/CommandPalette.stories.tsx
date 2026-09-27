/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { MARKERS, S01, clock } from '../../stories/support';
import { StateFrame } from '../ui/primitives';
import { CommandPalette, type PaletteCommand } from './CommandPalette';

const meta: Meta<typeof CommandPalette> = {
  title: 'Presenter/CommandPalette',
  component: CommandPalette,
  args: { open: true, onOpenChange: fn(), onFreeTextTwist: fn() },
};
export default meta;
type Story = StoryObj<typeof CommandPalette>;

const commands: PaletteCommand[] = [
  { id: 'world', group: 'Run', label: 'Pause the world clock', icon: 'pause', shortcut: 'Space', run: fn() },
  { id: 'speed', group: 'Run', label: 'Set speed 15×', icon: 'clock', run: fn() },
  { id: 'stop', group: 'Run', label: 'Stop the run (kill switch)', icon: 'stop', run: fn() },
  { id: 'baseline', group: 'Run', label: 'Replay the baseline (paired run)', icon: 'users', run: fn() },
  { id: 'compare', group: 'Run', label: 'Side-by-side with the baseline', icon: 'expand', run: fn() },
  ...S01.scenario.twists.map((t) => ({
    id: `twist-${t.id}`,
    group: 'Twists',
    label: `Inject: ${t.title}`,
    icon: 'alert' as const,
    run: fn(),
  })),
  { id: 'twist-free-text', group: 'Twists', label: 'Inject a free-text twist…', icon: 'edit', run: fn() },
  ...MARKERS.filter((m) => m.kind !== 'proposal')
    .slice(0, 6)
    .map((m) => ({
      id: `jump-${m.seq}`,
      group: 'Jump to event',
      label: `${clock(m.minute)}Z · ${m.label}`,
      icon: 'chevronRight' as const,
      run: fn(),
    })),
  { id: 'captions', group: 'View', label: 'Hide story captions', icon: 'captions', run: fn() },
  { id: 'theme', group: 'View', label: 'Switch to the light theme', icon: 'sun', run: fn() },
  {
    id: 'presenter-pace',
    group: 'Presenter',
    label: 'Presenter pace: fast until the first decision: on',
    icon: 'clock',
    run: fn(),
  },
];

export const Empty: Story = { name: 'Empty (no context commands)', args: { commands: [] } };
export const Loading: Story = {
  render: () => (
    <StateFrame status="loading">
      <span />
    </StateFrame>
  ),
};
export const Live: Story = { args: { commands } };
export const ErrorState: Story = {
  name: 'Error (commands disabled)',
  args: { commands: commands.map((c) => ({ ...c, disabled: c.group === 'Run' })) },
};

/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { colors, motion, spacing, typography } from '@ica/ui-tokens';
import { fn } from 'storybook/test';
import {
  AiDraftedBadge,
  ApproverLine,
  Badge,
  Button,
  IconButton,
  Kbd,
  SimulatedBadge,
  Skeleton,
  StateFrame,
  TierBadge,
} from './primitives';

const meta: Meta<typeof StateFrame> = { title: 'Design system/Primitives', component: StateFrame };
export default meta;
type Story = StoryObj<typeof StateFrame>;

export const Empty: Story = { args: { empty: true, emptyText: 'Nothing yet', children: null } };
export const Loading: Story = { args: { status: 'loading', children: null } };
export const Live: Story = {
  name: 'Live (buttons, badges, trust cues)',
  render: () => (
    <div className="flex max-w-[720px] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={fn()}>
          Primary
        </Button>
        <Button variant="approve" kbd="A">
          Approve
        </Button>
        <Button kbd="E">Edit</Button>
        <Button variant="danger" kbd="R">
          Reject
        </Button>
        <Button variant="ghost">Ghost</Button>
        <IconButton icon="sun" label="Theme" />
        <Kbd>⌘K</Kbd>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>neutral</Badge>
        <Badge tone="good">good</Badge>
        <Badge tone="warning">warning</Badge>
        <Badge tone="critical">critical</Badge>
        <Badge tone="ai">ai</Badge>
        <TierBadge tier="execute" />
        <TierBadge tier="propose" />
        <TierBadge tier="forbidden" />
        <AiDraftedBadge />
        <SimulatedBadge />
      </div>
      <ApproverLine actor={{ kind: 'human', name: 'Sam Okafor', roleTitle: 'Duty Manager' }} />
      <Skeleton className="h-8 w-64" />
    </div>
  ),
};
export const ErrorState: Story = {
  name: 'Error',
  args: { status: 'error', error: 'Example failure', children: null },
};

export const Tokens: Story = {
  name: 'Tokens (both themes)',
  render: () => (
    <div className="flex flex-col gap-6">
      {(['dark', 'light'] as const).map((t) => (
        <section key={t} data-theme={t} className="rounded-lg bg-bg p-4">
          <h3 className="caps mb-2 text-fg-muted">{t}</h3>
          <div className="grid grid-cols-6 gap-2">
            {Object.entries(colors[t]).map(([name, hex]) => (
              <div key={name} className="flex flex-col gap-1">
                <span className="h-10 rounded-md border border-border" style={{ background: hex }} />
                <span className="text-micro text-fg-muted">{name}</span>
                <span className="font-mono text-micro text-fg-subtle">{hex}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
      <section>
        <h3 className="caps mb-2 text-fg-muted">Type scale</h3>
        {Object.entries(typography.scale).map(([k, v]) => (
          <p
            key={k}
            style={{ fontSize: v.size, lineHeight: `${v.lineHeight}px`, fontWeight: v.weight }}
            className="num text-fg"
          >
            {k} · {v.size}/{v.lineHeight} · €12,345
          </p>
        ))}
      </section>
      <p className="text-caption text-fg-muted">
        Spacing (8-pt grid): {Object.values(spacing).join(' · ')} px · Motion:{' '}
        {Object.values(motion.duration).join(' / ')} ms
      </p>
    </div>
  ),
};

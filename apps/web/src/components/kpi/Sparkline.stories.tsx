/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SERIES_MID, fourStates } from '../../stories/support';
import { Sparkline } from './Sparkline';

const meta: Meta<typeof Sparkline> = { title: 'Zones/KPI/Sparkline', component: Sparkline };
export default meta;
type Story = StoryObj<typeof Sparkline>;

const cost = SERIES_MID.map((p) => ({ minute: p.minute, value: p.kpis.totalCostEur.value }));
const s = fourStates(
  () => (
    <div className="flex items-center gap-6">
      <span className="text-fg-subtle">
        <Sparkline points={cost} />
      </span>
      <span className="text-warning">
        <Sparkline points={cost} width={160} height={40} />
      </span>
    </div>
  ),
  () => <Sparkline points={[]} />,
  (n) => <div className="w-72">{n}</div>,
);
export const Empty: Story = s.Empty;
export const Loading: Story = s.Loading;
export const Live: Story = s.Live;
export const ErrorState: Story = s.ErrorState;

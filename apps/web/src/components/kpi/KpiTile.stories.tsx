/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { fn } from 'storybook/test';
import { EARLY, GHOST_MID, MID, SERIES_MID, fourStates, kpiSeriesEarly } from '../../stories/support';
import { tileModels } from './kpiModel';
import { KpiTile } from './KpiTile';

const meta: Meta<typeof KpiTile> = { title: 'Zones/KPI/KpiTile', component: KpiTile };
export default meta;
type Story = StoryObj<typeof KpiTile>;

const grid = (n: ReactNode) => <div className="grid w-[720px] grid-cols-3 gap-2">{n}</div>;
const s = fourStates(
  () =>
    tileModels(MID.view.kpis!, GHOST_MID).map((m) => (
      <KpiTile key={m.key} model={m} kpis={MID.view.kpis!} series={SERIES_MID} onOpen={fn()} />
    )),
  () =>
    tileModels(EARLY.view.kpis!, null).map((m) => (
      <KpiTile key={m.key} model={m} kpis={EARLY.view.kpis!} series={kpiSeriesEarly} onOpen={fn()} />
    )),
  grid,
);
export const Empty: Story = { ...s.Empty, name: 'Empty (no baseline, calm)' };
export const Loading: Story = s.Loading;
export const Live: Story = { ...s.Live, name: 'Live (thresholds crossed, ghost delta)' };
export const ErrorState: Story = s.ErrorState;

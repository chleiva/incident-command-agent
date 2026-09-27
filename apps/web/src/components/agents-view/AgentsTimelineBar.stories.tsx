/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { AgentsTimelineBar } from './AgentsTimelineBar';
import { AuthorBanner } from './AuthorBanner';
import { SHOWCASE_MODEL } from './storyData';

function BarStory({ history = false }: { history?: boolean }) {
  const [minute, setMinute] = useState(history ? 31 : 58);
  const [hide, setHide] = useState(false);
  const live = minute >= 58;
  return (
    <div className="flex flex-col gap-2" style={{ width: 1100 }}>
      <AgentsTimelineBar
        maxMinute={58}
        cursorMinute={minute}
        live={live}
        clock={(m) => {
          const t = 6 * 60 + 50 + Math.round(m);
          return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
        }}
        playing={false}
        onPlayToggle={() => {}}
        onScrub={setMinute}
        onLive={() => setMinute(58)}
        hideThoughts={hide}
        onHideThoughts={setHide}
      />
      {SHOWCASE_MODEL.author && <AuthorBanner author={SHOWCASE_MODEL.author} />}
    </div>
  );
}

const meta: Meta<typeof BarStory> = {
  title: 'Agents view/Timeline bar and author banner',
  component: BarStory,
};
export default meta;
type Story = StoryObj<typeof BarStory>;

export const Live: Story = { args: {} };
export const History: Story = { name: 'History (Viewing m31 — Back to live)', args: { history: true } };

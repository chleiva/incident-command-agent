/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Preview } from '@storybook/react-vite';
import { MotionConfig } from 'framer-motion';
import '../src/index.css';

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'dark', title: 'Dark (ops room)' },
          { value: 'light', title: 'Light' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'dark' },
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
    a11y: { test: 'error' },
    backgrounds: { disable: true },
  },
  decorators: [
    (Story, ctx) => {
      document.documentElement.dataset.theme = (ctx.globals.theme as string) ?? 'dark';
      return (
        <MotionConfig reducedMotion="user">
          <div className="min-h-screen bg-bg p-4 text-fg">
            <Story />
          </div>
        </MotionConfig>
      );
    },
  ],
};

export default preview;

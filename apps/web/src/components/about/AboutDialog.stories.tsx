/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { DEFAULT_BRAND } from '../../lib/brand';
import { AboutDialog } from './AboutDialog';

const meta: Meta<typeof AboutDialog> = {
  title: 'App/About dialog',
  component: AboutDialog,
  args: { open: true, onOpenChange: () => {}, brand: DEFAULT_BRAND, commit: 'abc1234' },
};
export default meta;
type Story = StoryObj<typeof AboutDialog>;

export const Open: Story = {};
export const Fallback: Story = {
  name: 'Brand without an about block (fallback credit)',
  args: { brand: {} },
};

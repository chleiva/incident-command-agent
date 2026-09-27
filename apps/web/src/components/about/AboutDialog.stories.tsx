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

/** The public defaults: no author line, no repository link. */
export const Open: Story = {};
export const WithBrandCredit: Story = {
  name: 'Brand pack with an about block (credit shown)',
  args: {
    brand: {
      ...DEFAULT_BRAND,
      about: {
        author: 'Example Author',
        authorUrl: 'https://example.org/author',
        repoUrl: 'https://example.org/repo',
      },
    },
  },
};

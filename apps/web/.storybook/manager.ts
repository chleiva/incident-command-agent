/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Storybook manager: the product name as the Storybook title (task 06 §1.1). */
import { addons } from 'storybook/manager-api';
import { create } from 'storybook/theming';

addons.setConfig({
  theme: create({
    base: 'dark',
    brandTitle: 'Ground Incident Coordination Agent · design system',
  }),
});

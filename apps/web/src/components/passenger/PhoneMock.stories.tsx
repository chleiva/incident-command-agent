/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { END, MID } from '../../stories/support';
import { PhoneMock } from './PhoneMock';

const meta: Meta<typeof PhoneMock> = {
  title: 'Zones/Passengers/PhoneMock',
  component: PhoneMock,
  args: { senderId: 'NORTHWIND AIR' },
  decorators: [
    (Story) => (
      <div className="h-80">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof PhoneMock>;

export const Empty: Story = { args: { message: null } };
export const Loading: Story = { args: { message: null, status: 'loading' } };
export const Live: Story = {
  name: 'Live (AI-drafted, with approver)',
  args: { message: MID.view.systems.pss.messages['msg-1']!, sentAt: '06:56Z' },
};
export const Edited: Story = {
  name: 'Live (edited by the Duty Manager)',
  args: { message: END.view.systems.pss.messages['msg-2']!, sentAt: '07:31Z' },
};
export const ErrorState: Story = {
  name: 'Error',
  args: { message: null, status: 'error', error: 'Message unavailable' },
};

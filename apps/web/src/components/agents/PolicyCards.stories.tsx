/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { latestEngineeringDecision, latestProvisionalReading } from '../../lib/derive';
import { Frame, S01, S04, clock, pendingApproval, viewAt } from '../../stories/support';
import { ProvenancePanel } from '../decisions/Provenance';
import { AirworthinessPanel } from '../ground/AirworthinessPanel';
import { BlockedActionCard, InvalidationNotice, ProvisionalReadingBlock } from './PolicyCards';

const meta: Meta<typeof BlockedActionCard> = {
  title: 'Zones/Agents/PolicyCards',
  component: BlockedActionCard,
};
export default meta;
type Story = StoryObj<typeof BlockedActionCard>;

const blocked = viewAt(S01.agent, 21).view.guardrailBlocks[0]!;
const invalidation = viewAt(S04.agent, 26).view.approvals['ap4-msg-2']!;
const msg = pendingApproval(S01.agent, 'ap-msg-1').approval;
const end = viewAt(S01.agent, 56).view;
const early = viewAt(S01.agent, 20).view;

export const Blocked: Story = {
  name: 'Blocked by autonomy policy',
  render: () => (
    <Frame title="Agent activity" width={460}>
      <div className="flex flex-col gap-2">
        <BlockedActionCard block={blocked} />
        <BlockedActionCard
          block={{
            tool: 'release_aircraft',
            reason: "forbidden tool 'release_aircraft' attempted by maintenance",
            presenterTriggered: true,
          }}
        />
      </div>
    </Frame>
  ),
};

export const Invalidated: Story = {
  name: 'Approval invalidated',
  render: () => (
    <Frame title="Decision needed" width={420}>
      <InvalidationNotice
        invalidation={{
          approvalId: invalidation.approvalId,
          affectedAssumptions: invalidation.invalidated!.affectedAssumptions,
        }}
        proposal={{ summary: invalidation.summary, tool: invalidation.tool }}
        clock={clock}
        revisionPending
      />
    </Frame>
  ),
};

export const Provenance: Story = {
  name: 'Provenance and scope',
  render: () => (
    <Frame title="Decision card" width={420}>
      <ProvenancePanel
        createdAtMinute={msg.createdAtMinute}
        dataAsOfMinute={msg.dataAsOfMinute}
        citations={msg.citations}
        unresolvedChecks={msg.unresolvedChecks}
        approvalScope={msg.approvalScope}
        clock={clock}
      />
    </Frame>
  ),
};

export const Airworthiness: Story = {
  name: 'Provisional reading and Decided by',
  render: () => (
    <div className="flex gap-4">
      <Frame title="Ground (before the decision)" width={380}>
        <AirworthinessPanel
          aircraft={early.systems.mne.aircraft['AX-KES']!}
          reading={null}
          decision={latestEngineeringDecision(early)}
          workOrders={Object.values(early.systems.mne.workOrders)}
        />
      </Frame>
      <Frame title="Ground (decided)" width={380}>
        <AirworthinessPanel
          aircraft={end.systems.mne.aircraft['AX-KES']!}
          reading={latestProvisionalReading(end)?.reading ?? null}
          decision={latestEngineeringDecision(end)}
          workOrders={Object.values(end.systems.mne.workOrders)}
        />
      </Frame>
    </div>
  ),
};

export const Reading: Story = {
  name: 'Provisional reading block',
  render: () => (
    <Frame title="Report" width={420}>
      <ProvisionalReadingBlock
        reading={{
          text: 'Possible torque-link damage; needs inspection.',
          confidence: 'low',
          unconfirmed: true,
        }}
      />
    </Frame>
  ),
};

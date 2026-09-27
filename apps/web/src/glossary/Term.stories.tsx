/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { useUi } from '../store/ui';
import { Frame } from '../stories/support';
import { GLOSSARY } from './glossary';
import { GlossaryText, Term } from './Term';

/** Sets the plain-language toggle for a story (the same state the ⌘K "Plain language" command flips). */
const plain =
  (on: boolean): Decorator =>
  (Story) => {
    useUi.setState({ plainLanguage: on });
    return <Story />;
  };

const meta: Meta<typeof Term> = {
  title: 'Glossary/Term',
  component: Term,
  args: { term: 'MEL' },
};
export default meta;
type Story = StoryObj<typeof Term>;

const SAMPLE =
  'OCC asks whether the defect can wait under the MEL; certifying staff decide. The FDP margin is tight and reactionary delay is building on the rotation. PRM passengers are at the gate; an MOR is drafted.';

export const TermPlainOff: Story = {
  name: 'Term — plain language off',
  decorators: [plain(false)],
  render: () => (
    <Frame title="Term" width={420}>
      <p className="text-body text-fg">
        The <Term term="MEL" /> item exists, but the <Term term="deferral">deferral</Term> is for{' '}
        <Term term="certifying staff">certifying staff</Term>. Tab to a term to open its definition.
      </p>
    </Frame>
  ),
};

export const TermPlainOn: Story = {
  name: 'Term — plain language on',
  decorators: [plain(true)],
  render: TermPlainOff.render,
};

export const GlossaryTextPlainOff: Story = {
  name: 'GlossaryText — plain language off',
  decorators: [plain(false)],
  render: () => (
    <Frame title="Agent thought" width={460}>
      <p className="text-caption text-fg-muted">
        <GlossaryText text={SAMPLE} />
      </p>
    </Frame>
  ),
};

export const GlossaryTextPlainOn: Story = {
  name: 'GlossaryText — plain language on',
  decorators: [plain(true)],
  render: GlossaryTextPlainOff.render,
};

export const AllTerms: Story = {
  name: 'All glossary terms',
  decorators: [plain(false)],
  render: () => (
    <Frame title="Glossary" width={640}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-caption">
        {Object.values(GLOSSARY).map((e) => (
          <div key={e.term} className="contents">
            <dt className="text-fg">
              <Term term={e.term}>{e.term}</Term>
            </dt>
            <dd className="text-fg-muted">
              {e.definition} <span className="text-fg-subtle">· plain: “{e.inline}”</span>
            </dd>
          </div>
        ))}
      </dl>
    </Frame>
  ),
};

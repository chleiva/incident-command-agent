/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The exact message passengers received, on a phone, labelled AI-drafted with its approver. */
import type { PassengerMessage } from '@ica/schema/browser';
import { AnimatePresence, motion } from 'framer-motion';
import { actorLabel } from '../../lib/format';
import { AiDraftedBadge, Badge, Skeleton, type LoadStatus } from '../ui/primitives';

export function PhoneMock({
  message,
  senderId,
  sentAt,
  status = 'ready',
  error,
}: {
  message: PassengerMessage | null;
  senderId: string;
  /** Scenario clock time of sending, e.g. "06:56Z". */
  sentAt?: string;
  status?: LoadStatus;
  error?: string | null;
}) {
  return (
    <figure
      aria-label="Message as received by passengers"
      className="mx-auto flex h-full max-h-80 min-h-56 w-48 shrink-0 flex-col overflow-hidden rounded-xl border-4 border-surface-hover bg-surface-sunken shadow-e2"
    >
      <div className="flex h-7 shrink-0 items-center justify-center border-b border-border bg-surface-raised">
        <span className="truncate text-micro font-semibold tracking-wide text-fg-muted">{senderId}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-hidden p-2">
        {status === 'loading' ? (
          <Skeleton className="h-24 w-full" />
        ) : status === 'error' ? (
          <p role="alert" className="text-caption text-critical">
            {error ?? 'Message unavailable'}
          </p>
        ) : !message ? (
          <p className="text-center text-caption text-fg-subtle">No message sent yet.</p>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={message.id + message.body}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="flex min-h-0 flex-col gap-1"
            >
              <p
                tabIndex={0}
                className="min-h-0 overflow-y-auto rounded-lg rounded-bl-sm bg-surface-hover px-2 py-2 text-caption text-fg"
              >
                {message.body}
              </p>
              <span className="num text-micro text-fg-subtle">
                {message.channel.toUpperCase()} {sentAt ? `· ${sentAt}` : ''}
              </span>
            </motion.div>
          </AnimatePresence>
        )}
      </div>
      {message && status === 'ready' && (
        <figcaption className="flex shrink-0 flex-col gap-1 border-t border-border bg-surface-raised px-2 py-1">
          <span className="flex items-center gap-1">
            <AiDraftedBadge />
            {message.status !== 'sent' && <Badge tone="warning">{message.status.replace('_', ' ')}</Badge>}
          </span>
          {message.approvedBy && (
            <span className="truncate text-micro text-fg-muted" title={actorLabel(message.approvedBy)}>
              Approved by {actorLabel(message.approvedBy)}
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}

/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Toasts (reconnect, errors) and the polite live region used for new decisions and the run-ended card. */
import { AnimatePresence, motion } from 'framer-motion';
import { useUi, type ToastTone } from '../../store/ui';
import { Icon, type IconName } from './Icon';
import { cx } from './primitives';

const TONE: Record<ToastTone, { icon: IconName; cls: string }> = {
  info: { icon: 'info', cls: 'text-fg-muted' },
  good: { icon: 'check', cls: 'text-good' },
  warning: { icon: 'alert', cls: 'text-warning' },
  critical: { icon: 'alert', cls: 'text-critical' },
};

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2 }}
            role={t.tone === 'critical' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-start gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2 shadow-e2"
          >
            <span className={cx('mt-0.5', TONE[t.tone].cls)}>
              <Icon name={TONE[t.tone].icon} size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-body text-fg">{t.title}</div>
              {t.body && <div className="text-caption text-fg-muted">{t.body}</div>}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="text-fg-subtle hover:text-fg"
            >
              <Icon name="close" size={12} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function LiveAnnouncer() {
  const text = useUi((s) => s.announcement);
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </div>
  );
}

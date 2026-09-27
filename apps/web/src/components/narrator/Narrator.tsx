/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Story captions for audiences: one line, generated client-side from templates over events (no LLM). */
import { AnimatePresence, motion } from 'framer-motion';

export function Narrator({
  caption,
  visible = true,
}: {
  caption: { seq: number; text: string } | null;
  visible?: boolean;
}) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none flex h-8 max-w-full items-center justify-center" aria-live="off">
      <AnimatePresence mode="wait">
        {caption && (
          <motion.p
            key={caption.seq}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            data-testid="narrator"
            className="max-w-[100ch] truncate rounded-full border border-border bg-surface-raised px-4 py-1 text-body text-fg shadow-e1"
          >
            {caption.text}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

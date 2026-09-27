/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Side drawer on Radix Dialog: focus trap, Esc, focus returns to the trigger. */
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 440,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-bg/60"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount>
              <motion.div
                className="fixed right-0 top-0 z-50 flex h-full max-w-full flex-col border-l border-border bg-surface-raised shadow-e3 outline-none"
                style={{ width }}
                initial={{ x: 24, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 24, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
              >
                <div className="flex items-start gap-3 border-b border-border px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <Dialog.Title className="text-title text-fg">{title}</Dialog.Title>
                    {description ? (
                      <Dialog.Description className="mt-1 text-caption text-fg-muted">
                        {description}
                      </Dialog.Description>
                    ) : (
                      <Dialog.Description className="sr-only">Details</Dialog.Description>
                    )}
                  </div>
                  <Dialog.Close
                    aria-label="Close"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg"
                  >
                    <Icon name="close" size={14} />
                  </Dialog.Close>
                </div>
                <div className="zone-scroll min-h-0 flex-1 px-5 py-4">{children}</div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

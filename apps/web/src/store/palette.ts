/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Context commands registered by the current page for the global ⌘K palette. */
import { create } from 'zustand';
import type { PaletteCommand } from '../components/presenter/CommandPalette';

interface PaletteState {
  commands: PaletteCommand[];
  freeTextTwist: ((text: string) => void) | null;
  setContext(commands: PaletteCommand[], freeTextTwist?: ((text: string) => void) | null): void;
  clear(): void;
}

export const usePalette = create<PaletteState>()((set) => ({
  commands: [],
  freeTextTwist: null,
  setContext: (commands, freeTextTwist = null) => set({ commands, freeTextTwist }),
  clear: () => set({ commands: [], freeTextTwist: null }),
}));

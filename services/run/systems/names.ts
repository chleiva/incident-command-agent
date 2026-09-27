/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Fictional name generator. The surname list is invented for this project (compound, English-sounding place-like
 * words); combined with common given names it produces clearly fictional people. Never real employee data.
 */

export const GIVEN_NAMES = [
  'Ada',
  'Bram',
  'Cara',
  'Dev',
  'Elin',
  'Finn',
  'Greta',
  'Hal',
  'Ines',
  'Jory',
  'Kit',
  'Lena',
  'Milo',
  'Nell',
  'Oren',
  'Pia',
  'Quin',
  'Rhea',
  'Sol',
  'Tamsin',
  'Uma',
  'Vic',
  'Wren',
  'Xavi',
  'Yara',
  'Zed',
  'Arlo',
  'Bea',
  'Cass',
  'Dara',
  'Esme',
  'Fern',
  'Gil',
  'Hana',
  'Ivo',
  'Juno',
  'Kai',
  'Lior',
  'Maren',
  'Noor',
  'Otto',
  'Priya',
  'Rafe',
  'Sian',
  'Teo',
  'Vera',
  'Wim',
  'Zoe',
] as const;

export const FAMILY_NAMES = [
  'Ashcombe',
  'Brackwell',
  'Coldharbour',
  'Dunmere',
  'Elderby',
  'Fenwright',
  'Galloway-Sterne',
  'Harrowgate',
  'Ivesley',
  'Juniperwell',
  'Kestlemoor',
  'Larkstead',
  'Marrowby',
  'Northcote-Vale',
  'Oakenshaw',
  'Penhallow',
  'Quarrendon',
  'Rookwood',
  'Saltmarsh',
  'Thornbury-Hale',
  'Underhill',
  'Varden',
  'Wexcombe',
  'Yarrowby',
  'Ashwell-Pryce',
  'Birchmere',
  'Cobbleford',
  'Dovecote',
  'Emberlin',
  'Foxhollow',
  'Glenmarrow',
  'Hazelford',
  'Inglestone',
  'Kilnsey',
  'Lowmoor',
  'Merriven',
  'Nettlefold',
  'Orrinsby',
  'Pellowe',
  'Redmayne-Cross',
  'Stavenley',
  'Tollbridge',
  'Whitlowe',
  'Wrenfield',
  'Pennick',
  'Esterby',
  'Hollowmere',
  'Marshwood',
] as const;

/** A seeded fictional "Given Family" name. */
export function fictionalName(rng: () => number): string {
  const g = GIVEN_NAMES[Math.floor(rng() * GIVEN_NAMES.length)];
  const f = FAMILY_NAMES[Math.floor(rng() * FAMILY_NAMES.length)];
  return `${g} ${f}`;
}

/** Mulberry32: a tiny seeded PRNG (deterministic across platforms). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (seed from scenario id). */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

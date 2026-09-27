/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `Space` pauses/resumes the world clock (dashboard and Agents view). It is ignored while the viewer types or has
 * a control focused (Space activates buttons, radios, sliders…) and on the decision rail's cards, but it DOES work
 * while the decision popup card itself has focus, so a presenter can stop the clock while deciding ("Press Space
 * to pause the clock while you decide").
 */
import { useEffect, useRef } from 'react';

export const SPACE_IGNORE =
  'button, a, input, textarea, select, [role="slider"], [role="radio"], [role="tab"], [role="checkbox"], [contenteditable="true"], [data-approval]';

/** True when a Space keydown on `target` should toggle the world clock. */
export function spaceTogglesClock(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>,
  target: Element | null,
): boolean {
  if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey) return false;
  return !target?.closest(SPACE_IGNORE);
}

export function useSpaceToggle(toggle: () => void, enabled = true): void {
  const latest = useRef(toggle);
  latest.current = toggle;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!spaceTogglesClock(e, e.target instanceof Element ? e.target : null)) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

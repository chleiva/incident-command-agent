/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Ticking tabular numerals (cost meter). Reduced motion: jumps straight to the value. */
import { animate, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

export function AnimatedNumber({
  value,
  format,
  duration = 0.3,
}: {
  value: number;
  format: (n: number) => string;
  duration?: number;
}) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reduce || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const controls = animate(from.current, value, {
      duration,
      ease: [0.2, 0, 0, 1],
      onUpdate: (v) => setShown(v),
    });
    from.current = value;
    return () => controls.stop();
  }, [value, reduce, duration]);
  return <span className="num">{format(shown)}</span>;
}

/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { useLayoutEffect, useRef, useState } from 'react';

/** Measures an element with ResizeObserver (SVG views size themselves to their zone). */
export function useElementSize<T extends HTMLElement>(fallback = { width: 480, height: 240 }) {
  const ref = useRef<T>(null);
  const [size, setSize] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ width: Math.round(r.width), height: Math.round(r.height) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

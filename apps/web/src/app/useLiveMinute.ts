/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { RunProjection } from '@ica/schema/browser';
import { useEffect, useRef, useState } from 'react';

/**
 * A smooth sim clock for countdowns: the projection's sim minute, advanced between events at the run speed while
 * live and running (capped at one sim minute ahead — `world.tick` arrives every minute).
 */
export function useLiveMinute(view: RunProjection, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  const anchor = useRef({ minute: view.simMinute, at: Date.now() });
  if (anchor.current.minute !== view.simMinute) anchor.current = { minute: view.simMinute, at: Date.now() };
  const running = live && view.meta.status === 'running';
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [running]);
  if (!running) return view.simMinute;
  const ahead = ((now - anchor.current.at) / 60_000) * Math.max(1, view.meta.speed);
  return view.simMinute + Math.min(1, Math.max(0, ahead));
}

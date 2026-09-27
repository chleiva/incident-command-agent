/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './index.css';
import { bootServices } from './lib/config';
import { applyTheme, useUi } from './store/ui';

applyTheme(useUi.getState().theme);

const root = createRoot(document.getElementById('root')!);

/** Painted immediately so the page is never blank while config and sign-in resolve. */
function BootScreen() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--c-bg, #0b0f14)',
        color: 'var(--c-fg-muted, #8a96a8)',
        fontFamily: 'var(--font-sans, system-ui, sans-serif)',
        fontSize: 14,
        letterSpacing: '0.02em',
      }}
    >
      <div style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
        <div
          aria-hidden="true"
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: '2px solid currentColor',
            borderTopColor: 'transparent',
            animation: 'ica-boot-spin 0.9s linear infinite',
          }}
        />
        <span>Loading…</span>
        <span style={{ fontSize: 12, opacity: 0.7 }}>Simulated systems</span>
      </div>
    </div>
  );
}

root.render(<BootScreen />);

bootServices().then(
  (services) =>
    root.render(
      <StrictMode>
        <App services={services} />
      </StrictMode>,
    ),
  (err: unknown) => {
    root.render(
      <div role="alert" style={{ padding: 32, fontFamily: 'system-ui' }}>
        <h1>Could not start</h1>
        <p>{err instanceof Error ? err.message : String(err)}</p>
      </div>,
    );
  },
);

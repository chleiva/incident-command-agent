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

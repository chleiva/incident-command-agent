/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Top bar (brand, navigation, run status slot, the always-visible "simulated systems" badge) and global layers. */
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { NavLink, useMatch } from 'react-router-dom';
import { AboutDialog } from '../components/about/AboutDialog';
import { Icon } from '../components/ui/Icon';
import { IconButton, Kbd, SimulatedBadge, cx } from '../components/ui/primitives';
import { LiveAnnouncer, Toasts } from '../components/ui/Toasts';
import { useUi } from '../store/ui';
import { PRODUCT_NAME, simulatedLabel } from '../lib/brand';
import { useServices } from './services';

export function BrandMark({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-2">
      <svg width={22} height={22} viewBox="0 0 32 32" aria-hidden>
        <rect width={32} height={32} rx={7} fill="rgb(var(--c-brand-primary))" />
        <path d="M8 20.5 16 7l8 13.5-8-3.2z" fill="#E7EDF3" />
        <circle cx={16} cy={24} r={2} fill="rgb(var(--c-brand-accent))" />
      </svg>
      <span className="text-body-lg font-semibold text-fg">{name}</span>
    </span>
  );
}

export function AppShell({
  children,
  center,
  right,
}: {
  children: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
}) {
  const { app, mode, auth } = useServices();
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const setPalette = useUi((s) => s.setPaletteOpen);
  const aboutOpen = useUi((s) => s.aboutOpen);
  const setAboutOpen = useUi((s) => s.setAboutOpen);
  // The run currently open: the one in the URL, else the last one opened in this session.
  const runMatch = useMatch('/runs/:runId/*');
  const openRunId = useUi((s) => s.openRunId);
  const agentsRunId = runMatch?.params.runId ?? openRunId;
  // Evals stays reachable from the ⌘K palette only (owner request); Audit replaces it in the menu.
  const auditMatch = useMatch('/audit');
  const nav = ({ isActive }: { isActive: boolean }) =>
    cx(
      'rounded-md px-2 py-1 text-body',
      isActive ? 'bg-surface-hover text-fg' : 'text-fg-muted hover:text-fg',
    );
  return (
    <div className="flex h-full min-h-screen flex-col bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[70] focus:rounded-md focus:bg-surface-raised focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <NavLink to="/" aria-label={`${app.brand.carrierName} — home`}>
          <BrandMark name={app.brand.carrierName} />
        </NavLink>
        <span className="hidden text-caption text-fg-subtle 2xl:inline" data-product-name>
          {app.brand.productName ?? PRODUCT_NAME}
        </span>
        <nav aria-label="Main" className="ml-2 flex items-center gap-1">
          <NavLink to="/" end className={nav}>
            Network
          </NavLink>
          {agentsRunId ? (
            <NavLink to={`/runs/${encodeURIComponent(agentsRunId)}/agents`} className={nav}>
              Agents
            </NavLink>
          ) : (
            <Tooltip.Provider delayDuration={200}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <span
                    role="link"
                    aria-disabled="true"
                    tabIndex={0}
                    aria-describedby="nav-agents-hint"
                    data-nav-agents-disabled
                    className="cursor-not-allowed rounded-md px-2 py-1 text-body text-fg-subtle"
                  >
                    Agents
                  </span>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    side="bottom"
                    sideOffset={4}
                    className="z-[80] rounded-md border border-border bg-surface-raised px-2 py-1 text-caption text-fg shadow-e2"
                  >
                    Open an incident first
                    <Tooltip.Arrow className="fill-surface-raised" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
          )}
          <NavLink
            to={agentsRunId ? `/runs/${encodeURIComponent(agentsRunId)}/audit` : '/audit'}
            className={(a) => nav({ isActive: a.isActive || !!auditMatch })}
          >
            Audit
          </NavLink>
          <NavLink to="/training" className={nav}>
            Training scenarios
          </NavLink>
        </nav>
        {!agentsRunId && (
          <span id="nav-agents-hint" className="sr-only">
            Open an incident first
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-3">{center}</div>
        {right}
        <SimulatedBadge text={simulatedLabel(app.brand.disclaimer)} />
        {mode === 'mock' && (
          <span
            className="rounded-sm bg-surface-hover px-2 py-0.5 text-micro text-fg-muted"
            title="In-browser fake backend replaying recorded runs"
          >
            mock mode
          </span>
        )}
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="hidden h-7 items-center gap-2 rounded-md border border-border-control/60 px-2 text-caption text-fg-muted hover:text-fg md:inline-flex"
          aria-label="Open the command palette"
          aria-keyshortcuts="Meta+K Control+K"
        >
          <Icon name="command" size={12} /> Commands <Kbd>⌘K</Kbd>
        </button>
        <IconButton
          icon={theme === 'dark' ? 'sun' : 'moon'}
          label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />
        <button
          type="button"
          onClick={() => setAboutOpen(true)}
          className="h-7 rounded-md px-2 text-caption text-fg-subtle hover:bg-surface-hover hover:text-fg"
          data-testid="about-button"
        >
          About
        </button>
        {auth.mode === 'cognito' && (
          <IconButton
            icon="user"
            label={`Sign out ${auth.userName() ?? ''}`}
            onClick={() => void auth.logout()}
          />
        )}
      </header>
      <main id="main" className="min-h-0 flex-1">
        {children}
      </main>
      <Toasts />
      <LiveAnnouncer />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} brand={app.brand} />
    </div>
  );
}

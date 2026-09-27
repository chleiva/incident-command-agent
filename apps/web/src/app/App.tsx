/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Routes (code-split), the global ⌘K palette and motion preferences. */
import { MotionConfig } from 'framer-motion';
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider, useNavigate, Outlet } from 'react-router-dom';
import { CommandPalette, type PaletteCommand } from '../components/presenter/CommandPalette';
import { Skeleton } from '../components/ui/primitives';
import type { Services } from '../lib/config';
import { usePalette } from '../store/palette';
import { useUi } from '../store/ui';
import { ServicesProvider } from './services';

const Home = lazy(() => import('../routes/Home'));
const Training = lazy(() => import('../routes/Training'));
const Cockpit = lazy(() => import('../routes/Cockpit'));
const Compare = lazy(() => import('../routes/Compare'));
const Agents = lazy(() => import('../routes/Agents'));
const Evals = lazy(() => import('../routes/Evals'));

function PageSkeleton() {
  return (
    <div className="flex h-screen flex-col gap-2 p-2" role="status" aria-label="Loading">
      <Skeleton className="h-12" />
      <div className="grid grid-cols-6 gap-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid flex-1 grid-cols-12 gap-2">
        <Skeleton className="col-span-5" />
        <Skeleton className="col-span-4" />
        <Skeleton className="col-span-3" />
      </div>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (this.state.error) {
      return (
        <div role="alert" className="mx-auto max-w-xl p-8 text-body text-fg">
          <h1 className="text-heading">Something went wrong</h1>
          <p className="mt-2 text-fg-muted">{this.state.error.message}</p>
          <a className="mt-4 inline-block underline" href="/">
            Back to the network
          </a>
        </div>
      );
    }
    return this.props.children;
  }
}

function GlobalPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const liveContext = usePalette((s) => s.commands);
  // Freeze the list while the palette is open: a live run keeps adding "jump to" targets, and re-rendering
  // cmdk items mid-search would reset the filter and selection. Commands still act on the latest state.
  const [context, setContext] = useState(liveContext);
  useEffect(() => {
    if (!open) setContext(liveContext);
  }, [open, liveContext]);
  const freeText = usePalette((s) => s.freeTextTwist);
  const theme = useUi((s) => s.theme);
  const plain = useUi((s) => s.plainLanguage);
  const navigate = useNavigate();
  const openRunId = useUi((s) => s.openRunId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useUi.getState().paletteOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  const base: PaletteCommand[] = [
    { id: 'home', group: 'Navigate', label: 'Live network (home)', icon: 'plane', run: () => navigate('/') },
    ...(openRunId
      ? [
          {
            id: 'agents',
            group: 'Navigate',
            label: 'Agents view (the open incident)',
            icon: 'users' as const,
            keywords: ['agents', 'columns', 'activity', 'who did what'],
            run: () => navigate(`/runs/${encodeURIComponent(openRunId)}/agents`),
          },
        ]
      : []),
    {
      id: 'training',
      group: 'Navigate',
      label: 'Training scenarios',
      icon: 'file',
      keywords: ['scenarios', 'library', 'training'],
      run: () => navigate('/training'),
    },
    {
      id: 'evals',
      group: 'Navigate',
      label: 'Evaluation report',
      icon: 'check',
      run: () => navigate('/evals'),
    },
    {
      id: 'about',
      group: 'Navigate',
      label: 'About',
      icon: 'info',
      keywords: ['about', 'credits', 'version', 'licences', 'sources'],
      run: () => useUi.getState().setAboutOpen(true),
    },
    {
      id: 'theme',
      group: 'View',
      label: theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
      icon: theme === 'dark' ? 'sun' : 'moon',
      run: () => useUi.getState().setTheme(theme === 'dark' ? 'light' : 'dark'),
    },
    {
      id: 'plain-language',
      group: 'View',
      label: plain
        ? 'Plain language: on (show aviation terms)'
        : 'Plain language: off (explain aviation terms)',
      icon: 'captions',
      keywords: ['plain language', 'glossary', 'jargon', 'explain', 'terms'],
      run: () => useUi.getState().togglePlainLanguage(),
    },
  ];
  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      commands={[...context, ...base]}
      onFreeTextTwist={freeText ?? undefined}
    />
  );
}

function Root() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PageSkeleton />}>
        <Outlet />
      </Suspense>
      <GlobalPalette />
    </ErrorBoundary>
  );
}

export function App({ services }: { services: Services }) {
  const router = createBrowserRouter([
    {
      element: <Root />,
      children: [
        { path: '/', element: <Home /> },
        { path: '/training', element: <Training /> },
        { path: '/runs/:runId', element: <Cockpit /> },
        { path: '/runs/:runId/agents', element: <Agents /> },
        { path: '/compare/:agentRunId/:baselineRunId', element: <Compare /> },
        { path: '/evals', element: <Evals /> },
        { path: '*', element: <Home /> },
      ],
    },
  ]);
  return (
    <ServicesProvider services={services}>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}>
        <RouterProvider router={router} />
      </MotionConfig>
    </ServicesProvider>
  );
}

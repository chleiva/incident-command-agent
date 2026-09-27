/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * About (owner request): product, credit, build version, trust notes, data sources and licences, and the
 * repository. Radix Dialog: focus trap, Esc to close, focus returns to the trigger. The credit comes from the brand
 * pack (`about`), with the default values as a fallback.
 */
import * as Dialog from '@radix-ui/react-dialog';
import type { BrandPack } from '@ica/schema/browser';
import { useRef } from 'react';
import { DEFAULT_ABOUT, PRODUCT_NAME } from '../../lib/brand';
import { Icon } from '../ui/Icon';

export const ABOUT_TAGLINE =
  'Agentic incident coordination for airline operations — a demonstration on simulated systems.';

export const APP_COMMIT: string =
  typeof __APP_COMMIT__ === 'string' && __APP_COMMIT__ ? __APP_COMMIT__ : 'dev';

export const DATA_SOURCES: { name: string; licence: string }[] = [
  { name: 'NASA ASRS', licence: 'public domain' },
  { name: 'UK AAIB', licence: 'Open Government Licence v3' },
  { name: 'FAA', licence: 'public domain' },
  { name: 'EASA', licence: 'with attribution' },
  { name: 'UK CAA', licence: 'with attribution' },
  { name: 'EUROCONTROL', licence: 'with attribution' },
  { name: 'Airbus Safety First', licence: 'reprinted with acknowledgement' },
  { name: 'OurAirports', licence: 'public domain' },
];

const TRUST_NOTES = [
  'Simulated systems · fictional carrier',
  'AI-drafted text is labelled',
  'People decide on airworthiness, people and money',
  'The commander flies the aircraft',
];

const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

export function AboutDialog({
  open,
  onOpenChange,
  brand,
  commit = APP_COMMIT,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brand?: Pick<BrandPack, 'productName' | 'about'>;
  commit?: string;
}) {
  // Opened from the top bar or the ⌘K palette (no Dialog.Trigger): return focus to where it was on close.
  const returnTo = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== 'undefined')
    returnTo.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;
  const about = { ...DEFAULT_ABOUT, ...(brand?.about ?? {}) };
  const product = brand?.productName ?? PRODUCT_NAME;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-bg/70" />
        <Dialog.Content
          onCloseAutoFocus={(e) => {
            const el = returnTo.current;
            if (el && el.isConnected && el !== document.body) {
              e.preventDefault();
              el.focus();
            }
          }}
          data-testid="about-dialog"
          className="fixed left-1/2 top-1/2 z-[60] flex max-h-[85vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-surface-raised shadow-e3 outline-none"
        >
          <div className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-title text-fg">{product}</Dialog.Title>
              <Dialog.Description className="mt-1 text-caption text-fg-muted">
                {ABOUT_TAGLINE}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg"
            >
              <Icon name="close" size={14} />
            </Dialog.Close>
          </div>
          <div className="zone-scroll flex min-h-0 flex-col gap-4 px-5 py-4 text-body text-fg-muted">
            <p data-about-credit>
              Designed and developed by{' '}
              <a
                href={about.authorUrl}
                {...external}
                className="text-fg underline decoration-border-control underline-offset-2 hover:decoration-fg"
              >
                {about.author}
              </a>
            </p>
            <p className="text-caption">
              Version{' '}
              <span className="num font-mono text-fg" data-about-version>
                {commit}
              </span>
            </p>
            <section aria-labelledby="about-trust">
              <h3 id="about-trust" className="caps mb-1 text-fg-subtle">
                Trust
              </h3>
              <ul className="list-disc pl-5 text-caption">
                {TRUST_NOTES.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="about-sources">
              <h3 id="about-sources" className="caps mb-1 text-fg-subtle">
                Data sources and licences
              </h3>
              <ul className="grid grid-cols-1 gap-x-4 text-caption sm:grid-cols-2">
                {DATA_SOURCES.map((s) => (
                  <li key={s.name}>
                    <span className="text-fg">{s.name}</span> — {s.licence}
                  </li>
                ))}
              </ul>
            </section>
            {about.repoUrl && (
              <p className="text-caption">
                Source code:{' '}
                <a
                  href={about.repoUrl}
                  {...external}
                  className="text-fg underline decoration-border-control underline-offset-2 hover:decoration-fg"
                >
                  {about.repoUrl.replace(/^https?:\/\//, '')}
                </a>
              </p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

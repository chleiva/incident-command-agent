/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Small design-system primitives: Button, Badge, trust badges, Kbd, Skeleton, state frames. */
import type { Actor, Tier } from '@ica/schema/browser';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { actorLabel } from '../../lib/format';
import { Icon, type IconName } from './Icon';

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

export type Tone = 'neutral' | 'good' | 'warning' | 'critical' | 'ai';

const BUTTON_VARIANTS = {
  primary: 'bg-fg text-bg hover:bg-fg-muted',
  approve: 'bg-good text-on-good hover:brightness-110',
  secondary: 'bg-surface-raised text-fg border border-border-control/70 hover:bg-surface-hover',
  ghost: 'text-fg-muted hover:text-fg hover:bg-surface-hover',
  danger: 'text-critical border border-critical/60 hover:bg-critical-bg',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: 'sm' | 'md';
  icon?: IconName;
  kbd?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, kbd, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex select-none items-center justify-center gap-1 whitespace-nowrap rounded-md font-medium transition-colors duration-fast ease-standard disabled:opacity-50',
        size === 'sm' ? 'h-6 px-2 text-caption' : 'h-8 px-3 text-body',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 12 : 14} />}
      {children}
      {kbd && <Kbd className="ml-1 opacity-80">{kbd}</Kbd>}
    </button>
  );
});

export function IconButton({
  icon,
  label,
  className,
  pressed,
  ...rest
}: { icon: IconName; label: string; pressed?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cx(
        'inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-colors duration-fast hover:bg-surface-hover hover:text-fg',
        pressed && 'bg-surface-hover text-fg',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-surface-hover text-fg-muted',
  good: 'bg-good-bg text-good',
  warning: 'bg-warning-bg text-warning',
  critical: 'bg-critical-bg text-critical',
  ai: 'bg-ai-bg text-ai',
};

export function Badge({
  tone = 'neutral',
  icon,
  children,
  className,
  title,
}: {
  tone?: Tone;
  icon?: IconName;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm px-2 text-micro font-medium',
        BADGE_TONES[tone],
        className,
      )}
    >
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}

/** Autonomy tier (trust cue): execute = neutral, propose = needs a human, forbidden = blocked. */
export function TierBadge({ tier }: { tier: Tier }) {
  const tone: Tone = tier === 'forbidden' ? 'critical' : tier === 'propose' ? 'warning' : 'neutral';
  const title =
    tier === 'execute'
      ? 'Execute: the agent may run this itself'
      : tier === 'propose'
        ? 'Propose: a human must approve'
        : 'Forbidden: reserved for humans; blocked in code';
  return (
    <Badge tone={tone} title={title} className="uppercase tracking-wide">
      {tier}
    </Badge>
  );
}

/** AI transparency (EU AI Act Art 50): every AI-drafted text is labelled. */
export function AiDraftedBadge({ className }: { className?: string }) {
  return (
    <Badge
      tone="ai"
      icon="sparkle"
      className={className}
      title="Drafted by an AI agent; a human approved it before it was used"
    >
      AI-drafted
    </Badge>
  );
}

export function ApproverLine({
  actor,
  prefix = 'Approved by',
}: {
  actor: Actor | undefined;
  prefix?: string;
}) {
  if (!actor) return null;
  return (
    <span className="inline-flex items-center gap-1 text-caption text-fg-muted">
      <Icon name="user" size={12} />
      {prefix} <span className="text-fg">{actorLabel(actor)}</span>
    </span>
  );
}

export function SimulatedBadge({ text = 'Simulated systems · fictional carrier' }: { text?: string }) {
  return (
    <span
      className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full border border-border-control/60 px-3 text-caption text-fg-muted"
      title="All airline systems are simulated and the carrier is fictional"
    >
      <span className="h-2 w-2 rounded-full bg-fg-subtle" aria-hidden />
      {text}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-border px-1 font-mono text-[10px] leading-none text-fg-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-soft-pulse rounded-md bg-surface-hover', className)} />;
}

export type LoadStatus = 'loading' | 'error' | 'ready';

/** The four component states (empty, loading, live, error) in one wrapper. */
export function StateFrame({
  status = 'ready',
  error,
  empty,
  emptyText,
  skeleton,
  children,
  onRetry,
}: {
  status?: LoadStatus;
  error?: string | null;
  empty?: boolean;
  emptyText?: ReactNode;
  skeleton?: ReactNode;
  children: ReactNode;
  onRetry?: () => void;
}) {
  if (status === 'loading') {
    return (
      <div role="status" aria-label="Loading" className="flex h-full flex-col gap-2 p-1">
        {skeleton ?? (
          <>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-16 w-full" />
          </>
        )}
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-start justify-center gap-2 p-2 text-body text-fg-muted"
      >
        <span className="inline-flex items-center gap-1 text-critical">
          <Icon name="alert" size={14} /> Couldn’t load this view
        </span>
        {error && <span className="text-caption text-fg-subtle">{error}</span>}
        {onRetry && (
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  }
  if (empty) {
    return (
      <div className="flex h-full items-center justify-center p-3 text-center text-body text-fg-subtle">
        {emptyText ?? 'Nothing yet'}
      </div>
    );
  }
  return <>{children}</>;
}

/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * ⌘K presenter palette (cmdk in a Radix dialog: focus trap and return). Run control, twists (scenario list or
 * free text), baseline replay, reset, side-by-side, captions, theme, jump to event, switch scenario.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { useState } from 'react';
import { Icon, type IconName } from '../ui/Icon';
import { Kbd } from '../ui/primitives';

export interface PaletteCommand {
  id: string;
  group: string;
  label: string;
  icon?: IconName;
  shortcut?: string;
  keywords?: string[];
  disabled?: boolean;
  run: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  commands,
  onFreeTextTwist,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
  onFreeTextTwist?: (text: string) => void;
}) {
  const [page, setPage] = useState<'root' | 'twist'>('root');
  const [search, setSearch] = useState('');
  const groups = [...new Set(commands.map((c) => c.group))];
  const close = () => {
    onOpenChange(false);
    setPage('root');
    setSearch('');
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[14vh] z-50 w-[640px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface-raised shadow-e3 outline-none"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command
            label="Command palette"
            loop
            onKeyDown={(e) => {
              if (page === 'twist' && e.key === 'Backspace' && !search) {
                e.preventDefault();
                setPage('root');
              }
            }}
          >
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Icon name={page === 'twist' ? 'edit' : 'search'} size={14} className="text-fg-subtle" />
              <Command.Input
                value={search}
                onValueChange={setSearch}
                autoFocus
                placeholder={
                  page === 'twist'
                    ? 'Describe the twist in plain words, then press Enter…'
                    : 'Type a command or search events…'
                }
                aria-label={page === 'twist' ? 'Free-text twist' : 'Search commands'}
                onKeyDown={(e) => {
                  if (page === 'twist' && e.key === 'Enter' && search.trim()) {
                    e.preventDefault();
                    onFreeTextTwist?.(search.trim());
                    close();
                  }
                }}
                className="h-12 flex-1 bg-transparent text-body-lg text-fg placeholder:text-fg-subtle focus:outline-none"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[50vh] overflow-y-auto p-2">
              {page === 'twist' ? (
                <p className="px-2 py-3 text-caption text-fg-muted">
                  Free-text twists are screened and delivered to the agents as data, never as instructions.
                  Backspace on an empty field goes back.
                </p>
              ) : (
                <>
                  <Command.Empty className="px-2 py-3 text-body text-fg-subtle">
                    No matching command.
                  </Command.Empty>
                  {commands.length === 0 && (
                    <Command.Item
                      disabled
                      value="no commands"
                      className="flex h-9 items-center rounded-md px-2 text-body text-fg-subtle"
                    >
                      No commands available here
                    </Command.Item>
                  )}
                  {groups.map((g) => (
                    <Command.Group
                      key={g}
                      heading={g}
                      className="[&_[cmdk-group-heading]]:caps [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-fg-subtle"
                    >
                      {commands
                        .filter((c) => c.group === g)
                        .map((c) => (
                          <Command.Item
                            key={c.id}
                            value={`${c.group} ${c.label} ${c.keywords?.join(' ') ?? ''}`}
                            disabled={c.disabled}
                            onSelect={() => {
                              if (c.id === 'twist-free-text') {
                                setPage('twist');
                                setSearch('');
                                return;
                              }
                              c.run();
                              close();
                            }}
                            className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-body text-fg-muted data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40 data-[selected=true]:bg-surface-hover data-[selected=true]:text-fg"
                          >
                            {c.icon && <Icon name={c.icon} size={14} />}
                            <span className="truncate">{c.label}</span>
                            {c.shortcut && <Kbd className="ml-auto">{c.shortcut}</Kbd>}
                          </Command.Item>
                        ))}
                    </Command.Group>
                  ))}
                </>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

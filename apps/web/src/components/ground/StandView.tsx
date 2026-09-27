/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * "What is happening on the ground?" A top-down stand: the aircraft, tug and GSE, the engineer moving along the
 * ETA path, the spare on the adjacent stand, and stairs and buses appearing as they are confirmed.
 */
import type { Aircraft, Engineer, ResourceRequest, Stand } from '@ica/schema/browser';
import { motion } from 'framer-motion';
import { formatDuration } from '../../lib/format';
import { StateFrame, type LoadStatus } from '../ui/primitives';

/** Top-down narrow-body silhouette, nose up, centred on (0, 0), ~150 × 140. */
const AIRCRAFT_PATH = [
  'M0,-76 C6,-76 9,-66 9,-56 L9,-8 L70,18 L70,27 L9,14 L9,52 L30,64 L30,71 L6,66 L3,76 L-3,76 L-6,66 L-30,71 L-30,64 L-9,52',
  'L-9,14 L-70,27 L-70,18 L-9,-8 L-9,-56 C-9,-66 -6,-76 0,-76 Z',
].join(' ');

const ACTIVE = new Set(['confirmed', 'en_route', 'on_site']);

export interface StandViewProps {
  aircraft: Aircraft | null;
  stand?: Stand;
  adjacent?: { stand: Stand; tail?: string; assigned?: boolean } | null;
  engineer?: { engineer: Engineer; progress: number; etaMin: number | null } | null;
  resources: ResourceRequest[];
  weather?: string;
  status?: LoadStatus;
  error?: string | null;
}

export function StandView({
  aircraft,
  stand,
  adjacent,
  engineer,
  resources,
  weather,
  status = 'ready',
  error,
}: StandViewProps) {
  const has = (kind: ResourceRequest['kind']) => resources.filter((r) => r.kind === kind);
  const tows = has('tow');
  const stairs = has('stairs').filter((r) => ACTIVE.has(r.status));
  const buses = has('bus').filter((r) => ACTIVE.has(r.status));
  const towActive = tows.some((r) => ACTIVE.has(r.status));
  const tone =
    aircraft?.status === 'aog' ? 'critical' : aircraft?.status === 'unserviceable' ? 'warning' : null;
  const ring = tone ? `rgb(var(--c-${tone}))` : 'rgb(var(--c-border-control))';

  // Engineer path: line office (bottom left) → nose of the aircraft.
  const from = { x: 28, y: 238 };
  const to = { x: 132, y: 54 };
  const prog = engineer?.progress ?? 0;
  const ex = from.x + (to.x - from.x) * prog;
  const ey = from.y + (to.y - from.y) * prog;
  const flying = engineer?.engineer.travelMode === 'fly' && engineer.engineer.status === 'travelling';

  const description = [
    aircraft
      ? `${aircraft.tail} on stand ${stand?.id ?? aircraft.stand ?? '?'}, ${aircraft.status}.`
      : 'No aircraft.',
    engineer
      ? engineer.engineer.status === 'on_site'
        ? `Engineer ${engineer.engineer.name} on site.`
        : `Engineer ${engineer.engineer.name} ${engineer.engineer.status}${engineer.etaMin !== null ? `, ETA ${Math.round(engineer.etaMin)} min` : ''}.`
      : '',
    adjacent?.tail ? `Spare ${adjacent.tail} on stand ${adjacent.stand.id}.` : '',
    stairs.length ? 'Stairs at the aircraft.' : '',
    buses.length ? `${buses.length} bus request(s) active.` : '',
    tows.length ? `Tow ${tows[0]!.status}.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <StateFrame status={status} error={error} empty={!aircraft} emptyText="No aircraft on stand yet.">
      <div className="flex h-full min-h-0 flex-col">
        <svg
          viewBox="0 0 400 260"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={description}
          className="min-h-0 w-full flex-1"
        >
          {/* apron */}
          <rect x={0} y={0} width={400} height={260} rx={8} fill="rgb(var(--c-surface-sunken))" />
          <line x1={0} y1={236} x2={400} y2={236} stroke="rgb(var(--c-border))" strokeDasharray="6 6" />
          <text x={8} y={252} fontSize={9} fill="rgb(var(--c-fg-subtle))">
            Line maintenance
          </text>
          {/* stand boxes */}
          {[
            { x: 60, label: stand?.id ?? aircraft?.stand ?? '' },
            { x: 230, label: adjacent?.stand.id ?? '' },
          ].map((s, i) => (
            <g key={i}>
              <rect
                x={s.x}
                y={24}
                width={150}
                height={196}
                rx={4}
                fill="none"
                stroke="rgb(var(--c-border))"
              />
              <line
                x1={s.x + 75}
                y1={24}
                x2={s.x + 75}
                y2={220}
                stroke="rgb(var(--c-border))"
                strokeDasharray="4 4"
              />
              {s.label && (
                <text x={s.x + 6} y={214} fontSize={10} fill="rgb(var(--c-fg-subtle))" className="num">
                  Stand {s.label}
                </text>
              )}
            </g>
          ))}

          {/* aircraft */}
          {aircraft && (
            <g transform="translate(135,122)">
              <path
                d={AIRCRAFT_PATH}
                fill="rgb(var(--c-surface-hover))"
                stroke={ring}
                strokeWidth={tone ? 2 : 1.25}
              />
              <text
                y={4}
                textAnchor="middle"
                fontSize={9}
                fill="rgb(var(--c-fg))"
                className="num"
                transform="rotate(-90)"
              >
                {aircraft.tail}
              </text>
              {tone && (
                <circle cx={0} cy={-62} r={7} fill="none" stroke={ring} strokeWidth={1.5}>
                  <title>Damage area</title>
                </circle>
              )}
            </g>
          )}

          {/* tug at the nose */}
          {tows.length > 0 && (
            <motion.g
              initial={false}
              animate={{ opacity: towActive ? 1 : 0.45 }}
              transition={{ duration: 0.3 }}
            >
              <rect x={125} y={30} width={20} height={12} rx={2} fill="rgb(var(--c-fg-muted))" />
              <text x={150} y={40} fontSize={9} fill="rgb(var(--c-fg-subtle))">
                {towActive ? 'tug' : 'tug (awaited)'}
              </text>
            </motion.g>
          )}

          {/* stairs at the doors */}
          {stairs.length > 0 && (
            <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
              <rect x={108} y={62} width={14} height={8} rx={1} fill="rgb(var(--c-fg-muted))" />
              <rect x={108} y={168} width={14} height={8} rx={1} fill="rgb(var(--c-fg-muted))" />
              <text x={70} y={60} fontSize={9} fill="rgb(var(--c-fg-subtle))">
                stairs
              </text>
            </motion.g>
          )}

          {/* buses */}
          {buses.map((b, i) => (
            <motion.g
              key={b.id}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: b.status === 'on_site' ? 0 : 30 }}
              transition={{ duration: 0.3 }}
            >
              <rect x={24} y={90 + i * 34} width={30} height={14} rx={3} fill="rgb(var(--c-fg-muted))" />
              <text x={24} y={86 + i * 34} fontSize={9} fill="rgb(var(--c-fg-subtle))">
                bus {b.status === 'on_site' ? '' : '(en route)'}
              </text>
            </motion.g>
          ))}

          {/* spare on the adjacent stand */}
          {adjacent?.tail && (
            <g transform="translate(305,122)" opacity={0.9}>
              <path
                d={AIRCRAFT_PATH}
                fill="none"
                stroke={adjacent.assigned ? 'rgb(var(--c-good))' : 'rgb(var(--c-fg-subtle))'}
                strokeWidth={1.25}
                strokeDasharray={adjacent.assigned ? undefined : '3 3'}
              />
              <text
                y={4}
                textAnchor="middle"
                fontSize={9}
                fill="rgb(var(--c-fg-muted))"
                transform="rotate(-90)"
                className="num"
              >
                {adjacent.tail}
              </text>
              <text
                x={-60}
                y={-86}
                fontSize={9}
                fill={adjacent.assigned ? 'rgb(var(--c-good))' : 'rgb(var(--c-fg-subtle))'}
              >
                {adjacent.assigned ? 'spare assigned' : 'spare candidate'}
              </text>
            </g>
          )}

          {/* engineer ETA path */}
          {engineer && !flying && (
            <g>
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="rgb(var(--c-border-control))"
                strokeDasharray="2 4"
              />
              <motion.g
                initial={false}
                animate={{ x: ex, y: ey }}
                transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
              >
                <circle r={9} fill="rgb(var(--c-fg))" />
                <text y={3.5} textAnchor="middle" fontSize={10} fontWeight={600} fill="rgb(var(--c-bg))">
                  E
                </text>
              </motion.g>
            </g>
          )}
          {engineer && flying && (
            <g>
              <circle cx={380} cy={20} r={9} fill="rgb(var(--c-fg))" />
              <text
                x={380}
                y={23.5}
                textAnchor="middle"
                fontSize={10}
                fontWeight={600}
                fill="rgb(var(--c-bg))"
              >
                E
              </text>
            </g>
          )}
        </svg>
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-1 pt-1 text-caption text-fg-muted">
          {engineer ? (
            <span>
              <span className="text-fg">{engineer.engineer.name}</span> ({engineer.engineer.licence}) ·{' '}
              {engineer.engineer.status === 'on_site'
                ? 'on site'
                : engineer.etaMin !== null
                  ? `${flying ? 'inbound by air, ' : ''}ETA ${formatDuration(Math.max(0, engineer.etaMin))}`
                  : engineer.engineer.status}
            </span>
          ) : (
            <span>No engineer assigned yet</span>
          )}
          {weather && <span className="truncate text-fg-subtle">{weather}</span>}
        </div>
      </div>
    </StateFrame>
  );
}

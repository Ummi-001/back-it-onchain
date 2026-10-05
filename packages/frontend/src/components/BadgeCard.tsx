import React from 'react';
import { cn } from '../../lib/utils';
import { BadgeState, RARITY_STYLES } from '../lib/badge-defs';

interface BadgeCardProps {
  state: BadgeState;
  onSelect?: (state: BadgeState) => void;
}

/**
 * A single achievement badge. Renders locked (greyscale) or unlocked (full
 * colour + celebration animation) with a progress bar and hover tooltip.
 */
export function BadgeCard({ state, onSelect }: BadgeCardProps) {
  const { definition, unlocked, percent, current, remaining } = state;
  const rarity = RARITY_STYLES[definition.rarity];

  const tooltip = unlocked
    ? `${definition.description} · Unlocked`
    : `${definition.description} · ${current}/${definition.threshold} ${definition.metric} (${remaining} to go)`;

  return (
    <div
      data-testid={`badge-${definition.id}`}
      data-unlocked={unlocked}
      title={tooltip}
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(state)}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(state); } }}
      className={cn(
        'group relative flex flex-col items-center gap-2 rounded-xl border border-white/10 bg-zinc-900/60 p-4 ring-1 transition',
        rarity.ring,
        unlocked ? 'opacity-100' : 'opacity-60 hover:opacity-90',
      )}
    >
      {unlocked && (
        <span
          aria-hidden
          className="absolute -right-1 -top-1 flex h-3 w-3 animate-in zoom-in-50"
        >
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
        </span>
      )}

      <div
        className={cn(
          'text-4xl transition duration-300',
          unlocked
            ? 'animate-in zoom-in-75'
            : 'grayscale opacity-70',
        )}
        role="img"
        aria-label={definition.name}
      >
        {definition.icon}
      </div>

      <div className="text-center">
        <p className="text-sm font-semibold text-white">{definition.name}</p>
        <span
          className={cn(
            'mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide',
            rarity.label,
          )}
        >
          {definition.rarity}
        </span>
      </div>

      <div className="mt-1 w-full">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              unlocked ? 'bg-emerald-500' : 'bg-sky-500',
            )}
            style={{ width: `${percent}%` }}
            data-testid={`badge-progress-${definition.id}`}
          />
        </div>
        <p className="mt-1 text-center text-[10px] text-zinc-400">
          {unlocked ? 'Complete' : `${percent}%`}
        </p>
      </div>
    </div>
  );
}

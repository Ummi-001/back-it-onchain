'use client';

import React, { useMemo, useState } from 'react';
import { cn } from '../../lib/utils';
import { BadgeRarity, buildBadgeStates } from '../lib/badge-defs';
import { BadgeCard } from './BadgeCard';
import { BadgeUnlockModal } from './BadgeUnlockModal';

interface BadgeGalleryProps {
  progress: Record<string, number>;
  title?: string;
  proofUrl?: (badgeId: string) => string | undefined;
  onShare?: (network: 'x' | 'farcaster', badgeId: string) => void;
}

const FILTERS: Array<{ value: BadgeRarity | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'common', label: 'Common' },
  { value: 'rare', label: 'Rare' },
  { value: 'epic', label: 'Epic' },
  { value: 'legendary', label: 'Legendary' },
];

/**
 * Gallery of achievement badges with a rarity filter. Shows unlocked and
 * in-progress badges with progress bars, tooltips, and unlock animations.
 */
export function BadgeGallery({ progress, title = 'Achievements', proofUrl, onShare }: BadgeGalleryProps) {
  const [rarity, setRarity] = useState<BadgeRarity | 'all'>('all');
  const [selected, setSelected] = useState<ReturnType<typeof buildBadgeStates>[number] | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const states = useMemo(
    () => buildBadgeStates(progress, rarity),
    [progress, rarity],
  );
  const unlockedCount = useMemo(
    () => buildBadgeStates(progress).filter((s) => s.unlocked).length,
    [progress],
  );
  const total = useMemo(() => buildBadgeStates(progress).length, [progress]);

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <p className="text-xs text-zinc-400">
            {unlockedCount} of {total} unlocked
          </p>
        </div>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Rarity filter">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={rarity === f.value}
              onClick={() => setRarity(f.value)}
              className={cn(
                'rounded-full px-3 py-1 text-xs transition',
                rarity === f.value
                  ? 'bg-white text-black'
                  : 'bg-white/5 text-zinc-300 hover:bg-white/10',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      {states.length === 0 ? (
        <p className="rounded-lg border border-white/10 bg-zinc-900/40 p-6 text-center text-sm text-zinc-400">
          No badges in this category yet.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {states.map((state) => (
            <BadgeCard key={state.definition.id} state={state} onSelect={setSelected} />
          ))}
        </div>
      )}
      <BadgeUnlockModal
        badge={selected}
        open={Boolean(selected)}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        proofUrl={selected ? proofUrl?.(selected.definition.id) : undefined}
        soundEnabled={soundEnabled}
        onToggleSound={() => setSoundEnabled((value) => !value)}
        onShare={(network) => { if (selected) onShare?.(network, selected.definition.id); }}
      />
    </section>
  );
}

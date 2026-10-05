'use client';

import * as React from 'react';
import { ExternalLink, Share2, Volume2, VolumeX, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import type { BadgeState } from '@/src/lib/badge-defs';

export interface BadgeUnlockModalProps {
  badge: BadgeState | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proofUrl?: string;
  soundEnabled?: boolean;
  onToggleSound?: () => void;
  onShare?: (network: 'x' | 'farcaster') => void;
}

export function BadgeUnlockModal({ badge, open, onOpenChange, proofUrl, soundEnabled = true, onToggleSound, onShare }: BadgeUnlockModalProps) {
  if (!badge) return null;
  const shareText = `I unlocked ${badge.definition.name} on Back It Onchain`;
  const share = (network: 'x' | 'farcaster') => {
    const url = network === 'x' ? 'https://twitter.com/intent/tweet' : 'https://warpcast.com/~/compose';
    const target = `${url}?text=${encodeURIComponent(shareText)}`;
    window.open(target, '_blank', 'noopener,noreferrer');
    onShare?.(network);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-2xl">
          <Dialog.Title className="sr-only">Badge unlocked</Dialog.Title>
          <Dialog.Description className="sr-only">Celebrate and share your new achievement.</Dialog.Description>
          <button type="button" aria-label="Close badge celebration" onClick={() => onOpenChange(false)} className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:bg-secondary"><X className="h-4 w-4" /></button>
          <div className="pointer-events-none absolute inset-0" aria-hidden="true">
            {Array.from({ length: 18 }, (_, index) => <span key={index} className="absolute h-2 w-2 rounded-full" style={{ left: `${(index * 37) % 100}%`, top: `${(index * 53) % 80}%`, backgroundColor: ['#f59e0b', '#38bdf8', '#a855f7', '#22c55e'][index % 4], transform: `rotate(${index * 23}deg)` }} />)}
          </div>
          <div className="relative text-center">
            <div className="mx-auto flex h-28 w-28 items-center justify-center rounded-full border-4 border-amber-300 bg-gradient-to-br from-amber-400/30 to-purple-500/30 text-6xl shadow-[0_0_40px_rgba(245,158,11,0.35)]">{badge.definition.icon}</div>
            <p className="mt-5 text-xs uppercase tracking-widest text-amber-400">Badge unlocked</p>
            <h2 className="mt-1 text-2xl font-bold">{badge.definition.name}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{badge.definition.description}</p>
            <p className="mt-3 text-xs text-muted-foreground">{badge.definition.threshold} {badge.definition.metric} completed</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => share('x')} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary"><Share2 className="h-4 w-4" /> Share on X</button>
              <button type="button" onClick={() => share('farcaster')} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary">Share on Farcaster</button>
              {proofUrl ? <a href={proofUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary">View proof <ExternalLink className="h-4 w-4" /></a> : null}
            </div>
            <button type="button" onClick={onToggleSound} className="mx-auto mt-4 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">{soundEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />} {soundEnabled ? 'Sound on' : 'Sound off'}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default BadgeUnlockModal;

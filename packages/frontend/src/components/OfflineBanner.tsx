'use client';

import { Loader, RefreshCw, WifiOff } from 'lucide-react';
import { useOfflineQueue } from '@/src/hooks/useOfflineQueue';

export interface OfflineBannerProps {
  onSynced?: (count: number) => void;
}

export function OfflineBanner({ onSynced }: OfflineBannerProps) {
  const { offline, pending, isSyncing, retry } = useOfflineQueue(onSynced);
  if (!offline && pending === 0 && !isSyncing) return null;
  return (
    <div data-testid="offline-banner" className={`flex items-center justify-between border-b px-4 py-2 text-xs font-medium ${offline ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-blue-500/30 bg-blue-500/10 text-blue-500'}`}>
      <span className="inline-flex items-center gap-1"><WifiOff className="h-3.5 w-3.5" />{offline ? `You are offline${pending > 0 ? ` · ${pending} action${pending === 1 ? '' : 's'} queued` : ''}` : isSyncing ? `Syncing ${pending} queued action${pending === 1 ? '' : 's'}…` : `${pending} action${pending === 1 ? '' : 's'} waiting to sync`}</span>
      {!offline ? <button type="button" onClick={() => void retry()} disabled={isSyncing} className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 disabled:opacity-50">{isSyncing ? <Loader className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Retry</button> : <span className="rounded-full bg-destructive/20 px-2 py-0.5">Reconnect to sync</span>}
    </div>
  );
}

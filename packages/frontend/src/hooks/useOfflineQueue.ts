'use client';

import * as React from 'react';
import { isOffline, readDraftQueue, replayDraftQueue, type QueuedDraft } from '@/src/lib/pwa';

export function useOfflineQueue(onSync?: (count: number) => void, replay?: (entry: QueuedDraft) => Promise<void>) {
  const [offline, setOffline] = React.useState<boolean>(() => isOffline());
  const [pending, setPending] = React.useState(0);
  const [isSyncing, setIsSyncing] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setPending((await readDraftQueue()).length);
  }, []);

  const sync = React.useCallback(async () => {
    if (isOffline()) return;
    setIsSyncing(true);
    const result = await replayDraftQueue(replay);
    setPending(result.remaining);
    setIsSyncing(false);
    if (result.synced > 0) onSync?.(result.synced);
  }, [onSync, replay]);

  React.useEffect(() => {
    void refresh();
    const handleOnline = () => { setOffline(false); void sync(); };
    const handleOffline = () => { setOffline(true); void refresh(); };
    const handleMessage = (event: MessageEvent<{ type?: string }>) => { if (event.data?.type === 'offline-queue-updated') void refresh(); };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    navigator.serviceWorker?.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      navigator.serviceWorker?.removeEventListener('message', handleMessage);
    };
  }, [refresh, sync]);

  return { offline, pending, isSyncing, retry: sync };
}

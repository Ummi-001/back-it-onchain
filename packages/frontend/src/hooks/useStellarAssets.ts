'use client';

import * as React from 'react';
import { addMissingPopularAssets, fetchStellarAssets, type StellarAsset } from '@/src/lib/stellar-asset-manager';

export function useStellarAssets(publicKey?: string | null, horizonUrl?: string, enabled = true) {
  const [assets, setAssets] = React.useState<StellarAsset[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async (signal?: AbortSignal) => {
    if (!enabled || !publicKey || !horizonUrl) return;
    setLoading(true);
    setError(null);
    try {
      setAssets(addMissingPopularAssets(await fetchStellarAssets(publicKey, { horizonUrl, signal })));
    } catch (caught) {
      if (!signal?.aborted) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [enabled, horizonUrl, publicKey]);

  React.useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return { assets, loading, error, refresh: () => refresh() };
}

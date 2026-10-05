'use client';

import * as React from 'react';
import { buildBars } from '@/src/lib/analytics-utils';

export interface CreatorEarningsPoint {
  date: string;
  earnings: number;
  volume: number;
}

export interface CreatorEarningsData {
  totalVolume: number;
  feeEarnings: number;
  claimable: number;
  followerConversionRate: number;
  daily: CreatorEarningsPoint[];
  topCalls: Array<{ id: string; title: string; volume: number; earnings: number }>;
}

export function useCreatorEarnings(wallet?: string, initialData?: CreatorEarningsData) {
  const [data, setData] = React.useState<CreatorEarningsData | null>(initialData || null);
  const [loading, setLoading] = React.useState(!initialData);
  const [error, setError] = React.useState<Error | null>(null);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    if (!wallet) return;
    setLoading(true);
    setError(null);
    try {
      const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
      const response = await fetch(`${base}/analytics/creators/${encodeURIComponent(wallet)}/earnings`, { signal });
      if (!response.ok) throw new Error(`Creator earnings request failed (${response.status})`);
      setData(await response.json() as CreatorEarningsData);
    } catch (caught) {
      if (!signal?.aborted) setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [wallet]);

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return { data, loading, error, refresh: () => load() };
}

export function creatorEarningsBars(data: CreatorEarningsData, height: number) {
  return buildBars(data.daily.map((point) => ({ label: point.date, value: point.earnings })), height);
}

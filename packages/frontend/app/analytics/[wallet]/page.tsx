'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { useAnalytics } from '../../../src/hooks/useAnalytics';
import { ReputationRadar } from '../../../src/components/ReputationRadar';
import { AccuracyChart } from '../../../src/components/AccuracyChart';
import { StakingVolumeBars } from '../../../src/components/StakingVolumeBars';
import { CreatorEarningsDashboard } from '../../../src/components/CreatorEarningsDashboard';

/**
 * FE-23 — Analytics & Reputation Score Visualization.
 *
 * Note: the app router lives at the package-root `app/` directory, so the route
 * page is placed here (the reusable hooks/components sit under `src/` per the
 * issue's file requirements).
 */
export default function AnalyticsPage() {
  const params = useParams<{ wallet: string }>();
  const wallet = params?.wallet ?? '';
  const { data, loading } = useAnalytics(wallet);

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-white">Analytics</h1>
        <p className="truncate text-sm text-zinc-400">{wallet}</p>
      </header>

      {loading || !data ? (
        <div
          className="h-64 animate-pulse rounded-xl bg-zinc-900/60"
          data-testid="analytics-loading"
        />
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <section className="rounded-xl border border-white/10 bg-zinc-900/40 p-4">
            <h2 className="mb-3 text-sm font-semibold text-white">Reputation</h2>
            <div className="flex justify-center">
              <ReputationRadar axes={data.reputation} />
            </div>
          </section>

          <section className="rounded-xl border border-white/10 bg-zinc-900/40 p-4">
            <h2 className="mb-3 text-sm font-semibold text-white">
              Accuracy over time
            </h2>
            <AccuracyChart data={data.accuracy} pnlData={data.pnl} />
          </section>

          <section className="rounded-xl border border-white/10 bg-zinc-900/40 p-4 md:col-span-2">
            <h2 className="mb-3 text-sm font-semibold text-white">
              Staking volume
            </h2>
            <StakingVolumeBars data={data.stakingVolume} />
          </section>
        </div>
      )}
      <CreatorEarningsDashboard wallet={wallet} />
    </main>
  );
}

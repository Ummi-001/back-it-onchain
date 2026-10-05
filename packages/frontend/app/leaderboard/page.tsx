'use client';

import { useEffect, useMemo, useState } from 'react';
import { Trophy, TrendingUp, Target, Users } from 'lucide-react';
import { AppLayout } from '@/components/AppLayout';
import { useGlobalState } from '@/components/GlobalState';
import { LeaderboardTable } from '@/src/components/LeaderboardTable';
import { rankLeaderboard, type LeaderboardEntry, type LeaderboardPeriod } from '@/src/lib/leaderboard';

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
const PERIOD_OPTIONS: Array<{ label: string; value: LeaderboardPeriod }> = [{ label: '24h', value: '24h' }, { label: '7 days', value: '7d' }, { label: '30 days', value: '30d' }, { label: 'All time', value: 'all' }];

function apiPeriod(period: LeaderboardPeriod): string {
  if (period === '7d') return 'weekly';
  if (period === '30d') return 'monthly';
  return 'all_time';
}

function formatWallet(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export default function LeaderboardPage() {
  const { currentUser } = useGlobalState();
  const [period, setPeriod] = useState<LeaderboardPeriod>('7d');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`${API_BASE_URL}/leaderboard?period=${apiPeriod(period)}&limit=100`);
        if (!response.ok) throw new Error('Failed to load leaderboard');
        const payload = await response.json() as LeaderboardEntry[] | { items?: LeaderboardEntry[] };
        if (!cancelled) setEntries(Array.isArray(payload) ? payload : payload.items || []);
      } catch {
        if (!cancelled) { setEntries([]); setError('Unable to load leaderboard right now.'); }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [period]);

  const ranked = useMemo(() => rankLeaderboard(entries), [entries]);
  const podium = ranked.slice(0, 3);
  const currentUserEntry = useMemo(() => ranked.find((entry) => entry.userId.toLowerCase() === currentUser?.wallet?.toLowerCase()), [currentUser?.wallet, ranked]);

  const rightSidebar = <div className="space-y-4"><div className="rounded-xl border border-border bg-secondary/20 p-6"><h3 className="flex items-center gap-2 text-lg font-bold"><Trophy className="h-5 w-5 text-primary" /> Top predictors</h3><p className="mt-2 text-sm text-muted-foreground">Rankings combine calibration, net profit, and stake volume.</p></div><div className="space-y-3 rounded-xl border border-border bg-secondary/20 p-6 text-sm text-muted-foreground"><p className="flex items-center gap-2"><Users className="h-4 w-4" /> Active users ranked</p><p className="flex items-center gap-2"><Target className="h-4 w-4" /> Brier calibration weighted</p><p className="flex items-center gap-2"><TrendingUp className="h-4 w-4" /> Profit and activity</p></div></div>;

  return <AppLayout rightSidebar={rightSidebar}><div className="space-y-4 p-4"><div className="flex items-center justify-between px-2"><h1 className="flex items-center gap-2 text-2xl font-bold"><Trophy className="h-6 w-6 text-primary" /> Leaderboard</h1></div><div className="flex gap-3 border-b border-border px-2">{PERIOD_OPTIONS.map((option) => <button key={option.value} type="button" onClick={() => setPeriod(option.value)} className={`pb-3 border-b-2 font-bold transition-colors ${period === option.value ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{option.label}</button>)}</div>{isLoading ? <div className="py-12 text-center text-muted-foreground">Loading leaderboard…</div> : error ? <div className="rounded-xl border border-border bg-secondary/20 p-6 text-sm text-muted-foreground">{error}</div> : entries.length === 0 ? <div className="rounded-xl border border-dashed border-border bg-secondary/10 p-10 text-center text-muted-foreground">No leaderboard data available for this period.</div> : <>{podium.length >= 3 ? <div className="flex items-end justify-center gap-4 py-6">{[1, 0, 2].map((index) => { const entry = podium[index]; if (!entry) return null; const heights = ['h-32', 'h-24', 'h-20']; return <div key={entry.userId} className="flex flex-col items-center gap-2"><div className="text-2xl">{['🥇', '🥈', '🥉'][index]}</div><div className="text-center text-sm font-bold">{formatWallet(entry.userId)}</div><div className="text-xs text-muted-foreground">{entry.winRate.toFixed(1)}%</div><div className={`flex w-20 items-center justify-center rounded-t-lg border border-primary/20 bg-gradient-to-t from-primary/20 to-primary/5 ${heights[index]}`}><span className="text-lg font-bold">#{index + 1}</span></div></div>; })}</div> : null}<LeaderboardTable entries={entries} currentWallet={currentUser?.wallet} />{currentUserEntry && currentUserEntry.rank && currentUserEntry.rank > 10 ? <div className="rounded-xl border border-primary/30 bg-primary/10 p-4 text-sm">Your current rank: <strong>#{currentUserEntry.rank}</strong></div> : null}</>}</div></AppLayout>;
}

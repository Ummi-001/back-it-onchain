'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { FollowButton } from '@/src/components/follow/FollowButton';
import { rankLeaderboard, sortLeaderboard, type LeaderboardEntry, type LeaderboardSort } from '@/src/lib/leaderboard';
import { cn } from '@/lib/utils';

export interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  currentWallet?: string;
  pageSize?: number;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function LeaderboardTable({ entries, currentWallet, pageSize = 20 }: LeaderboardTableProps) {
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<LeaderboardSort>('rank');
  const [direction, setDirection] = React.useState<'asc' | 'desc'>('asc');
  const [page, setPage] = React.useState(1);
  const ranked = React.useMemo(() => rankLeaderboard(entries), [entries]);
  const filtered = React.useMemo(() => ranked.filter((entry) => `${entry.username || ''} ${entry.userId} ${entry.category || ''}`.toLowerCase().includes(query.toLowerCase())), [query, ranked]);
  const sorted = React.useMemo(() => sortLeaderboard(filtered, sort, direction), [direction, filtered, sort]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const visible = sorted.slice((Math.min(page, pageCount) - 1) * pageSize, Math.min(page, pageCount) * pageSize);
  const setSortColumn = (column: LeaderboardSort) => { if (sort === column) setDirection((value) => value === 'asc' ? 'desc' : 'asc'); else { setSort(column); setDirection(column === 'rank' ? 'asc' : 'desc'); } setPage(1); };
  const ariaSort = (column: LeaderboardSort) => sort === column ? (direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <section className="space-y-3" data-testid="leaderboard-table">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"><Search className="h-4 w-4 text-muted-foreground" /><label htmlFor="leaderboard-search" className="sr-only">Search leaderboard</label><input id="leaderboard-search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search username or wallet" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></div>
      <div className="overflow-x-auto rounded-2xl border border-border bg-card"><table className="w-full min-w-[760px] text-left text-sm"><caption className="sr-only">Weighted Brier score and profitability leaderboard</caption><thead className="border-b border-border bg-secondary/20 text-xs uppercase tracking-wide text-muted-foreground"><tr><th scope="col" aria-sort={ariaSort('rank')} className="p-3"><button type="button" onClick={() => setSortColumn('rank')} className="inline-flex items-center gap-1">Rank {sort === 'rank' ? direction === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : null}</button></th><th scope="col" className="p-3">Predictor</th><th scope="col" aria-sort={ariaSort('winRate')} className="p-3 text-right"><button type="button" onClick={() => setSortColumn('winRate')} className="inline-flex items-center gap-1">Win rate {sort === 'winRate' ? direction === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : null}</button></th><th scope="col" aria-sort={ariaSort('brierScore')} className="p-3 text-right"><button type="button" onClick={() => setSortColumn('brierScore')} className="inline-flex items-center gap-1">Brier {sort === 'brierScore' ? direction === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : null}</button></th><th scope="col" aria-sort={ariaSort('profit')} className="p-3 text-right"><button type="button" onClick={() => setSortColumn('profit')} className="inline-flex items-center gap-1">Profit {sort === 'profit' ? direction === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : null}</button></th><th scope="col" className="p-3 text-right">Score</th><th scope="col" className="p-3 text-right">Follow</th></tr></thead><tbody>{visible.map((entry) => { const own = currentWallet?.toLowerCase() === entry.userId.toLowerCase(); return <tr key={entry.userId} className={cn('border-b border-border/60', own && 'bg-primary/10')}><td className="p-3 font-bold">#{entry.rank}</td><td className="p-3"><p className="font-medium">{entry.username || `${entry.userId.slice(0, 6)}…${entry.userId.slice(-4)}`}</p><p className="text-xs text-muted-foreground">{entry.category || 'All markets'}</p></td><td className="p-3 text-right tabular-nums">{percent(entry.winRate)}</td><td className="p-3 text-right tabular-nums">{(entry.brierScore ?? 0.5).toFixed(3)}</td><td className={cn('p-3 text-right tabular-nums', entry.profit >= 0 ? 'text-green-500' : 'text-red-500')}>{money(entry.profit)}</td><td className="p-3 text-right font-semibold">{(entry.score || 0).toFixed(1)}</td><td className="p-3 text-right">{own ? <span className="text-xs text-primary">You</span> : <FollowButton profileAddress={entry.userId} viewerAddress={currentWallet} />}</td></tr>; })}</tbody></table></div>
      {pageCount > 1 ? <div className="flex items-center justify-center gap-3 text-sm"><button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded border border-border px-3 py-1 disabled:opacity-40">Previous</button><span>Page {Math.min(page, pageCount)} of {pageCount}</span><button type="button" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} className="rounded border border-border px-3 py-1 disabled:opacity-40">Next</button></div> : null}
    </section>
  );
}

export default LeaderboardTable;

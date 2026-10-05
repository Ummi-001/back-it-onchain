'use client';

import * as React from 'react';
import { Award, CircleDollarSign, Loader, TrendingUp, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PortfolioPositionStatus = 'active' | 'won' | 'lost' | 'disputed' | 'claimable';

export interface PortfolioPosition {
  id: string;
  callId: string;
  title: string;
  chain: 'base' | 'stellar';
  side: 'yes' | 'no';
  amount: number;
  currentValue?: number;
  payout?: number;
  status: PortfolioPositionStatus;
  claimTxHash?: string;
}

export interface PortfolioSummaryProps {
  positions: PortfolioPosition[];
  onClaimAll?: (positions: PortfolioPosition[]) => Promise<void> | void;
  onClaim?: (position: PortfolioPosition) => Promise<void> | void;
  className?: string;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

export function PortfolioSummary({ positions, onClaimAll, onClaim, className }: PortfolioSummaryProps) {
  const [filter, setFilter] = React.useState<'all' | 'base' | 'stellar'>('all');
  const [claiming, setClaiming] = React.useState<string | null>(null);
  const filtered = positions.filter((position) => filter === 'all' || position.chain === filter);
  const activeValue = positions.filter((position) => position.status === 'active').reduce((total, position) => total + (position.currentValue ?? position.amount), 0);
  const claimable = positions.filter((position) => position.status === 'claimable').reduce((total, position) => total + (position.payout ?? 0), 0);
  const realized = positions.reduce((total, position) => total + (position.status === 'active' ? 0 : (position.payout ?? 0) - position.amount), 0);
  const claimAll = async () => { if (!onClaimAll) return; setClaiming('all'); try { await onClaimAll(positions.filter((position) => position.status === 'claimable')); } finally { setClaiming(null); } };
  const claim = async (position: PortfolioPosition) => { if (!onClaim) return; setClaiming(position.id); try { await onClaim(position); } finally { setClaiming(null); } };

  return <section className={cn('space-y-4', className)} data-testid="portfolio-summary"><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-border bg-card p-4"><p className="flex items-center gap-1 text-xs text-muted-foreground"><Wallet className="h-3.5 w-3.5" /> Active value</p><p className="mt-1 text-xl font-bold">{money(activeValue)}</p></div><div className="rounded-xl border border-border bg-card p-4"><p className="flex items-center gap-1 text-xs text-muted-foreground"><CircleDollarSign className="h-3.5 w-3.5" /> Claimable</p><p className="mt-1 text-xl font-bold text-green-500">{money(claimable)}</p></div><div className="rounded-xl border border-border bg-card p-4"><p className="flex items-center gap-1 text-xs text-muted-foreground"><TrendingUp className="h-3.5 w-3.5" /> Realized PnL</p><p className={cn('mt-1 text-xl font-bold', realized >= 0 ? 'text-green-500' : 'text-red-500')}>{realized >= 0 ? '+' : ''}{money(realized)}</p></div></div><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex gap-1 rounded-lg border border-border bg-card p-1">{(['all', 'base', 'stellar'] as const).map((value) => <button key={value} type="button" onClick={() => setFilter(value)} className={cn('rounded-md px-3 py-1.5 text-xs capitalize', filter === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary')}>{value === 'all' ? 'All chains' : value}</button>)}</div>{onClaimAll && claimable > 0 ? <button type="button" onClick={() => void claimAll()} disabled={claiming === 'all'} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{claiming === 'all' ? <Loader className="h-4 w-4 animate-spin" /> : <Award className="h-4 w-4" />} Claim all</button> : null}</div><div className="space-y-2">{filtered.length === 0 ? <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No positions match this filter.</div> : filtered.map((position) => <article key={position.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"><div className="min-w-0"><p className="truncate text-sm font-semibold">{position.title}</p><p className="mt-1 text-xs text-muted-foreground"><span className={position.side === 'yes' ? 'text-green-500' : 'text-red-500'}>{position.side.toUpperCase()}</span> · {position.chain} · {position.status}</p></div><div className="flex items-center gap-4"><div className="text-right"><p className="font-mono text-sm">{money(position.currentValue ?? position.amount)}</p>{position.payout !== undefined ? <p className="text-xs text-muted-foreground">Payout {money(position.payout)}</p> : null}</div>{position.status === 'claimable' && onClaim ? <button type="button" onClick={() => void claim(position)} disabled={claiming === position.id} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-secondary disabled:opacity-50">{claiming === position.id ? 'Claiming…' : 'Claim'}</button> : null}</div></article>)}</div></section>;
}

export default PortfolioSummary;

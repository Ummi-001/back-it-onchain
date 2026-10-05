'use client';

import * as React from 'react';
import { BarChart3, CheckCircle2, CircleDollarSign, Loader, Users } from 'lucide-react';
import { toast } from 'sonner';
import { creatorEarningsBars, useCreatorEarnings, type CreatorEarningsData } from '@/src/hooks/useCreatorEarnings';
import { cn } from '@/lib/utils';

export interface CreatorEarningsDashboardProps {
  wallet?: string;
  initialData?: CreatorEarningsData;
  onClaim?: (amount: number) => Promise<string | void>;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

export function CreatorEarningsDashboard({ wallet, initialData, onClaim }: CreatorEarningsDashboardProps) {
  const { data, loading, error, refresh } = useCreatorEarnings(wallet, initialData);
  const [claiming, setClaiming] = React.useState(false);
  const bars = data ? creatorEarningsBars(data, 140) : [];
  const claim = async () => {
    if (!data?.claimable || !onClaim) return;
    setClaiming(true);
    try { const hash = await onClaim(data.claimable); toast.success(hash ? `Claim submitted: ${hash}` : 'Claim submitted.'); await refresh(); } catch (caught) { toast.error(caught instanceof Error ? caught.message : 'Claim failed.'); } finally { setClaiming(false); }
  };

  if (loading) return <div className="flex h-48 items-center justify-center rounded-xl border border-border bg-card text-sm text-muted-foreground"><Loader className="mr-2 h-4 w-4 animate-spin" />Loading creator earnings…</div>;
  if (error || !data) return <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500" role="alert">{error?.message || 'Creator earnings are unavailable.'}<button type="button" onClick={() => void refresh()} className="ml-2 underline">Retry</button></div>;

  return <section className="space-y-4 rounded-xl border border-border bg-card p-4" data-testid="creator-earnings-dashboard"><div className="flex items-center justify-between"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><BarChart3 className="h-5 w-5 text-primary" /> Creator earnings</h2><p className="text-xs text-muted-foreground">Protocol fees and creator rewards</p></div>{onClaim && data.claimable > 0 ? <button type="button" onClick={() => void claim()} disabled={claiming} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{claiming ? <Loader className="h-4 w-4 animate-spin" /> : <CircleDollarSign className="h-4 w-4" />} Claim {money(data.claimable)}</button> : null}</div><div className="grid gap-3 sm:grid-cols-4"><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Total volume</p><p className="text-lg font-bold">{money(data.totalVolume)}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Fee earnings</p><p className="text-lg font-bold text-green-500">{money(data.feeEarnings)}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Claimable</p><p className="text-lg font-bold">{money(data.claimable)}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Follower conversion</p><p className="text-lg font-bold">{(data.followerConversionRate * 100).toFixed(1)}%</p></div></div><div className="rounded-lg border border-border p-3"><div className="mb-2 flex items-center justify-between text-xs text-muted-foreground"><span>Daily earnings</span><span>{money(data.feeEarnings)} total</span></div><div className="flex h-40 items-end gap-1">{bars.map((bar) => <div key={bar.label} className="group flex h-full flex-1 flex-col justify-end"><div className={cn('min-h-1 rounded-t bg-emerald-500/70 transition-all group-hover:bg-emerald-400', bar.value === 0 && 'bg-secondary')} style={{ height: bar.height }} title={`${bar.label}: ${money(bar.value)}`} /><span className="mt-1 truncate text-[9px] text-muted-foreground">{bar.label}</span></div>)}</div></div><div><h3 className="mb-2 text-sm font-semibold">Top-performing calls</h3><div className="space-y-2">{data.topCalls.map((call) => <div key={call.id} className="flex items-center justify-between rounded-lg border border-border p-3 text-sm"><div className="min-w-0"><p className="truncate font-medium">{call.title}</p><p className="text-xs text-muted-foreground">Users <Users className="mr-1 inline h-3 w-3" />{call.volume.toLocaleString()}</p></div><span className="font-semibold text-green-500">{money(call.earnings)}</span></div>)}</div></div>{claiming ? <p className="flex items-center gap-1 text-xs text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5" /> Waiting for on-chain confirmation…</p> : null}</section>;
}

export default CreatorEarningsDashboard;

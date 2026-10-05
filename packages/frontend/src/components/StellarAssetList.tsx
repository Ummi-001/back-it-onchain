'use client';

import * as React from 'react';
import { Check, CircleDollarSign, Loader, RefreshCw, ShieldCheck } from 'lucide-react';
import { buildChangeTrustRequests, formatStellarBalance, type StellarAsset } from '@/src/lib/stellar-asset-manager';
import { cn } from '@/lib/utils';

export interface StellarAssetListProps {
  assets: StellarAsset[];
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  onAddAssets?: (requests: ReturnType<typeof buildChangeTrustRequests>) => Promise<void> | void;
}

export function StellarAssetList({ assets, loading, error, onRefresh, onAddAssets }: StellarAssetListProps) {
  const [isAdding, setIsAdding] = React.useState(false);
  const pending = assets.filter((asset) => asset.trustline && asset.balance === '0');
  const add = async () => {
    if (!onAddAssets || pending.length === 0) return;
    setIsAdding(true);
    try { await onAddAssets(buildChangeTrustRequests(pending)); } finally { setIsAdding(false); }
  };

  if (loading) return <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader className="h-4 w-4 animate-spin" /> Loading Stellar assets…</div>;
  if (error) return <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500" role="alert">{error}</p>;

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" data-testid="stellar-asset-list">
      <div className="flex items-center justify-between"><div className="flex items-center gap-2"><CircleDollarSign className="h-5 w-5 text-primary" /><h2 className="font-semibold">Stellar assets</h2></div>{onRefresh ? <button type="button" onClick={onRefresh} aria-label="Refresh Stellar assets" className="rounded p-1.5 text-muted-foreground hover:bg-secondary"><RefreshCw className="h-4 w-4" /></button> : null}</div>
      <div className="space-y-2">{assets.map((asset) => <div key={`${asset.code}:${asset.issuer}`} className="flex items-center justify-between rounded-lg border border-border p-3"><div className="min-w-0"><p className="text-sm font-medium">{asset.code} {asset.popular ? <span className="ml-1 rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] text-green-500">Popular</span> : null}</p><p className="truncate text-xs text-muted-foreground">{asset.issuerName || (asset.issuer ? `${asset.issuer.slice(0, 8)}…` : 'Native asset')}</p></div><div className="text-right"><p className="font-mono text-sm">{formatStellarBalance(asset)}</p><p className={cn('text-[10px]', asset.trustline ? 'text-green-500' : 'text-amber-500')}>{asset.trustline ? 'Trusted' : 'No trustline'}</p></div></div>)}</div>
      {pending.length > 0 && onAddAssets ? <button type="button" onClick={() => void add()} disabled={isAdding} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{isAdding ? <Loader className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Add {pending.length} trustline{pending.length === 1 ? '' : 's'}</button> : null}
      {assets.length > 0 ? <p className="flex items-center gap-1 text-[11px] text-muted-foreground"><Check className="h-3 w-3" /> Balances are read from Horizon; trustline changes still require wallet approval.</p> : <p className="text-sm text-muted-foreground">No account balances found.</p>}
    </section>
  );
}

export default StellarAssetList;

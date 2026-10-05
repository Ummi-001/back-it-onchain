'use client';

import * as React from 'react';
import { CheckCircle2, CircleAlert, ExternalLink, Loader, PartyPopper, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface BulkClaimPosition {
  id: string;
  title: string;
  amount: number;
  chain: 'base' | 'stellar';
  txHash?: string;
}

export interface BulkClaimWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  positions: BulkClaimPosition[];
  onClaim: (position: BulkClaimPosition) => Promise<{ txHash: string }>;
  explorerUrl?: (txHash: string, chain: 'base' | 'stellar') => string;
}

type ClaimState = 'idle' | 'processing' | 'confirmed' | 'failed';

export function BulkClaimWizard({ open, onOpenChange, positions, onClaim, explorerUrl }: BulkClaimWizardProps) {
  const [state, setState] = React.useState<ClaimState>('idle');
  const [currentIndex, setCurrentIndex] = React.useState(-1);
  const [results, setResults] = React.useState<Record<string, { state: ClaimState; txHash?: string; error?: string }>>({});
  const pending = positions.filter((position) => !results[position.id]?.state || results[position.id]?.state === 'failed');
  const completed = Object.values(results).filter((result) => result.state === 'confirmed').length;
  const failed = Object.values(results).filter((result) => result.state === 'failed').length;
  const close = () => { if (state !== 'processing') { setState('idle'); setCurrentIndex(-1); setResults({}); onOpenChange(false); } };
  const run = async () => {
    setState('processing');
    setResults({});
    for (let index = 0; index < positions.length; index += 1) {
      const position = positions[index];
      setCurrentIndex(index);
      try {
        const result = await onClaim(position);
        setResults((current) => ({ ...current, [position.id]: { state: 'confirmed', txHash: result.txHash } }));
      } catch (caught) {
        setResults((current) => ({ ...current, [position.id]: { state: 'failed', error: caught instanceof Error ? caught.message : String(caught) } }));
      }
    }
    setCurrentIndex(-1);
    setState('idle');
  };
  if (!open) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="bulk-claim-title"><div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl"><header className="flex items-start justify-between gap-3"><div><h2 id="bulk-claim-title" className="text-xl font-bold">Claim winnings</h2><p className="text-sm text-muted-foreground">Claims run sequentially so account sequence numbers remain safe.</p></div><button type="button" onClick={close} disabled={state === 'processing'} aria-label="Close claim wizard" className="rounded p-1 hover:bg-secondary disabled:opacity-50"><X className="h-5 w-5" /></button></header><div className="mt-4 space-y-2">{positions.map((position, index) => { const result = results[position.id]; const active = currentIndex === index; return <div key={position.id} className={cn('flex items-center gap-3 rounded-lg border p-3', result?.state === 'confirmed' ? 'border-green-500/30 bg-green-500/5' : result?.state === 'failed' ? 'border-red-500/30 bg-red-500/5' : 'border-border')}><div className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-xs font-bold">{result?.state === 'confirmed' ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : result?.state === 'failed' ? <CircleAlert className="h-4 w-4 text-red-500" /> : active ? <Loader className="h-4 w-4 animate-spin" /> : index + 1}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{position.title}</p><p className="text-xs text-muted-foreground">{position.chain} · {position.amount.toFixed(2)} USDC</p>{result?.error ? <p className="mt-1 text-xs text-red-500">{result.error}</p> : null}</div>{result?.txHash ? <a href={explorerUrl?.(result.txHash, position.chain) || '#'} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary">View <ExternalLink className="h-3 w-3" /></a> : null}</div>; })}</div>{completed > 0 && failed === 0 ? <div className="mt-4 flex items-center gap-2 rounded-lg bg-green-500/10 p-3 text-sm text-green-500"><PartyPopper className="h-4 w-4" />All {completed} claims confirmed.</div> : null}{failed > 0 ? <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-500"><CircleAlert className="h-4 w-4" />{failed} claim{failed === 1 ? '' : 's'} need attention.</div> : null}<div className="mt-5 flex justify-end gap-2"><button type="button" onClick={close} disabled={state === 'processing'} className="rounded-lg border border-border px-4 py-2 text-sm">Close</button><button type="button" onClick={() => void run()} disabled={state === 'processing' || positions.length === 0} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{state === 'processing' ? <Loader className="h-4 w-4 animate-spin" /> : null}{failed > 0 ? `Retry ${pending.length} failed` : `Claim ${positions.length} positions`}</button></div></div></div>;
}

export default BulkClaimWizard;

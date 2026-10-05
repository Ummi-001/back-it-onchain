'use client';

import * as React from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, Loader, X } from 'lucide-react';
import { StrKey } from '@stellar/stellar-sdk';
import * as Dialog from '@radix-ui/react-dialog';

export type BridgeChain = 'base' | 'ethereum' | 'stellar';

export interface BridgeRoute {
  id: string;
  name: string;
  source: BridgeChain;
  destination: BridgeChain;
  asset: string;
  estimatedMinutes: number;
  feeUsd: number;
  provider: string;
  providerUrl: string;
  verified: boolean;
}

export const BRIDGE_ROUTES: BridgeRoute[] = [
  { id: 'stellar-sep24', name: 'Stellar SEP-24 anchor', source: 'base', destination: 'stellar', asset: 'USDC', estimatedMinutes: 10, feeUsd: 1.5, provider: 'Stellar anchor', providerUrl: 'https://stellar.org/ecosystem/anchors', verified: true },
  { id: 'stellar-sep31', name: 'Stellar SEP-31 anchor', source: 'stellar', destination: 'base', asset: 'USDC', estimatedMinutes: 15, feeUsd: 2, provider: 'Stellar anchor', providerUrl: 'https://stellar.org/ecosystem/anchors', verified: true },
  { id: 'allbridge', name: 'Allbridge route', source: 'ethereum', destination: 'stellar', asset: 'USDC', estimatedMinutes: 20, feeUsd: 3, provider: 'Allbridge', providerUrl: 'https://allbridge.io', verified: true },
];

export interface AssetBridgeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart?: (route: BridgeRoute, destination: string) => Promise<void> | void;
}

export function AssetBridgeModal({ open, onOpenChange, onStart }: AssetBridgeModalProps) {
  const [routeId, setRouteId] = React.useState(BRIDGE_ROUTES[0].id);
  const [destination, setDestination] = React.useState('');
  const [step, setStep] = React.useState<'select' | 'review' | 'submitted'>('select');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const route = BRIDGE_ROUTES.find((candidate) => candidate.id === routeId) || BRIDGE_ROUTES[0];
  const validDestination = StrKey.isValidEd25519PublicKey(destination.trim());
  const close = () => { setStep('select'); setError(null); onOpenChange(false); };
  const submit = async () => {
    if (!validDestination) { setError('Enter a valid Stellar destination address.'); return; }
    setIsSubmitting(true);
    setError(null);
    try { await onStart?.(route, destination.trim()); setStep('submitted'); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setIsSubmitting(false); }
  };

  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl"><Dialog.Title className="text-xl font-bold">Bridge assets to Stellar</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">Compare verified routes and track each transfer step.</Dialog.Description><button type="button" onClick={close} aria-label="Close bridge modal" className="absolute right-3 top-3 rounded p-1 hover:bg-secondary"><X className="h-5 w-5" /></button>{step === 'submitted' ? <div className="py-10 text-center"><CheckCircle2 className="mx-auto h-12 w-12 text-green-500" /><h3 className="mt-4 font-semibold">Transfer intent created</h3><p className="mt-1 text-sm text-muted-foreground">The bridge provider will continue the transfer. Keep this window open to track status.</p><button type="button" onClick={close} className="mt-6 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Done</button></div> : <><div className="mt-5 space-y-2">{BRIDGE_ROUTES.map((candidate) => <button key={candidate.id} type="button" onClick={() => setRouteId(candidate.id)} className={`flex w-full items-center justify-between rounded-xl border p-3 text-left ${routeId === candidate.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary'}`}><span><span className="flex items-center gap-2 text-sm font-semibold">{candidate.name} {candidate.verified ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : null}</span><span className="mt-1 block text-xs text-muted-foreground">{candidate.source} → {candidate.destination} · {candidate.asset} · {candidate.estimatedMinutes} min · ${candidate.feeUsd.toFixed(2)}</span></span><ArrowRight className="h-4 w-4 text-muted-foreground" /></button>)}</div><label className="mt-5 block text-sm font-medium">Stellar destination <input value={destination} onChange={(event) => { setDestination(event.target.value); setError(null); }} placeholder="G..." className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-primary" aria-invalid={destination.length > 0 && !validDestination} /></label>{destination.length > 0 && !validDestination ? <p className="mt-1 text-xs text-red-500">Stellar public keys start with G and contain 56 characters.</p> : null}{error ? <p className="mt-2 flex items-center gap-1 text-xs text-red-500" role="alert"><AlertTriangle className="h-3.5 w-3.5" />{error}</p> : null}<div className="mt-5 flex items-center justify-between rounded-lg bg-secondary/50 p-3 text-xs"><span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-green-500" />Verified provider</span><a href={route.providerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary">Provider details <ExternalLink className="h-3 w-3" /></a></div><p className="mt-3 text-[11px] text-muted-foreground">Third-party bridges have independent risk. Verify the destination and provider before signing.</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={close} className="rounded-lg border border-border px-4 py-2 text-sm">Cancel</button><button type="button" onClick={() => void submit()} disabled={isSubmitting || !validDestination} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{isSubmitting ? <Loader className="h-4 w-4 animate-spin" /> : null}Create transfer intent</button></div></>}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export default AssetBridgeModal;

'use client';

import * as React from 'react';
import { requestSponsoredEnvelope, signSponsoredEnvelope, type SponsoredTransactionResult } from '@/src/lib/stellar-fee-bump';
import type { Transaction } from '@stellar/stellar-sdk';

export function useSponsoredStellarTransaction() {
  const [status, setStatus] = React.useState<'idle' | 'requesting' | 'signing' | 'success' | 'error'>('idle');
  const [result, setResult] = React.useState<SponsoredTransactionResult | null>(null);
  const [error, setError] = React.useState<Error | null>(null);

  const submit = async (transaction: Transaction, signer: { signEnvelopeXdr: (xdr: string) => Promise<string> }, options: { networkPassphrase: string; endpoint?: string; signal?: AbortSignal }) => {
    setStatus('requesting');
    setError(null);
    try {
      setStatus('signing');
      const next = await signSponsoredEnvelope(transaction, signer, options);
      setResult(next);
      setStatus('success');
      return next;
    } catch (caught) {
      const next = caught instanceof Error ? caught : new Error(String(caught));
      setError(next);
      setStatus('error');
      throw next;
    }
  };

  const request = async (transaction: Transaction, options: { networkPassphrase: string; endpoint?: string; signal?: AbortSignal }) => {
    setStatus('requesting');
    setError(null);
    try {
      return await requestSponsoredEnvelope(transaction, options);
    } catch (caught) {
      const next = caught instanceof Error ? caught : new Error(String(caught));
      setError(next);
      setStatus('error');
      throw next;
    }
  };

  return { status, result, error, submit, request, reset: () => { setStatus('idle'); setResult(null); setError(null); } };
}

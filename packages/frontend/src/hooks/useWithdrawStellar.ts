import { useCallback, useState } from 'react';
import { explorerTxUrl } from '../lib/payout-utils';
import type {
  UseWithdrawResult,
  WithdrawReceipt,
  WithdrawStatus,
} from './useWithdrawBase';

function mockStellarTxHash(): string {
  const hex = '0123456789abcdef';
  let h = '';
  for (let i = 0; i < 64; i++) h += hex[Math.floor(Math.random() * 16)];
  return h;
}

/**
 * Mock Stellar (Freighter) `withdrawPayout` hook. Mirrors {@link useWithdrawBase}
 * but produces a Stellar transaction hash and stellar.expert link. Frontend-only.
 */
export interface UseWithdrawStellarOptions {
  execute?: (amount: number) => Promise<{ txHash: string }>;
}

export function useWithdrawStellar(options: UseWithdrawStellarOptions = {}): UseWithdrawResult {
  const [status, setStatus] = useState<WithdrawStatus>('idle');
  const [receipt, setReceipt] = useState<WithdrawReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  const withdraw = useCallback(async (amount: number) => {
    setStatus('pending');
    setError(null);
    setReceipt(null);
    try {
      if (amount <= 0) {
        throw new Error('Nothing to claim');
      }
      const txHash = options.execute ? (await options.execute(amount)).txHash : mockStellarTxHash();
      const built: WithdrawReceipt = {
        txHash,
        explorerUrl: explorerTxUrl('stellar', txHash),
        amount,
        chain: 'stellar',
        at: Date.now(),
      };
      setReceipt(built);
      setStatus('success');
      return built;
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
      throw e;
    }
  }, [options.execute]);

  const reset = useCallback(() => {
    setStatus('idle');
    setReceipt(null);
    setError(null);
  }, []);

  return { status, receipt, error, withdraw, reset };
}

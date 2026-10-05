'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createOptimisticStake, waitForStakeConfirmation, type OptimisticStake, type OptimisticStakePatch, type TransactionConfirmation } from '@/src/lib/optimistic-reconciliation';

export interface UseOptimisticStakingOptions<T> {
  queryKey: readonly unknown[];
  updateCache: (stake: OptimisticStake, current: T | undefined) => T;
  submit: (stake: OptimisticStake) => Promise<{ txHash: string }>;
  waitForConfirmation?: (txHash: string) => Promise<TransactionConfirmation>;
  onConfirmed?: (stake: OptimisticStake) => void;
}

export function useOptimisticStaking<T>({ queryKey, updateCache, submit, waitForConfirmation, onConfirmed }: UseOptimisticStakingOptions<T>) {
  const queryClient = useQueryClient();
  const [stakes, setStakes] = React.useState<OptimisticStake[]>([]);
  const snapshots = React.useRef(new Map<string, T | undefined>());

  const patch = React.useCallback((id: string, value: OptimisticStakePatch) => {
    setStakes((current) => current.map((stake) => stake.id === id ? { ...stake, ...value } : stake));
  }, []);

  const stake = React.useCallback(async (input: Omit<OptimisticStake, 'id' | 'status' | 'createdAt'>) => {
    const optimistic = createOptimisticStake(input);
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData<T>(queryKey);
    snapshots.current.set(optimistic.id, previous);
    setStakes((current) => [...current, optimistic]);
    queryClient.setQueryData<T>(queryKey, updateCache(optimistic, previous));
    try {
      const submitted = await submit(optimistic);
      patch(optimistic.id, { txHash: submitted.txHash });
      const confirmation = waitForConfirmation ? await waitForConfirmation(submitted.txHash) : { status: 'confirmed' as const, txHash: submitted.txHash };
      patch(optimistic.id, confirmation.status === 'confirmed' ? { status: 'confirmed' } : { status: confirmation.status, error: confirmation.error });
      if (confirmation.status === 'confirmed') {
        onConfirmed?.({ ...optimistic, status: 'confirmed', txHash: submitted.txHash });
        toast.success('Stake confirmed.');
      } else {
        queryClient.setQueryData<T>(queryKey, snapshots.current.get(optimistic.id));
        toast.error(confirmation.error || 'Stake was not confirmed.');
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      patch(optimistic.id, { status: 'failed', error: message });
      queryClient.setQueryData<T>(queryKey, snapshots.current.get(optimistic.id));
      toast.error(message, { action: { label: 'Retry', onClick: () => { void stake(input); } } });
    } finally {
      snapshots.current.delete(optimistic.id);
    }
  }, [onConfirmed, patch, queryClient, queryKey, submit, updateCache, waitForConfirmation]);

  return { stakes, stake, patch };
}

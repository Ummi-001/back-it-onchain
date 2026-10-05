export type OptimisticStakeStatus = 'pending' | 'confirmed' | 'failed' | 'dropped';

export interface OptimisticStake {
  id: string;
  callId: string;
  side: 'yes' | 'no';
  amount: number;
  status: OptimisticStakeStatus;
  txHash?: string;
  error?: string;
  createdAt: number;
}

export interface OptimisticStakePatch {
  txHash?: string;
  status?: OptimisticStakeStatus;
  error?: string;
}

export function createOptimisticStake(input: Omit<OptimisticStake, 'id' | 'status' | 'createdAt'>): OptimisticStake {
  return { ...input, id: `stake-${crypto.randomUUID()}`, status: 'pending', createdAt: Date.now() };
}

export function reconcileOptimisticStake(stake: OptimisticStake, patch: OptimisticStakePatch): OptimisticStake {
  return { ...stake, ...patch };
}

export function isTerminalStakeStatus(status: OptimisticStakeStatus): boolean {
  return status === 'confirmed' || status === 'failed' || status === 'dropped';
}

export interface TransactionConfirmation {
  status: 'pending' | 'confirmed' | 'failed' | 'dropped';
  txHash?: string;
  error?: string;
}

export async function waitForStakeConfirmation(txHash: string, options: { poll?: () => Promise<TransactionConfirmation>; intervalMs?: number; timeoutMs?: number } = {}): Promise<TransactionConfirmation> {
  const poll = options.poll || (async () => ({ status: 'confirmed' as const, txHash }));
  const interval = options.intervalMs ?? 1_000;
  const timeout = options.timeoutMs ?? 120_000;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await poll();
    if (result.status !== 'pending') return { ...result, txHash: result.txHash || txHash };
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return { status: 'dropped', txHash, error: 'Transaction was not confirmed before the timeout' };
}

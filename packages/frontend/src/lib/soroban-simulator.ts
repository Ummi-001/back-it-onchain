import { Transaction } from '@stellar/stellar-sdk';

export interface SorobanSimulationResult {
  success: boolean;
  transactionXdr: string;
  resourceFeeStroops: number;
  resourceFeeXlm: number;
  cpuInstructions?: number;
  memoryBytes?: number;
  authRequired: boolean;
  errorCode?: string;
  errorMessage?: string;
  raw?: unknown;
}

export interface SimulationTransport {
  simulateTransaction(transaction: Transaction): Promise<unknown>;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function findError(payload: unknown): { code?: string; message?: string } | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'string') return { message: error };
  if (error && typeof error === 'object') {
    const details = error as Record<string, unknown>;
    return { code: typeof details.code === 'string' ? details.code : undefined, message: typeof details.message === 'string' ? details.message : undefined };
  }
  return typeof record.errorMessage === 'string' ? { message: record.errorMessage } : null;
}

export function parseSimulationResponse(payload: unknown, transaction: Transaction): SorobanSimulationResult {
  const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const error = findError(payload);
  const fee = numberValue(record.fee) ?? numberValue(record.resourceFee) ?? numberValue((record.result as Record<string, unknown> | undefined)?.fee) ?? 0;
  const auth = Array.isArray(record.auth) || Array.isArray((record.result as Record<string, unknown> | undefined)?.auth);
  return {
    success: !error,
    transactionXdr: transaction.toXDR(),
    resourceFeeStroops: fee,
    resourceFeeXlm: fee / 1_000_000,
    cpuInstructions: numberValue(record.cpuInsns) ?? numberValue(record.cpuInstructions),
    memoryBytes: numberValue(record.memBytes) ?? numberValue(record.memoryBytes),
    authRequired: auth,
    errorCode: error?.code,
    errorMessage: error?.message,
    raw: payload,
  };
}

export async function simulateSorobanTransaction(transaction: Transaction, options: { rpcUrl?: string; transport?: SimulationTransport; signal?: AbortSignal } = {}): Promise<SorobanSimulationResult> {
  if (options.transport) return parseSimulationResponse(await options.transport.simulateTransaction(transaction), transaction);
  const rpcUrl = options.rpcUrl || process.env.NEXT_PUBLIC_SOROBAN_RPC;
  if (!rpcUrl) throw new Error('No Soroban RPC URL is configured');
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: { transaction: transaction.toXDR() } }),
    signal: options.signal,
  });
  if (!response.ok) return parseSimulationResponse({ error: { code: String(response.status), message: `RPC request failed (${response.status})` } }, transaction);
  const payload = await response.json() as Record<string, unknown>;
  if (payload.error) return parseSimulationResponse(payload, transaction);
  const result = payload.result as Record<string, unknown> | undefined;
  return parseSimulationResponse(result || payload, transaction);
}

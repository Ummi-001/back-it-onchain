'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Loader, ShieldAlert } from 'lucide-react';
import { simulateSorobanTransaction, type SorobanSimulationResult } from '@/src/lib/soroban-simulator';
import type { Transaction } from '@stellar/stellar-sdk';

export interface TxPreflightBannerProps {
  transaction: Transaction | null;
  rpcUrl?: string;
  onResult?: (result: SorobanSimulationResult) => void;
  className?: string;
}

export function TxPreflightBanner({ transaction, rpcUrl, onResult, className }: TxPreflightBannerProps) {
  const [result, setResult] = React.useState<SorobanSimulationResult | null>(null);
  const [isChecking, setIsChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const check = React.useCallback(async () => {
    if (!transaction) return;
    setIsChecking(true);
    setError(null);
    try {
      const next = await simulateSorobanTransaction(transaction, { rpcUrl });
      setResult(next);
      onResult?.(next);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setResult(null);
    } finally {
      setIsChecking(false);
    }
  }, [onResult, rpcUrl, transaction]);

  React.useEffect(() => {
    setResult(null);
    setError(null);
  }, [transaction]);

  if (!transaction) return null;

  return (
    <section className={`rounded-xl border p-4 ${result?.success ? 'border-green-500/30 bg-green-500/5' : result ? 'border-red-500/30 bg-red-500/5' : 'border-border bg-card'} ${className || ''}`} data-testid="tx-preflight-banner">
      <div className="flex items-start gap-3">
        {isChecking ? <Loader className="h-5 w-5 animate-spin text-primary" /> : result?.success ? <CheckCircle2 className="h-5 w-5 text-green-500" /> : <AlertTriangle className="h-5 w-5 text-amber-500" />}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Transaction preflight</h2>
          {isChecking ? <p className="text-xs text-muted-foreground">Simulating resources and contract conditions…</p> : null}
          {error ? <p className="mt-1 text-xs text-red-500" role="alert">{error}</p> : null}
          {result && !result.success ? <div className="mt-2 space-y-1 text-xs text-red-500"><p className="font-medium">{result.errorCode || 'ContractError'}</p><p>{result.errorMessage || 'The simulation reverted.'}</p></div> : null}
          {result?.success ? <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground"><p>Estimated fee <span className="font-semibold text-foreground">{result.resourceFeeXlm.toFixed(5)} XLM</span></p><p>Auth required <span className="font-semibold text-foreground">{result.authRequired ? 'Yes' : 'No'}</span></p>{result.cpuInstructions ? <p>CPU instructions <span className="font-semibold text-foreground">{result.cpuInstructions.toLocaleString()}</span></p> : null}{result.memoryBytes ? <p>Memory <span className="font-semibold text-foreground">{result.memoryBytes.toLocaleString()} bytes</span></p> : null}</div> : null}
        </div>
        <button type="button" onClick={() => void check()} disabled={isChecking} className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-secondary disabled:opacity-50">{result ? 'Recheck' : 'Run check'}</button>
      </div>
      {result?.success ? <p className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground"><ShieldAlert className="h-3 w-3" /> Simulation is an estimate; the wallet still requests final authorization.</p> : null}
    </section>
  );
}

export default TxPreflightBanner;

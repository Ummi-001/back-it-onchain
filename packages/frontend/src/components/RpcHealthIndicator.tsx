'use client';

import { Activity, CircleCheck, CircleX } from 'lucide-react';
import { useRpcHealth } from '@/src/hooks/useRpcHealth';
import type { RpcEndpoint } from '@/src/lib/rpc-failover';

export function RpcHealthIndicator({ endpoints, network = 'TESTNET' }: { endpoints: RpcEndpoint[]; network?: string }) {
  const { activeEndpoint, snapshots, healthy } = useRpcHealth({ endpoints, network });
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="rpc-health-indicator">
      <Activity className="h-3.5 w-3.5" />
      <span>{healthy ? 'RPC healthy' : 'RPC degraded'}</span>
      {activeEndpoint ? <span className="rounded-full bg-secondary px-2 py-0.5">{activeEndpoint.id}</span> : null}
      {snapshots.map((snapshot) => <span key={snapshot.endpointId} title={snapshot.lastError || `${snapshot.latencyMs || 0}ms`} className={snapshot.healthy ? 'text-green-500' : 'text-red-500'}>{snapshot.healthy ? <CircleCheck className="h-3.5 w-3.5" /> : <CircleX className="h-3.5 w-3.5" />}</span>)}
    </div>
  );
}

export default RpcHealthIndicator;

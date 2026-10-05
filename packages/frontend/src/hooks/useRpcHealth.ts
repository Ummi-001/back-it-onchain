'use client';

import * as React from 'react';
import { createRpcFailoverManager, type RpcEndpoint, type RpcProbe, type RpcFailoverOptions, type RpcHealthSnapshot } from '@/src/lib/rpc-failover';

export function useRpcHealth(options: Omit<RpcFailoverOptions, 'endpoints' | 'network'> & { endpoints: RpcEndpoint[]; network?: string; enabled?: boolean }) {
  const { endpoints, network = 'TESTNET', enabled = true, failureThreshold = 3, probeIntervalMs = 5_000, requestTimeoutMs = 4_000, probe } = options;
  const manager = React.useMemo(() => {
    if (endpoints.length === 0) return null;
    return createRpcFailoverManager({ endpoints, network, failureThreshold, probeIntervalMs, requestTimeoutMs, probe });
  }, [endpoints, failureThreshold, network, probe, probeIntervalMs, requestTimeoutMs]);
  const [snapshots, setSnapshots] = React.useState<RpcHealthSnapshot[]>([]);
  const [activeEndpoint, setActiveEndpoint] = React.useState<RpcEndpoint | null>(null);

  React.useEffect(() => {
    if (!manager || !enabled) return;
    setSnapshots(manager.snapshots);
    setActiveEndpoint(manager.activeEndpoint);
    const unsubscribe = manager.subscribe(() => {
      setSnapshots(manager.snapshots);
      setActiveEndpoint(manager.activeEndpoint);
    });
    manager.start();
    return () => { unsubscribe(); manager.stop(); };
  }, [enabled, manager]);

  return { manager, snapshots, activeEndpoint, healthy: snapshots.filter((snapshot) => snapshot.healthy).length > 0 };
}

export type { RpcProbe };

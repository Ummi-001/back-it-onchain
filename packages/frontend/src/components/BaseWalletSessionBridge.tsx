'use client';

import * as React from 'react';
import { useAccount } from 'wagmi';
import { useWalletSessions } from '@/src/context/WalletContext';

export function BaseWalletSessionBridge() {
  const { address, isConnected, chainId } = useAccount();
  const { setSession, clearSession } = useWalletSessions();

  React.useEffect(() => {
    if (isConnected && address) setSession('base', address, String(chainId || 'base'));
    if (!isConnected) clearSession('base');
  }, [address, chainId, clearSession, isConnected, setSession]);

  return null;
}

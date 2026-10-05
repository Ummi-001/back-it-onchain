'use client';

import * as React from 'react';

export type WalletChain = 'base' | 'stellar';

export interface WalletSession {
  address: string;
  network: string;
  connectedAt: number;
}

export interface WalletContextValue {
  sessions: Record<WalletChain, WalletSession | null>;
  activeChain: WalletChain;
  activeSession: WalletSession | null;
  tokens: Record<WalletChain, string | null>;
  setActiveChain: (chain: WalletChain) => void;
  setSession: (chain: WalletChain, address: string, network?: string) => void;
  clearSession: (chain: WalletChain) => void;
  setToken: (chain: WalletChain, token: string | null) => void;
  switchChain: (chain: WalletChain) => void;
}

const STORAGE_KEY = 'backit-wallet-sessions-v1';
const WalletContext = React.createContext<WalletContextValue | null>(null);

function readSessions(): Record<WalletChain, WalletSession | null> {
  if (typeof window === 'undefined') return { base: null, stellar: null };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as Partial<Record<WalletChain, WalletSession>>;
    return {
      base: parsed.base?.address ? parsed.base : null,
      stellar: parsed.stellar?.address ? parsed.stellar : null,
    };
  } catch {
    return { base: null, stellar: null };
  }
}

export function WalletSessionProvider({ children, initialChain = 'base' }: { children: React.ReactNode; initialChain?: WalletChain }) {
  const [sessions, setSessions] = React.useState<Record<WalletChain, WalletSession | null>>({ base: null, stellar: null });
  const [activeChain, setActiveChain] = React.useState<WalletChain>(initialChain);
  const [tokens, setTokens] = React.useState<Record<WalletChain, string | null>>({ base: null, stellar: null });

  React.useEffect(() => setSessions(readSessions()), []);
  React.useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions]);

  const setSession = React.useCallback((chain: WalletChain, address: string, network = chain === 'base' ? 'base' : 'TESTNET') => {
    const normalized = address.trim();
    if (!normalized) return;
    setSessions((current) => ({ ...current, [chain]: { address: normalized, network, connectedAt: Date.now() } }));
  }, []);

  const clearSession = React.useCallback((chain: WalletChain) => {
    setSessions((current) => ({ ...current, [chain]: null }));
    setTokens((current) => ({ ...current, [chain]: null }));
  }, []);

  const setToken = React.useCallback((chain: WalletChain, token: string | null) => {
    setTokens((current) => ({ ...current, [chain]: token }));
  }, []);

  const value = React.useMemo<WalletContextValue>(() => ({
    sessions,
    activeChain,
    activeSession: sessions[activeChain],
    tokens,
    setActiveChain,
    setSession,
    clearSession,
    setToken,
    switchChain: setActiveChain,
  }), [activeChain, clearSession, sessions, setSession, setToken, tokens]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWalletSessions(): WalletContextValue {
  const context = React.useContext(WalletContext);
  if (!context) {
    // Return default context for SSR/SSG when provider is not available
    return {
      sessions: { base: null, stellar: null },
      activeChain: 'base',
      activeSession: null,
      tokens: { base: null, stellar: null },
      setActiveChain: () => {},
      setSession: () => {},
      clearSession: () => {},
      setToken: () => {},
      switchChain: () => {},
    };
  }
  return context;
}

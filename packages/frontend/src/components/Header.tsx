'use client';

import * as React from 'react';
import { Check, Circle, Copy, Wallet } from 'lucide-react';
import { useWalletSessions, type WalletChain } from '@/src/context/WalletContext';
import { cn } from '@/lib/utils';

export interface HeaderProps {
  className?: string;
}

function short(address: string | undefined): string {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Not connected';
}

export function Header({ className }: HeaderProps) {
  const { sessions, activeChain, setActiveChain, clearSession } = useWalletSessions();
  const [copied, setCopied] = React.useState<WalletChain | null>(null);
  const chains: WalletChain[] = ['base', 'stellar'];

  const copy = async (chain: WalletChain) => {
    const address = sessions[chain]?.address;
    if (!address || !navigator.clipboard) return;
    await navigator.clipboard.writeText(address);
    setCopied(chain);
    window.setTimeout(() => setCopied(null), 1500);
  };

  return (
    <header className={cn('flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/80 px-4 py-3 backdrop-blur', className)} data-testid="multi-wallet-header">
      <div className="flex items-center gap-2 text-sm font-semibold"><Wallet className="h-4 w-4 text-primary" /> Wallet sessions</div>
      <div className="flex flex-wrap items-center gap-2">
        {chains.map((chain) => {
          const session = sessions[chain];
          return <div key={chain} className={cn('flex items-center gap-1 rounded-full border px-2 py-1 text-xs', activeChain === chain ? 'border-primary bg-primary/10' : 'border-border')}>
            <button type="button" onClick={() => setActiveChain(chain)} className="inline-flex items-center gap-1 capitalize"><Circle className={cn('h-2.5 w-2.5', session ? 'fill-green-500 text-green-500' : 'text-muted-foreground')} />{chain}<span className="ml-1 text-muted-foreground">{short(session?.address)}</span></button>
            {session ? <button type="button" aria-label={`Copy ${chain} address`} onClick={() => void copy(chain)} className="rounded p-0.5 text-muted-foreground hover:text-foreground">{copied === chain ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}</button> : null}
            {session && process.env.NODE_ENV === 'development' ? <button type="button" aria-label={`Disconnect ${chain}`} onClick={() => clearSession(chain)} className="text-muted-foreground hover:text-red-500">×</button> : null}
          </div>;
        })}
        <span className="rounded-full bg-secondary px-2 py-1 text-[10px] text-muted-foreground">Target: {activeChain}</span>
      </div>
    </header>
  );
}

export default Header;

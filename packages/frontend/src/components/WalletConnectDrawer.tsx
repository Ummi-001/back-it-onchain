"use client";

import { useState } from "react";
import { Wallet, X, Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useWallet } from "@/hooks/useWallet";
import { useStellarWallet } from "@/components/StellarWalletProvider";
import { useStellarAssets } from "@/src/hooks/useStellarAssets";
import { StellarAssetList } from "@/src/components/StellarAssetList";

export function WalletConnectDrawer() {
  const [isOpen, setIsOpen] = useState(false);
  const { isConnected, address, chain, status, connect, disconnect } = useWallet();
  const stellar = useStellarWallet();
  const stellarAssets = useStellarAssets(stellar.publicKey, stellar.networkDetails?.networkUrl);
  
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(true)}
        data-testid="wallet-drawer-trigger"
      >
        <Wallet className="h-4 w-4 mr-2" />
        {isConnected ? `${address?.slice(0, 6)}...${address?.slice(-4)}` : "Connect"}
      </Button>
      
      {isOpen && (
        <div className="fixed inset-0 z-50">
          <button type="button" aria-label="Close" tabIndex={-1} className="fixed inset-0 bg-black/80" onClick={() => setIsOpen(false)} />
          <div className="fixed right-0 top-0 h-full w-80 bg-card border-l border-border p-6 shadow-xl animate-in slide-in-from-right">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold">Wallet</h2>
              <Button variant="ghost" size="icon" onClick={() => setIsOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            
            {isConnected ? (
              <div className="space-y-4">
                <div className="bg-secondary/50 rounded-lg p-4 border border-border">
                  <p className="text-xs text-muted-foreground mb-1">Address</p>
                  <p className="font-mono text-sm break-all">{address}</p>
                </div>
                <div className="bg-secondary/50 rounded-lg p-4 border border-border">
                  <p className="text-xs text-muted-foreground mb-1">Chain</p>
                  <p className="text-sm font-medium capitalize">{chain}</p>
                </div>
                {stellar.publicKey ? (
                  <StellarAssetList
                    assets={stellarAssets.assets}
                    loading={stellarAssets.loading}
                    error={stellarAssets.error}
                    onRefresh={stellarAssets.refresh}
                  />
                ) : null}
                <div className="bg-green-500/10 rounded-lg p-3 border border-green-500/20">
                  <p className="text-sm text-green-500 flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                    Connected
                  </p>
                </div>
                <Button variant="destructive" className="w-full" onClick={disconnect}>
                  <LogOut className="h-4 w-4 mr-2" />
                  Disconnect
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">Select a chain to connect:</p>
                <Button
                  className="w-full justify-start"
                  variant="outline"
                  onClick={() => connect("base")}
                  disabled={status === "connecting"}
                >
                  {status === "connecting" && chain === "base" ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : null}
                  🔵 Base
                </Button>
                <Button
                  className="w-full justify-start"
                  variant="outline"
                  onClick={() => connect("stellar")}
                  disabled={status === "connecting"}
                >
                  {status === "connecting" && chain === "stellar" ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : null}
                  ⭐ Stellar
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

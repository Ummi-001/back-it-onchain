"use client";

import { OnchainKitProvider } from "@coinbase/onchainkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { baseSepolia } from "wagmi/chains";
import {
  http,
  createConfig,
  WagmiProvider,
  cookieStorage,
  createStorage,
  type State,
} from "wagmi";
import type { Chain } from "viem";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { ReactNode, useEffect, useState } from "react";
import { Toaster } from "sonner";

import { registerServiceWorker } from "@/src/lib/pwa";
import { GlobalStateProvider } from "./GlobalState";
import { NetworkGuard } from "./NetworkGuard";
import { StellarWalletProvider } from "./StellarWalletProvider";
import { ChainProvider } from "./ChainProvider";
import { WalletSessionProvider } from "@/src/context/WalletContext";
import { BaseWalletSessionBridge } from "@/src/components/BaseWalletSessionBridge";

// Local Anvil chain definition
const localhost: Chain = {
  id: 31337,
  name: "Localhost",
  nativeCurrency: {
    decimals: 18,
    name: "Ether",
    symbol: "ETH",
  },
  rpcUrls: {
    default: { http: ["http://127.0.0.1:8545"] },
  },
};

// Use localhost for development, baseSepolia for production
const isDev = process.env.NODE_ENV === "development";
const activeChain = isDev ? localhost : baseSepolia;

const config = createConfig({
  chains: [localhost, baseSepolia],
  connectors: [
    injected(),
    coinbaseWallet({
      appName: "Back It (Onchain)",
    }),
  ],
  storage: createStorage({
    storage: cookieStorage,
  }),
  ssr: true,
  transports: {
    [localhost.id]: http(),
    [baseSepolia.id]: http(),
  },
});

export function Providers(props: {
  children: ReactNode;
  initialState?: State;
}) {
  const [queryClient] = useState(() => new QueryClient());

  // Install the app-shell + feed-cache service worker once, per origin.
  useEffect(() => {
    void registerServiceWorker();
  }, []);

  return (
    <ChainProvider>
      <WagmiProvider config={config} initialState={props.initialState}>
        <QueryClientProvider client={queryClient}>
          <OnchainKitProvider
            apiKey={process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY}
            chain={activeChain}
          >
            <NetworkGuard>
              <StellarWalletProvider>
                <WalletSessionProvider>
                  <BaseWalletSessionBridge />
                  <GlobalStateProvider>{props.children}</GlobalStateProvider>
                  <Toaster position="top-right" closeButton />
                </WalletSessionProvider>
              </StellarWalletProvider>
            </NetworkGuard>
          </OnchainKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ChainProvider>
  );
}

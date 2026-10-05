/**
 * Stellar Wallet Provider
 *
 * React Context Provider for managing Stellar wallet state across the application.
 * Handles Freighter wallet connection, network switching, and state persistence.
 */

"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from "react";
import {
  StellarWalletAdapter,
  StellarNetwork,
  NetworkDetails,
} from "@/lib/stellar-wallet-adapter";
import { useWalletSessions } from "@/src/context/WalletContext";

/**
 * Context value interface
 * Defines all state and methods available to consuming components
 */
interface StellarWalletContextValue {
  // Connection state
  publicKey: string | null;
  isConnected: boolean;
  isFreighterInstalled: boolean;
  /** True once the Freighter install check has completed (avoids flash of "not detected") */
  isFreighterCheckComplete: boolean;

  // Network state
  network: StellarNetwork;
  networkDetails: NetworkDetails | null;

  // Loading states
  isConnecting: boolean;

  // Methods
  connect: () => Promise<void>;
  disconnect: () => void;
  switchNetwork: (network: StellarNetwork) => Promise<void>;

  // Adapter instance (for advanced usage)
  adapter: StellarWalletAdapter | null;
}

/**
 * Default context value
 * Used when provider is not available in component tree
 */
const defaultContextValue: StellarWalletContextValue = {
  publicKey: null,
  isConnected: false,
  isFreighterInstalled: false,
  isFreighterCheckComplete: false,
  network: "TESTNET",
  networkDetails: null,
  isConnecting: false,
  connect: async () => {
    throw new Error("StellarWalletProvider not found");
  },
  disconnect: () => {
    throw new Error("StellarWalletProvider not found");
  },
  switchNetwork: async () => {
    throw new Error("StellarWalletProvider not found");
  },
  adapter: null,
};

// Create the context
const StellarWalletContext =
  createContext<StellarWalletContextValue>(defaultContextValue);

/**
 * Props for the provider component
 */
interface StellarWalletProviderProps {
  children: ReactNode;
}

/**
 * StellarWalletProvider Component
 *
 * Wraps the application to provide Stellar wallet functionality.
 * Manages connection state, network configuration, and persistence.
 */
export function StellarWalletProvider({
  children,
}: StellarWalletProviderProps) {
  // State management
  const [adapter] = useState<StellarWalletAdapter>(
    () => new StellarWalletAdapter(),
  );
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isFreighterInstalled, setIsFreighterInstalled] =
    useState<boolean>(false);
  const [isFreighterCheckComplete, setIsFreighterCheckComplete] =
    useState<boolean>(false);
  const [network, setNetwork] = useState<StellarNetwork>("TESTNET");
  const [networkDetails, setNetworkDetails] = useState<NetworkDetails | null>(
    null,
  );
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const { setSession, clearSession } = useWalletSessions();

  /**
   * Check if Freighter is installed on component mount
   */
  useEffect(() => {
    const checkFreighterInstallation = async () => {
      const installed = await StellarWalletAdapter.isFreighterInstalled();
      setIsFreighterInstalled(installed);
      setIsFreighterCheckComplete(true);
    };

    checkFreighterInstallation();
  }, []);

  /**
   * Restore connection state on mount
   * This enables persistence across page refreshes
   */
  useEffect(() => {
    const restoreConnection = async () => {
      try {
        // Explicitly restore the connection from storage
        await adapter.restoreConnection();

        if (adapter.isConnected && adapter.getPublicKey()) {
          setPublicKey(adapter.getPublicKey());
          setIsConnected(true);

          // Fetch current network details
          const details = await adapter.getNetworkDetails();
          setNetwork(details.network);
          setNetworkDetails(details);
          setSession('stellar', adapter.getPublicKey() || '', details.network);
        }
      } catch (error) {
        console.error("Error restoring Stellar wallet connection:", error);
        // If restoration fails, clear the state
        adapter.disconnect();
         setPublicKey(null);
         setIsConnected(false);
         clearSession('stellar');
       }
    };

    restoreConnection();
  }, [adapter, clearSession, setSession]);

  /**
   * Connect to Freighter wallet
   * Requests user permission and retrieves public key
   */
  const connect = useCallback(async () => {
    if (!isFreighterInstalled) {
      throw new Error(
        "Freighter wallet is not installed. Please install it from https://www.freighter.app/",
      );
    }

    setIsConnecting(true);

    try {
      // Connect and get public key
      const address = await adapter.connect();
      setPublicKey(address);
      setIsConnected(true);

      // Fetch network details
      const details = await adapter.getNetworkDetails();
       setNetwork(details.network);
       setNetworkDetails(details);
       setSession('stellar', address, details.network);

       console.log("Connected to Stellar wallet:", address);
    } catch (error) {
      console.error("Error connecting to Stellar wallet:", error);

      // Reset state on error
      setPublicKey(null);
      setIsConnected(false);

      throw error;
    } finally {
      setIsConnecting(false);
    }
  }, [adapter, isFreighterInstalled, setSession]);

  /**
   * Disconnect from Freighter wallet
   * Clears all state and storage
   */
  const disconnect = useCallback(() => {
    adapter.disconnect();
    setPublicKey(null);
    setIsConnected(false);
     setNetwork("TESTNET");
     setNetworkDetails(null);
     clearSession("stellar");

     console.log("Disconnected from Stellar wallet");
   }, [adapter, clearSession]);

  /**
   * Switch network (Note: This requires user to manually change network in Freighter)
   * This function primarily updates local state and notifies the user
   */
  const switchNetwork = useCallback(
    async (targetNetwork: StellarNetwork) => {
      try {
        // Get current network from Freighter
        const currentNetwork = await adapter.getNetwork();

        if (currentNetwork === targetNetwork) {
          console.log("Already on", targetNetwork);
          return;
        }

        // Note: We cannot programmatically change Freighter's network
        // The user must manually switch in the Freighter extension
        console.warn(
          `Please switch to ${targetNetwork} network in your Freighter wallet extension`,
        );

        // We can update our local state to reflect the desired network
        // and refresh the network details
        const details = await adapter.getNetworkDetails();
         setNetwork(details.network);
         setNetworkDetails(details);
         if (adapter.getPublicKey()) setSession('stellar', adapter.getPublicKey() || '', details.network);
       } catch (error) {
        console.error("Error switching network:", error);
        throw error;
      }
    },
    [adapter, setSession],
  );

  /**
   * Context value to be provided to consuming components
   */
  const contextValue: StellarWalletContextValue = {
    publicKey,
    isConnected,
    isFreighterInstalled,
    isFreighterCheckComplete,
    network,
    networkDetails,
    isConnecting,
    connect,
    disconnect,
    switchNetwork,
    adapter,
  };

  return (
    <StellarWalletContext.Provider value={contextValue}>
      {children}
    </StellarWalletContext.Provider>
  );
}

/**
 * Custom hook to access Stellar wallet context
 *
 * @returns StellarWalletContextValue - The current context value
 * @throws Error if used outside of StellarWalletProvider
 */
export function useStellarWallet(): StellarWalletContextValue {
  const context = useContext(StellarWalletContext);

  if (!context) {
    throw new Error(
      "useStellarWallet must be used within StellarWalletProvider",
    );
  }

  return context;
}

/**
 * Utility hook to check if Stellar wallet is available
 * Safe to use outside of provider for conditional rendering
 *
 * @returns boolean - True if Freighter is installed
 */
export function useIsStellarWalletAvailable(): boolean {
  const [isAvailable, setIsAvailable] = useState<boolean>(false);

  useEffect(() => {
    const checkAvailability = async () => {
      const available = await StellarWalletAdapter.isFreighterInstalled();
      setIsAvailable(available);
    };

    checkAvailability();
  }, []);

  return isAvailable;
}

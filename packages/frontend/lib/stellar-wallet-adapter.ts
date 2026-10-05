/**
 * Stellar Wallet Adapter
 *
 * Implements the WalletAdapter interface for Freighter wallet integration.
 * Handles connection, disconnection, and transaction signing for Stellar blockchain.
 */

import {
  isConnected,
  getAddress,
  requestAccess,
  signTransaction as freighterSignTransaction,
  getNetwork,
  getNetworkDetails,
} from "@stellar/freighter-api";
import { Transaction } from "@stellar/stellar-sdk";

/**
 * Standard wallet adapter interface
 * Defines the contract that all wallet adapters must implement
 */
export interface WalletAdapter {
  connect(): Promise<string>;
  disconnect(): void;
  signTransaction(tx: Transaction): Promise<string>;
  signChallenge(transactionXdr: string, networkPassphrase: string): Promise<string>;
  getPublicKey(): string | null;
  isConnected: boolean;
}

/**
 * Network configuration for Stellar
 */
export type StellarNetwork = "TESTNET" | "PUBLIC" | "FUTURENET" | "STANDALONE";

export interface NetworkDetails {
  network: StellarNetwork;
  networkUrl: string;
  networkPassphrase: string;
  sorobanRpcUrl?: string;
}

/**
 * StellarWalletAdapter
 *
 * Concrete implementation of WalletAdapter for Freighter wallet.
 * Manages connection state and interactions with the Freighter browser extension.
 */
export class StellarWalletAdapter implements WalletAdapter {
  private publicKey: string | null = null;
  private connected: boolean = false;

  constructor() {
    // Connection restoration should be handled explicitly by the consumer
  }

  /**
   * Restore connection from localStorage
   * Called on adapter initialization to maintain state across page refreshes
   */
  public async restoreConnection(): Promise<void> {
    // Check if we're in a browser environment
    if (typeof window === "undefined") return;

    try {
      const storedKey = localStorage.getItem("stellar_public_key");
      const storedConnected = localStorage.getItem("stellar_connected");

      if (storedKey && storedConnected === "true") {
        // Verify Freighter is still connected
        const connectionStatus = await isConnected();

        if (connectionStatus.isConnected) {
          // Verify the public key is still valid
          const addressResult = await getAddress();

          if (!addressResult.error && addressResult.address === storedKey) {
            this.publicKey = storedKey;
            this.connected = true;
          } else {
            // Clear invalid stored data
            this.clearStorage();
          }
        } else {
          this.clearStorage();
        }
      }
    } catch (error) {
      console.error("Error restoring Stellar wallet connection:", error);
      this.clearStorage();
    }
  }

  /**
   * Clear stored connection data
   */
  private clearStorage(): void {
    // Check if we're in a browser environment
    if (typeof window === "undefined") return;

    localStorage.removeItem("stellar_public_key");
    localStorage.removeItem("stellar_connected");
  }

  /**
   * Connect to Freighter wallet
   *
   * @returns Promise<string> - The user's public key (Stellar address)
   * @throws Error if Freighter is not installed or user rejects connection
   */
  async connect(): Promise<string> {
    try {
      // Check if Freighter is installed
      const connectionStatus = await isConnected();

      if (!connectionStatus.isConnected) {
        throw new Error(
          "Freighter wallet is not installed. Please install it from https://www.freighter.app/",
        );
      }

      // Request access to the user's public key
      const accessResult = await requestAccess();

      if (accessResult.error) {
        throw new Error(accessResult.error);
      }

      if (!accessResult.address) {
        throw new Error("Failed to retrieve address from Freighter");
      }

      // Store connection state
      this.publicKey = accessResult.address;
      this.connected = true;

      // Persist to localStorage for page refresh persistence
      if (typeof window !== "undefined") {
        localStorage.setItem("stellar_public_key", this.publicKey);
        localStorage.setItem("stellar_connected", "true");
      }

      return this.publicKey;
    } catch (error) {
      this.connected = false;
      this.publicKey = null;
      this.clearStorage();

      throw error;
    }
  }

  /**
   * Disconnect from Freighter wallet
   * Clears local state and storage
   */
  disconnect(): void {
    this.publicKey = null;
    this.connected = false;
    this.clearStorage();
  }

  /**
   * Sign a Stellar transaction using Freighter
   *
   * @param tx - The Stellar transaction to sign
   * @returns Promise<string> - The signed transaction XDR
   * @throws Error if not connected or signing fails
   */
  async signTransaction(tx: Transaction): Promise<string> {
    if (!this.connected || !this.publicKey) {
      throw new Error("Wallet not connected. Please connect first.");
    }

    try {
      // Get current network details
      const networkDetails = await this.getNetworkDetails();

      // Convert transaction to XDR string
      const xdr = tx.toXDR();

      // Sign the transaction using Freighter
      // Note: Only networkPassphrase and address are supported in options
      const signResult = await freighterSignTransaction(xdr, {
        networkPassphrase: networkDetails.networkPassphrase,
        address: this.publicKey,
      });

      if (signResult.error) {
        throw new Error(signResult.error);
      }

      if (!signResult.signedTxXdr) {
        throw new Error("Failed to sign transaction");
      }

      return signResult.signedTxXdr;
    } catch (error) {
      console.error("Error signing transaction:", error);
      throw error;
    }
  }

  async signChallenge(transactionXdr: string, networkPassphrase: string): Promise<string> {
    if (!this.connected || !this.publicKey) {
      throw new Error("Wallet not connected. Please connect first.");
    }
    const result = await freighterSignTransaction(transactionXdr, {
      networkPassphrase,
      address: this.publicKey,
    });
    if (result.error) throw new Error(result.error);
    if (!result.signedTxXdr) throw new Error("Failed to sign SEP-10 challenge");
    return result.signedTxXdr;
  }

  getPublicKey(): string | null {
    return this.publicKey;
  }

  /**
   * Get connection status
   *
   * @returns boolean - True if wallet is connected
   */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get current network configuration from Freighter
   *
   * @returns Promise<StellarNetwork> - The current network
   */
  async getNetwork(): Promise<StellarNetwork> {
    try {
      const networkResult = await getNetwork();

      if (networkResult.error) {
        throw new Error(networkResult.error);
      }

      return networkResult.network as StellarNetwork;
    } catch (error) {
      console.error("Error getting network:", error);
      // Default to TESTNET for development
      return "TESTNET";
    }
  }

  /**
   * Get detailed network configuration from Freighter
   *
   * @returns Promise<NetworkDetails> - Detailed network information
   */
  async getNetworkDetails(): Promise<NetworkDetails> {
    try {
      const details = await getNetworkDetails();

      if (details.error) {
        throw new Error(details.error);
      }

      return {
        network: details.network as StellarNetwork,
        networkUrl: details.networkUrl,
        networkPassphrase: details.networkPassphrase,
        sorobanRpcUrl: details.sorobanRpcUrl,
      };
    } catch (error) {
      console.error("Error getting network details:", error);
      // Return TESTNET defaults as fallback
      return {
        network: "TESTNET",
        networkUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
        sorobanRpcUrl: "https://soroban-testnet.stellar.org",
      };
    }
  }

  /**
   * Check if Freighter is installed in the browser
   *
   * @returns Promise<boolean> - True if Freighter is installed
   */
  static async isFreighterInstalled(): Promise<boolean> {
    try {
      const result = await isConnected();
      return result.isConnected;
    } catch {
      return false;
    }
  }
}

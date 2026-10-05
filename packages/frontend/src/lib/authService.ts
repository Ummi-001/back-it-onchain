import { api } from '../../lib/apiClient';

export interface Sep10Challenge {
  transactionXdr: string;
  networkPassphrase: string;
  expiresAt?: string;
}

export interface Sep10Session {
  token: string;
  expiresAt?: string;
}

export interface Sep10Wallet {
  getPublicKey(): string | null;
  signChallenge(transactionXdr: string, networkPassphrase: string): Promise<string>;
}

export async function fetchSep10Challenge(publicKey: string, endpoint = '/auth/stellar/challenge'): Promise<Sep10Challenge> {
  const response = await api.get<Sep10Challenge>(`${endpoint}?address=${encodeURIComponent(publicKey)}`);
  if (!response.transactionXdr || !response.networkPassphrase) throw new Error('The SEP-10 challenge response is incomplete');
  return response;
}

export async function exchangeSep10Session(publicKey: string, signedTransactionXdr: string, endpoint = '/auth/stellar/verify'): Promise<Sep10Session> {
  const response = await api.post<{ accessToken?: string; access_token?: string; expiresAt?: string }>(endpoint, {
    publicKey,
    signedTransactionXdr,
  });
  const token = response.accessToken || response.access_token;
  if (!token) throw new Error('The SEP-10 verification response did not include a token');
  return { token, expiresAt: response.expiresAt };
}

export async function authenticateWithSep10(wallet: Sep10Wallet, endpoint = '/auth/stellar'): Promise<Sep10Session> {
  const publicKey = wallet.getPublicKey();
  if (!publicKey) throw new Error('Connect a Stellar wallet before signing in');
  const challenge = await fetchSep10Challenge(publicKey, `${endpoint}/challenge`);
  const signedTransactionXdr = await wallet.signChallenge(challenge.transactionXdr, challenge.networkPassphrase);
  return exchangeSep10Session(publicKey, signedTransactionXdr, `${endpoint}/verify`);
}

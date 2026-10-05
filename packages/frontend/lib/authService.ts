import { api } from './apiClient';

interface NonceResponse {
  nonce: string;
  message?: string;
}

interface VerifyResponse {
  access_token?: string;
  accessToken?: string;
}

/**
 * Step 1 — fetch a one-time nonce for the given wallet address.
 * Replaces the old GET /auth/nonce call so it's centralised here.
 */
export async function fetchNonceMessage(address: string): Promise<{ nonce: string; message: string }> {
  const response = await api.get<NonceResponse>(`/auth/nonce?address=${encodeURIComponent(address)}`);
  return { nonce: response.nonce, message: response.message || response.nonce };
}

export async function fetchNonce(address: string): Promise<string> {
  const { nonce } = await api.get<NonceResponse>(
    `/auth/nonce?address=${encodeURIComponent(address)}`,
  );
  return nonce;
}

/**
 * Step 2 — submit the signed nonce.
 * Returns the JWT issued by the backend AuthController.
 */
export async function verifySignature(
  address: string,
  signature: string,
  chain: 'base' | 'stellar',
): Promise<string> {
  const response = await api.post<VerifyResponse>('/auth/verify', {
    address,
    signature,
    chain,
  });
  const token = response.accessToken || response.access_token;
  if (!token) throw new Error('The authentication response did not include a token');
  return token;
}
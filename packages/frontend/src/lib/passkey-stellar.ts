export interface PasskeyCredentialRecord {
  id: string;
  rawId: string;
  publicKey?: string;
  transports: string[];
  createdAt: number;
}

export interface PasskeyAssertion {
  id: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  userHandle?: string;
}

export interface HardwareSigner {
  name: string;
  signChallenge(payload: string): Promise<string>;
}

const textEncoder = new TextEncoder();

function bytesToBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlToBuffer(value: string): ArrayBuffer {
  const bytes = base64UrlToBytes(value);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function isPasskeySupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined' && typeof navigator.credentials?.create === 'function';
}

function challengeBuffer(challenge: string): ArrayBuffer {
  return base64UrlToBytes(challenge).buffer as ArrayBuffer;
}

export async function createPasskeyCredential(userId: string, challenge?: string): Promise<PasskeyCredentialRecord> {
  if (!isPasskeySupported()) throw new Error('Passkeys are not supported in this browser');
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: challengeBuffer(challenge || crypto.randomUUID()),
      rp: { name: 'Back It Onchain' },
      user: { id: textEncoder.encode(userId), name: userId, displayName: userId },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      timeout: 60_000,
      attestation: 'none',
    },
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey creation was cancelled');
  const response = credential.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey ? response.getPublicKey() : null;
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    publicKey: publicKey ? bytesToBase64Url(publicKey) : undefined,
    transports: response.getTransports ? response.getTransports() : [],
    createdAt: Date.now(),
  };
}

export async function requestPasskeyAssertion(credentialId: string, challenge: string): Promise<PasskeyAssertion> {
  if (typeof navigator.credentials?.get !== 'function') throw new Error('Passkey assertions are not supported in this browser');
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: challengeBuffer(challenge),
      allowCredentials: [{ type: 'public-key', id: base64UrlToBuffer(credentialId) }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey approval was cancelled');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    authenticatorData: bytesToBase64Url(response.authenticatorData),
    clientDataJSON: bytesToBase64Url(response.clientDataJSON),
    signature: bytesToBase64Url(response.signature),
    userHandle: response.userHandle ? bytesToBase64Url(response.userHandle) : undefined,
  };
}

export async function createEncryptedKeyShare(secret: string, credentialId: string): Promise<{ salt: string; iv: string; ciphertext: string }> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is not available');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.digest('SHA-256', textEncoder.encode(`${credentialId}:${bytesToBase64Url(salt)}`));
  const key = await crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(secret));
  return { salt: bytesToBase64Url(salt), iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(encrypted) };
}

export class PasskeyStellarAdapter {
  private credential: PasskeyCredentialRecord | null = null;

  async createAccount(userId: string, challenge?: string): Promise<{ accountHandle: string; credential: PasskeyCredentialRecord }> {
    this.credential = await createPasskeyCredential(userId, challenge);
    return { accountHandle: this.credential.id, credential: this.credential };
  }

  async signPayload(challenge: string): Promise<PasskeyAssertion> {
    if (!this.credential) throw new Error('Create a passkey before signing');
    return requestPasskeyAssertion(this.credential.id, challenge);
  }

  getCredential(): PasskeyCredentialRecord | null {
    return this.credential;
  }
}

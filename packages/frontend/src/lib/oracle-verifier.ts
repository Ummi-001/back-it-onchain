import { Keypair, StrKey } from '@stellar/stellar-sdk';

export interface OraclePayload {
  callId: string;
  outcome: boolean;
  finalPrice: number;
  resolvedAt: number;
}

export interface OracleVerificationInput {
  chain: 'base' | 'stellar';
  publicKey: string;
  signature: string;
  payload: OraclePayload;
  rawPayload?: string;
  payloadEncoding?: 'hex' | 'base64' | 'canonical';
  signatureEncoding?: 'hex' | 'base64';
}

export interface OracleVerificationResult {
  valid: boolean;
  canonicalPayload: string;
  reason?: string;
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) throw new Error('Invalid hex payload');
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function uintBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let remaining = value;
  const mask = BigInt(255);
  const shift = BigInt(8);
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & mask);
    remaining >>= shift;
  }
  return bytes;
}

export function encodeOraclePayload(payload: OraclePayload): Uint8Array {
  if (!/^\d+$/.test(payload.callId)) throw new Error('callId must be an unsigned integer');
  if (!Number.isFinite(payload.finalPrice) || payload.finalPrice < 0) throw new Error('finalPrice must be a non-negative number');
  if (!Number.isFinite(payload.resolvedAt) || payload.resolvedAt < 0) throw new Error('resolvedAt must be a non-negative timestamp');
  const priceUnits = BigInt(Math.round(payload.finalPrice * 1_000_000));
  return new Uint8Array([
    ...uintBytes(BigInt(payload.callId), 8),
    payload.outcome ? 1 : 0,
    ...uintBytes(priceUnits, 16),
    ...uintBytes(BigInt(Math.trunc(payload.resolvedAt)), 8),
  ]);
}

export function canonicalOraclePayload(payload: OraclePayload): string {
  return bytesToHex(encodeOraclePayload(payload));
}

export function verifyOracleEvidence(input: OracleVerificationInput): OracleVerificationResult {
  if (input.chain !== 'stellar') return { valid: false, canonicalPayload: '', reason: 'Only Stellar Ed25519 evidence is supported by this verifier' };
  try {
    const canonical = encodeOraclePayload(input.payload);
    const payloadEncoding = input.payloadEncoding || 'canonical';
    if (payloadEncoding !== 'canonical' && !input.rawPayload) throw new Error('Raw payload is required for the selected encoding');
    const message = payloadEncoding === 'hex' ? hexToBytes(input.rawPayload as string) : payloadEncoding === 'base64' ? base64ToBytes(input.rawPayload as string) : canonical;
    const signature = input.signatureEncoding === 'base64' ? base64ToBytes(input.signature) : hexToBytes(input.signature);
    const publicKey = input.publicKey.startsWith('G') ? input.publicKey : StrKey.encodeEd25519PublicKey(Buffer.from(hexToBytes(input.publicKey)));
    const keypair = Keypair.fromPublicKey(publicKey);
    const valid = keypair.verify(message as never, signature as never);
    return { valid, canonicalPayload: bytesToHex(canonical), reason: valid ? undefined : 'Signature does not match the canonical payload' };
  } catch (caught) {
    return { valid: false, canonicalPayload: '', reason: caught instanceof Error ? caught.message : 'Invalid oracle evidence' };
  }
}

export function dexscreenerHistoryUrl(pairId: string, days = 7): string {
  return `https://dexscreener.com/${encodeURIComponent(pairId)}?tab=chart&days=${days}`;
}

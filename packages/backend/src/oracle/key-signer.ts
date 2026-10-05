import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import { Keypair } from '@stellar/stellar-sdk';
import * as nacl from 'tweetnacl';

/**
 * key-signer.ts
 *
 * KMS / Vault abstraction for EIP-712 signing (BE-02).
 *
 * Two implementations are provided behind the same `IKeySigner` contract:
 *
 *   - LocalWalletSigner  wraps an in-process `ethers.Wallet` built from
 *     ORACLE_PRIVATE_KEY. This is the default and is intended for local
 *     development / single-instance deployments.
 *
 *   - KmsSigner  delegates the actual signing to a remote key-management
 *     endpoint (KMS_URL), so the raw private key never lives in process
 *     memory. The wire format is a small transit-style HTTP contract:
 *
 *       POST {KMS_URL}/sign
 *       { keyId, domain, types, message }
 *       -> { signature: "0x...", address: "0x..." }
 *
 *       GET {KMS_URL}/address?keyId=...
 *       -> { address: "0x..." }
 *
 *     This keeps OracleService fully decoupled from *which* KMS/Vault
 *     product sits behind KMS_URL — swapping to AWS KMS, GCP KMS or
 *     Hashicorp Vault's transit engine is just a different adapter behind
 *     the same interface.
 *
 * The same split is repeated for the Stellar/Soroban ed25519 signer
 * (BE-012) further down this file: `IStellarKeySigner` is implemented by
 * `LocalEd25519Signer` (dev, secret key in memory) and
 * `KmsEd25519Signer` (prod, AWS KMS / GCP Cloud HSM — no plaintext key
 * material ever enters the process).
 */

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract?: string;
}

export type Eip712Types = Record<string, Array<{ name: string; type: string }>>;

export interface IKeySigner {
  /** Returns the checksummed EVM address this signer signs on behalf of. */
  getAddress(): Promise<string>;

  /** Produces an EIP-712 signature over the given typed data. */
  signTypedData(
    domain: Eip712Domain,
    types: Eip712Types,
    value: Record<string, unknown>,
  ): Promise<string>;

  /** Human-readable label for logging/audit purposes. */
  readonly kind: 'local' | 'kms';
}

/**
 * Signs locally using an ethers.Wallet held in process memory.
 * Supports hot-swapping the underlying key via rotate() for BE-02's
 * key-rotation requirement.
 */
export class LocalWalletSigner implements IKeySigner {
  readonly kind = 'local' as const;
  private wallet: ethers.Wallet;

  constructor(privateKey: string) {
    this.wallet = new ethers.Wallet(privateKey);
  }

  getAddress(): Promise<string> {
    return Promise.resolve(this.wallet.address);
  }

  async signTypedData(
    domain: Eip712Domain,
    types: Eip712Types,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, value);
  }

  /** Replaces the active key in place. Used by OracleService.rotateOracleKey(). */
  rotate(newPrivateKey: string): void {
    this.wallet = new ethers.Wallet(newPrivateKey);
  }
}

/**
 * Signs via a remote KMS/Vault-style HTTP endpoint. The private key
 * material never enters this process.
 */
export class KmsSigner implements IKeySigner {
  readonly kind = 'kms' as const;
  private readonly logger = new Logger(KmsSigner.name);

  constructor(
    private readonly kmsUrl: string,
    private keyId: string,
    private readonly apiToken?: string,
  ) {}

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
    return headers;
  }

  async getAddress(): Promise<string> {
    const res = await fetch(
      `${this.kmsUrl}/address?keyId=${encodeURIComponent(this.keyId)}`,
      { headers: this.headers, signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) {
      throw new Error(
        `KMS address lookup failed: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { address: string };
    return body.address;
  }

  async signTypedData(
    domain: Eip712Domain,
    types: Eip712Types,
    value: Record<string, unknown>,
  ): Promise<string> {
    const res = await fetch(`${this.kmsUrl}/sign`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        keyId: this.keyId,
        domain,
        types,
        message: value,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      throw new Error(`KMS signing failed: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as { signature: string };
    if (!body.signature) {
      throw new Error('KMS response did not include a signature');
    }
    return body.signature;
  }

  /** Points this signer at a new key alias/id. Used for key rotation. */
  rotate(newKeyId: string): void {
    this.logger.warn(
      `Rotating KMS key alias from ${this.keyId} to ${newKeyId}`,
    );
    this.keyId = newKeyId;
  }
}

// ─── Stellar / Soroban ed25519 signing (BE-012) ──────────────────────────────

/**
 * The four fields a Soroban resolution vote is authorised over. This is the
 * exact tuple `outcome_manager::submit_outcome` takes, kept as a named type so
 * the signer can validate it before a single byte is signed.
 */
export interface StellarResolutionPayload {
  /** u64 call id — must fit in an unsigned 64-bit integer. */
  callId: number;
  /**
   * The resolved outcome encoded as the contract's outcome index: `0` for
   * false/no and `1` for true/yes. Booleans are accepted and normalised, but
   * anything else is a schema violation.
   */
  outcomeIndex: 0 | 1 | boolean;
  /** u128 scaled price — must be a non-negative integer below 2^128. */
  finalPrice: string | number | bigint;
  /** u64 unix timestamp in seconds — must fit in an unsigned 64-bit integer. */
  timestamp: number;
}

export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

/** Length of the canonical payload the contract rebuilds before verifying. */
export const STELLAR_PAYLOAD_BYTES = 33;
/** Length of a raw ed25519 signature (`BytesN<64>` on-chain). */
export const ED25519_SIGNATURE_BYTES = 64;
/** Length of a raw ed25519 public key (`BytesN<32>` on-chain). */
export const ED25519_PUBLIC_KEY_BYTES = 32;

/** Raised when a resolution payload fails schema validation. */
export class ResolutionPayloadError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`Invalid resolution payload — ${field}: ${message}`);
    this.name = 'ResolutionPayloadError';
  }
}

/**
 * Strict schema validation for a Soroban resolution payload.
 *
 * Every bound is checked against the on-chain type it will be packed into,
 * because a value that silently wraps (e.g. `callId = 2^64`) produces a
 * signature that verifies on-chain over *different* bytes than the ones the
 * oracle believed it signed — a signature that is valid but settles the wrong
 * outcome. Failing closed here is the whole point of this function.
 */
export function assertValidResolutionPayload(
  payload: StellarResolutionPayload,
): void {
  // `Number.isSafeInteger` rather than `<= U64_MAX`: every value a JS number
  // can hold exactly is inside u64, but a call id above 2^53 would silently
  // lose precision and pack the *wrong* call id into the signed bytes.
  if (!Number.isSafeInteger(payload.callId) || payload.callId < 0) {
    throw new ResolutionPayloadError(
      'callId',
      `expected a non-negative safe u64 integer, received ${String(payload.callId)}`,
    );
  }

  const index =
    typeof payload.outcomeIndex === 'boolean'
      ? payload.outcomeIndex
        ? 1
        : 0
      : payload.outcomeIndex;

  if (index !== 0 && index !== 1) {
    throw new ResolutionPayloadError(
      'outcomeIndex',
      `expected 0, 1, false or true, received ${String(payload.outcomeIndex)}`,
    );
  }

  if (!Number.isSafeInteger(payload.timestamp) || payload.timestamp < 0) {
    throw new ResolutionPayloadError(
      'timestamp',
      `expected a non-negative safe u64 unix-seconds integer, received ${String(payload.timestamp)}`,
    );
  }

  toU128(payload.finalPrice);
}

/**
 * Coerces a caller-supplied price to bigint, or throws a typed validation
 * error. `BigInt('abc')` raises a bare SyntaxError, which would otherwise
 * escape the validation layer and surface to the relayer as an unclassified
 * failure with no indication of which field was wrong.
 */
function toU128(value: string | number | bigint): bigint {
  let price: bigint;
  try {
    price =
      typeof value === 'bigint'
        ? value
        : typeof value === 'number'
          ? BigInt(Math.trunc(value))
          : BigInt(value);
  } catch {
    throw new ResolutionPayloadError(
      'finalPrice',
      `expected an integer representable as u128, received ${String(value)}`,
    );
  }

  if (price < 0n || price > U128_MAX) {
    throw new ResolutionPayloadError(
      'finalPrice',
      `expected a u128 in [0, 2^128), received ${value.toString()}`,
    );
  }

  return price;
}

/**
 * Packs a resolution payload into the exact 33 bytes
 * `outcome_manager::submit_outcome` reconstructs before calling
 * `env.crypto().ed25519_verify`:
 *
 *   call_id     u64  big-endian   (8 bytes)
 *   outcome     u8   (1 byte, 0 | 1)
 *   final_price u128 big-endian   (16 bytes)
 *   timestamp   u64  big-endian   (8 bytes)
 *
 * Signing these bytes — rather than the human-readable
 * `BackIt:Outcome:...` string the old path used — is what makes a signature
 * verifiable by the Soroban crypto env.
 */
export function buildCanonicalResolutionPayload(
  payload: StellarResolutionPayload,
): Buffer {
  assertValidResolutionPayload(payload);

  const outcomeIndex =
    typeof payload.outcomeIndex === 'boolean'
      ? payload.outcomeIndex
        ? 1
        : 0
      : payload.outcomeIndex;
  const finalPrice = toU128(payload.finalPrice);

  const bytes = Buffer.alloc(STELLAR_PAYLOAD_BYTES);
  let offset = 0;

  bytes.writeBigUInt64BE(BigInt(payload.callId), offset);
  offset += 8;

  bytes.writeUInt8(outcomeIndex, offset);
  offset += 1;

  // u128 does not exist in Buffer, so write the high and low 64-bit halves.
  bytes.writeBigUInt64BE(finalPrice >> 64n, offset);
  offset += 8;
  bytes.writeBigUInt64BE(finalPrice & U64_MAX, offset);
  offset += 8;

  bytes.writeBigUInt64BE(BigInt(payload.timestamp), offset);

  return bytes;
}

/**
 * SHA-256 digest of the canonical payload.
 *
 * Two uses, both of which need a *stable* identifier rather than the payload
 * bytes themselves: the `AuditLog.payloadHash` column (tamper evidence) and
 * relayer de-duplication (has this exact outcome already been submitted?).
 */
export function digestResolutionPayload(
  payload: StellarResolutionPayload,
): string {
  return createHash('sha256')
    .update(buildCanonicalResolutionPayload(payload))
    .digest('hex');
}

/** A signature plus everything a caller needs to verify it on-chain. */
export interface StellarSignature {
  /** Raw 64-byte signature, hex encoded — the Soroban `BytesN<64>`. */
  signatureHex: string;
  /** Raw 32-byte ed25519 public key, hex encoded — the `BytesN<32>`. */
  publicKeyHex: string;
  /** The exact 33 bytes that were signed. */
  messageHex: string;
  /** sha256 of `messageHex`, for audit logs and idempotency keys. */
  payloadHash: string;
  /** `local` (dev secret key) or `hsm` (AWS KMS / Cloud HSM). */
  kind: IStellarKeySigner['kind'];
}

/**
 * Ed25519 signing for Soroban outcome submissions (BE-012).
 *
 * Implementations:
 *   - `LocalEd25519Signer`  holds the secret seed in process memory. Dev only.
 *   - `KmsEd25519Signer`    signs inside AWS KMS / a Cloud HSM. Production:
 *                            the seed is never fetched, logged or held here.
 */
export interface IStellarKeySigner {
  /** 32-byte ed25519 public key, hex encoded (`BytesN<32>`). */
  getPublicKeyHex(): Promise<string>;
  /**
   * Signs the canonical 33-byte resolution payload.
   * @param payload validated before signing; throws ResolutionPayloadError.
   */
  sign(payload: StellarResolutionPayload): Promise<StellarSignature>;
  /** Where the key lives — recorded in audit logs. */
  readonly kind: 'local' | 'hsm';
}

/**
 * Dev-mode ed25519 signer backed by a Stellar secret key held in memory.
 *
 * Uses `tweetnacl.sign.detached` over the canonical payload so the produced
 * signature is byte-identical to what `Keypair.sign()` would emit — nacl is
 * only used directly because it takes an arbitrary message buffer without the
 * SDK's own framing.
 */
export class LocalEd25519Signer implements IStellarKeySigner {
  readonly kind = 'local' as const;
  private readonly naclKeyPair: nacl.SignKeyPair;

  constructor(secretKey: string) {
    const seed = new Uint8Array(Keypair.fromSecret(secretKey).rawSecretKey());
    this.naclKeyPair = nacl.sign.keyPair.fromSeed(seed);
  }

  async getPublicKeyHex(): Promise<string> {
    return Buffer.from(this.naclKeyPair.publicKey).toString('hex');
  }

  async sign(payload: StellarResolutionPayload): Promise<StellarSignature> {
    const message = buildCanonicalResolutionPayload(payload);
    const signature = nacl.sign.detached(
      new Uint8Array(message),
      this.naclKeyPair.secretKey,
    );

    return {
      signatureHex: Buffer.from(signature).toString('hex'),
      publicKeyHex: await this.getPublicKeyHex(),
      messageHex: message.toString('hex'),
      payloadHash: createHash('sha256').update(message).digest('hex'),
      kind: this.kind,
    };
  }

  /**
   * Verifies a signature over a canonical payload. Exposed so tests and admin
   * tooling can assert round-trip integrity without importing nacl directly.
   */
  verify(
    payload: StellarResolutionPayload,
    signatureHex: string,
    publicKeyHex: string,
  ): boolean {
    const message = buildCanonicalResolutionPayload(payload);
    return nacl.sign.detached.verify(
      new Uint8Array(message),
      new Uint8Array(Buffer.from(signatureHex, 'hex')),
      new Uint8Array(Buffer.from(publicKeyHex, 'hex')),
    );
  }
}

/**
 * Production ed25519 signer that delegates to an external HSM / KMS over a
 * small transit-style HTTP contract:
 *
 *   GET  {STELLAR_KMS_URL}/ed25519/public-key?keyId=...
 *   POST {STELLAR_KMS_URL}/ed25519/sign
 *        { keyId, payload: "<hex of the canonical 33 bytes>" }
 *   ->   { signature: "<128 hex chars = 64 bytes>" }
 *
 * This is the shape AWS KMS `SignCommand` with
 * `MessageType: DIGEST`/raw, or a Cloud HSM signing endpoint, already exposes
 * — the adapter here is deliberately product-agnostic so the oracle never
 * grows a vendor dependency. The private seed is *never* transmitted to this
 * process: only the payload to be signed and the public key cross the wire.
 */
export class KmsEd25519Signer implements IStellarKeySigner {
  readonly kind = 'hsm' as const;
  private readonly logger = new Logger(KmsEd25519Signer.name);
  private cachedPublicKeyHex?: string;

  constructor(
    private readonly kmsUrl: string,
    private keyId: string,
    private readonly apiToken?: string,
    private readonly timeoutMs = 8_000,
  ) {}

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
    return headers;
  }

  async getPublicKeyHex(): Promise<string> {
    if (this.cachedPublicKeyHex) return this.cachedPublicKeyHex;

    const res = await fetch(
      `${this.kmsUrl}/ed25519/public-key?keyId=${encodeURIComponent(this.keyId)}`,
      { headers: this.headers, signal: AbortSignal.timeout(this.timeoutMs) },
    );
    if (!res.ok) {
      throw new Error(
        `HSM public key lookup failed: ${res.status} ${res.statusText}`,
      );
    }

    const body = (await res.json()) as { publicKey: string };
    const hex = normaliseHex(
      body.publicKey,
      ED25519_PUBLIC_KEY_BYTES,
      'public key',
    );
    this.cachedPublicKeyHex = hex;
    return hex;
  }

  async sign(payload: StellarResolutionPayload): Promise<StellarSignature> {
    // Validate locally before the round trip: a malformed payload should never
    // reach the HSM, and definitely should never consume a signing operation.
    const message = buildCanonicalResolutionPayload(payload);

    const res = await fetch(`${this.kmsUrl}/ed25519/sign`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        keyId: this.keyId,
        payload: message.toString('hex'),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`HSM signing failed: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as { signature: string };
    if (!body.signature) {
      throw new Error('HSM response did not include a signature');
    }

    return {
      signatureHex: normaliseHex(
        body.signature,
        ED25519_SIGNATURE_BYTES,
        'signature',
      ),
      publicKeyHex: await this.getPublicKeyHex(),
      messageHex: message.toString('hex'),
      payloadHash: createHash('sha256').update(message).digest('hex'),
      kind: this.kind,
    };
  }

  /** Points this signer at a new HSM key id (BE-12 key rotation). */
  rotate(newKeyId: string): void {
    this.logger.warn(`Rotating HSM key id from ${this.keyId} to ${newKeyId}`);
    this.keyId = newKeyId;
    // Force a re-fetch: the cached public key belongs to the old key id.
    this.cachedPublicKeyHex = undefined;
  }
}

/**
 * Coerces a hex string (with or without `0x`) to lowercase hex of exactly
 * `expectedBytes` length. An HSM that answers with the wrong width would
 * otherwise produce a transaction that reverts on-chain after paying fees.
 */
function normaliseHex(
  value: string,
  expectedBytes: number,
  label: string,
): string {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== expectedBytes * 2) {
    throw new Error(
      `HSM returned a malformed ${label}: expected ${expectedBytes} hex-encoded bytes, received ${value.length} characters`,
    );
  }
  return hex.toLowerCase();
}

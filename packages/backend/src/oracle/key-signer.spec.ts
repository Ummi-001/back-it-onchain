import { Keypair } from '@stellar/stellar-sdk';
import * as nacl from 'tweetnacl';

import {
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  KmsEd25519Signer,
  LocalEd25519Signer,
  ResolutionPayloadError,
  STELLAR_PAYLOAD_BYTES,
  StellarResolutionPayload,
  assertValidResolutionPayload,
  buildCanonicalResolutionPayload,
  digestResolutionPayload,
} from './key-signer';

/**
 * BE-012: Ed25519 outcome signing for Soroban.
 *
 * The contract (`outcome_manager::submit_outcome`) rebuilds a 33-byte message
 * and hands it to `env.crypto().ed25519_verify`. These tests assert the oracle
 * signs *those* bytes, so a signature produced here is verifiable on-chain —
 * plus the schema validation that stops a value that would wrap and settle the
 * wrong outcome from ever reaching a signing operation.
 */

const TEST_SECRET_KEY =
  'SCXJ4DAPQMXLKP3QITADMVLNX5Q7PV4L3BQKVME4N6TL5M2VJJYR7FAS';
const TEST_PUBLIC_KEY =
  'GBUWVRJNL5WV5PA45EJ7IYQMEHIM67FJ3T5QVS7NVU7PFNKPDTSQD5PJ';

const PAYLOAD: StellarResolutionPayload = {
  callId: 42,
  outcomeIndex: 1,
  finalPrice: '5000000000000000000000',
  timestamp: 1_700_000_000,
};

describe('canonical resolution payload (BE-012)', () => {
  it('is exactly 33 bytes: u64 callId + u8 outcome + u128 price + u64 timestamp', () => {
    const bytes = buildCanonicalResolutionPayload(PAYLOAD);
    expect(bytes).toHaveLength(STELLAR_PAYLOAD_BYTES);
    expect(STELLAR_PAYLOAD_BYTES).toBe(33);
  });

  it('lays the fields out big-endian in the order the contract packs them', () => {
    const bytes = buildCanonicalResolutionPayload(PAYLOAD);

    // call_id (8 bytes, u64 BE)
    expect(bytes.subarray(0, 8).toString('hex')).toBe('000000000000002a');
    // outcome (1 byte)
    expect(bytes.readUInt8(8)).toBe(1);
    // final_price (16 bytes, u128 BE) — 5000 * 1e18
    expect(bytes.subarray(9, 25).toString('hex')).toBe(
      BigInt('5000000000000000000000').toString(16).padStart(32, '0'),
    );
    // timestamp (8 bytes, u64 BE)
    expect(bytes.subarray(25, 33).toString('hex')).toBe(
      BigInt(PAYLOAD.timestamp).toString(16).padStart(16, '0'),
    );
  });

  it('is byte-identical to the message the Soroban contract reconstructs', () => {
    // Mirrors the byte-for-byte push_back sequence in
    // outcome_manager::submit_outcome.
    const callId = 7n;
    const outcome = false;
    const finalPrice = 0x0102030405060708090a0b0c0d0e0f10n;
    const timestamp = 1_760_000_000n;

    const contractMessage = Buffer.alloc(33);
    let i = 0;
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      contractMessage[i++] = Number((callId >> shift) & 0xffn);
    }
    contractMessage[i++] = outcome ? 1 : 0;
    for (let shift = 15n; shift >= 0n; shift -= 1n) {
      contractMessage[i++] = Number((finalPrice >> (shift * 8n)) & 0xffn);
    }
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      contractMessage[i++] = Number((timestamp >> shift) & 0xffn);
    }

    const oracleMessage = buildCanonicalResolutionPayload({
      callId: Number(callId),
      outcomeIndex: 0,
      finalPrice: '0x0102030405060708090a0b0c0d0e0f10',
      timestamp: Number(timestamp),
    });

    expect(oracleMessage.equals(contractMessage)).toBe(true);
  });

  it('normalises boolean outcomes to the contract 0/1 encoding', () => {
    const yes = buildCanonicalResolutionPayload({
      ...PAYLOAD,
      outcomeIndex: true,
    });
    const one = buildCanonicalResolutionPayload({
      ...PAYLOAD,
      outcomeIndex: 1,
    });
    const no = buildCanonicalResolutionPayload({
      ...PAYLOAD,
      outcomeIndex: false,
    });
    const zero = buildCanonicalResolutionPayload({
      ...PAYLOAD,
      outcomeIndex: 0,
    });

    expect(yes.equals(one)).toBe(true);
    expect(no.equals(zero)).toBe(true);
    expect(yes.equals(no)).toBe(false);
  });

  it('accepts price as number, string or bigint without changing the bytes', () => {
    const asBigInt = buildCanonicalResolutionPayload({
      ...PAYLOAD,
      finalPrice: 123_456_789n,
    });
    const asNumber = buildCanonicalResolutionPayload({
      ...PAYLOAD,
      finalPrice: 123_456_789,
    });
    const asString = buildCanonicalResolutionPayload({
      ...PAYLOAD,
      finalPrice: '123456789',
    });

    expect(asBigInt.equals(asNumber)).toBe(true);
    expect(asBigInt.equals(asString)).toBe(true);
  });

  it('produces a stable sha256 digest for audit logs and idempotency', () => {
    const digest = digestResolutionPayload(PAYLOAD);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digestResolutionPayload(PAYLOAD)).toBe(digest);
    expect(digestResolutionPayload({ ...PAYLOAD, outcomeIndex: 0 })).not.toBe(
      digest,
    );
  });
});

describe('resolution payload validation (BE-012)', () => {
  it('accepts a well-formed payload', () => {
    expect(() => assertValidResolutionPayload(PAYLOAD)).not.toThrow();
  });

  it.each([
    ['a negative callId', { callId: -1 }, 'callId'],
    ['a fractional callId', { callId: 1.5 }, 'callId'],
    ['a NaN callId', { callId: Number.NaN }, 'callId'],
    ['a callId beyond 2^53', { callId: 2 ** 53 }, 'callId'],
    ['a callId beyond u64', { callId: 2 ** 64 }, 'callId'],
    [
      'an outcome index other than 0/1',
      { outcomeIndex: 2 as 0 | 1 },
      'outcomeIndex',
    ],
    ['a negative price', { finalPrice: -1 }, 'finalPrice'],
    ['a non-numeric price', { finalPrice: 'abc' }, 'finalPrice'],
    [
      'a price beyond u128',
      { finalPrice: (1n << 128n).toString() },
      'finalPrice',
    ],
    ['a negative timestamp', { timestamp: -1 }, 'timestamp'],
    ['a fractional timestamp', { timestamp: 1.5 }, 'timestamp'],
    ['a timestamp beyond 2^53', { timestamp: 2 ** 53 }, 'timestamp'],
  ])('rejects %s', (_label, override, field) => {
    expect(() =>
      assertValidResolutionPayload({
        ...PAYLOAD,
        ...override,
      } as StellarResolutionPayload),
    ).toThrow(ResolutionPayloadError);
    try {
      buildCanonicalResolutionPayload({
        ...PAYLOAD,
        ...override,
      } as StellarResolutionPayload);
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as ResolutionPayloadError).field).toBe(field);
    }
  });

  it('names the offending field so the failure is actionable', () => {
    expect(() =>
      assertValidResolutionPayload({ ...PAYLOAD, callId: -5 }),
    ).toThrow(/callId/);
  });
});

describe('LocalEd25519Signer (BE-012)', () => {
  let signer: LocalEd25519Signer;

  beforeEach(() => {
    signer = new LocalEd25519Signer(TEST_SECRET_KEY);
  });

  it('derives the 32-byte public key from the secret seed', async () => {
    const hex = await signer.getPublicKeyHex();
    expect(hex).toHaveLength(ED25519_PUBLIC_KEY_BYTES * 2);
    expect(hex).toBe(
      Buffer.from(
        Keypair.fromPublicKey(TEST_PUBLIC_KEY).rawPublicKey(),
      ).toString('hex'),
    );
  });

  it('produces a 64-byte signature over the canonical payload', async () => {
    const sig = await signer.sign(PAYLOAD);

    expect(sig.kind).toBe('local');
    expect(sig.signatureHex).toHaveLength(ED25519_SIGNATURE_BYTES * 2);
    expect(sig.messageHex).toBe(
      buildCanonicalResolutionPayload(PAYLOAD).toString('hex'),
    );
    expect(sig.payloadHash).toBe(digestResolutionPayload(PAYLOAD));
  });

  it('produces a signature the Soroban crypto env can verify', async () => {
    const sig = await signer.sign(PAYLOAD);

    // This is exactly what `env.crypto().ed25519_verify` does: verify the raw
    // 64-byte signature against the raw 32-byte key over the raw message.
    const verified = nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(sig.messageHex, 'hex')),
      new Uint8Array(Buffer.from(sig.signatureHex, 'hex')),
      new Uint8Array(Buffer.from(sig.publicKeyHex, 'hex')),
    );
    expect(verified).toBe(true);
  });

  it('round-trips through its own verify() helper', async () => {
    const sig = await signer.sign(PAYLOAD);
    expect(signer.verify(PAYLOAD, sig.signatureHex, sig.publicKeyHex)).toBe(
      true,
    );
  });

  it('is deterministic — ed25519 signatures over identical bytes are stable', async () => {
    const a = await signer.sign(PAYLOAD);
    const b = await signer.sign(PAYLOAD);
    expect(a.signatureHex).toBe(b.signatureHex);
  });

  it('produces a different signature for a different outcome', async () => {
    const yes = await signer.sign(PAYLOAD);
    const no = await signer.sign({ ...PAYLOAD, outcomeIndex: 0 });
    expect(yes.signatureHex).not.toBe(no.signatureHex);
  });

  it('validates the payload before signing', async () => {
    await expect(
      signer.sign({ ...PAYLOAD, timestamp: -1 }),
    ).rejects.toBeInstanceOf(ResolutionPayloadError);
  });

  it('rejects a tampered signature', async () => {
    const sig = await signer.sign(PAYLOAD);
    const tampered = sig.signatureHex.replace(/^../, '00');
    expect(signer.verify(PAYLOAD, tampered, sig.publicKeyHex)).toBe(false);
  });
});

describe('KmsEd25519Signer (BE-012)', () => {
  const KMS_URL = 'https://hsm.internal.test';
  const KEY_ID =
    'projects/p/locations/eu-west-2/keyRings/oracle/cryptoKeys/oracle-ed25519';

  let publicKeyHex: string;
  let signatureHex: string;
  let naclKeyPair: nacl.SignKeyPair;

  beforeEach(() => {
    naclKeyPair = nacl.sign.keyPair.fromSeed(
      new Uint8Array(nacl.randomBytes(32)),
    );
    publicKeyHex = Buffer.from(naclKeyPair.publicKey).toString('hex');
    signatureHex = '';
  });

  const mockFetch = (
    handler: (
      url: string,
      init?: RequestInit,
    ) => { status?: number; body: unknown },
  ) => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const { status = 200, body } = handler(url, init);
        return Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: status === 200 ? 'OK' : 'Error',
          json: () => Promise.resolve(body),
        } as unknown as Response);
      });
    return spy;
  };

  afterEach(() => jest.restoreAllMocks());

  it('never receives a private key — only the payload to sign', async () => {
    let sentBody: Record<string, unknown> = {};
    const spy = mockFetch((url, init) => {
      if (url.includes('/public-key'))
        return { body: { publicKey: publicKeyHex } };
      sentBody = JSON.parse(String(init?.body));
      signatureHex = Buffer.from(
        nacl.sign.detached(
          new Uint8Array(Buffer.from(String(sentBody.payload), 'hex')),
          naclKeyPair.secretKey,
        ),
      ).toString('hex');
      return { body: { signature: signatureHex } };
    });

    const signer = new KmsEd25519Signer(KMS_URL, KEY_ID, 'token-123');
    await signer.sign(PAYLOAD);

    expect(Object.keys(sentBody).sort()).toEqual(['keyId', 'payload']);
    expect(sentBody.keyId).toBe(KEY_ID);
    expect(sentBody.payload).toBe(
      buildCanonicalResolutionPayload(PAYLOAD).toString('hex'),
    );
    expect(JSON.stringify(sentBody)).not.toContain('secret');
    spy.mockRestore();
  });

  it('reports kind "hsm" and normalises a 0x-prefixed signature', async () => {
    const spy = mockFetch((url) => {
      if (url.includes('/public-key'))
        return { body: { publicKey: `0x${publicKeyHex}` } };
      return { body: { signature: `0x${signatureHex || 'ab'.repeat(64)}` } };
    });

    const signer = new KmsEd25519Signer(KMS_URL, KEY_ID);
    const sig = await signer.sign(PAYLOAD);

    expect(sig.kind).toBe('hsm');
    expect(sig.signatureHex).toMatch(/^[0-9a-f]{128}$/);
    expect(sig.publicKeyHex).toBe(publicKeyHex);
    spy.mockRestore();
  });

  it('caches the public key across calls', async () => {
    let keyLookups = 0;
    const spy = mockFetch((url) => {
      if (url.includes('/public-key')) {
        keyLookups += 1;
        return { body: { publicKey: publicKeyHex } };
      }
      return { body: { signature: 'ab'.repeat(64) } };
    });

    const signer = new KmsEd25519Signer(KMS_URL, KEY_ID);
    await signer.sign(PAYLOAD);
    await signer.sign(PAYLOAD);

    expect(keyLookups).toBe(1);
    spy.mockRestore();
  });

  it('sends the bearer token when one is configured', async () => {
    const spy = mockFetch((url, init) => {
      if (url.includes('/public-key'))
        return { body: { publicKey: publicKeyHex } };
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer secret-token',
      );
      return { body: { signature: 'ab'.repeat(64) } };
    });

    await new KmsEd25519Signer(KMS_URL, KEY_ID, 'secret-token').sign(PAYLOAD);
    spy.mockRestore();
  });

  it('rejects a signature of the wrong width before it can be submitted', async () => {
    const spy = mockFetch((url) => {
      if (url.includes('/public-key'))
        return { body: { publicKey: publicKeyHex } };
      return { body: { signature: 'abcd' } };
    });

    await expect(
      new KmsEd25519Signer(KMS_URL, KEY_ID).sign(PAYLOAD),
    ).rejects.toThrow(/malformed signature/);
    spy.mockRestore();
  });

  it('rejects a public key of the wrong width', async () => {
    const spy = mockFetch(() => ({ body: { publicKey: 'aabb' } }));
    await expect(
      new KmsEd25519Signer(KMS_URL, KEY_ID).getPublicKeyHex(),
    ).rejects.toThrow(/malformed public key/);
    spy.mockRestore();
  });

  it('surfaces an HSM error status', async () => {
    const spy = mockFetch(() => ({ status: 503, body: {} }));
    await expect(
      new KmsEd25519Signer(KMS_URL, KEY_ID).sign(PAYLOAD),
    ).rejects.toThrow(/HSM signing failed: 503/);
    spy.mockRestore();
  });

  it('surfaces a missing signature field', async () => {
    const spy = mockFetch((url) =>
      url.includes('/public-key')
        ? { body: { publicKey: publicKeyHex } }
        : { body: {} },
    );
    await expect(
      new KmsEd25519Signer(KMS_URL, KEY_ID).sign(PAYLOAD),
    ).rejects.toThrow(/did not include a signature/);
    spy.mockRestore();
  });

  it('validates locally before spending an HSM signing operation', async () => {
    const spy = mockFetch(() => ({ body: {} }));
    await expect(
      new KmsEd25519Signer(KMS_URL, KEY_ID).sign({ ...PAYLOAD, callId: -1 }),
    ).rejects.toBeInstanceOf(ResolutionPayloadError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('drops the cached public key when rotated to a new key id', async () => {
    const keys = [
      naclKeyPair.publicKey,
      nacl.sign.keyPair.fromSeed(new Uint8Array(nacl.randomBytes(32)))
        .publicKey,
    ];
    let call = 0;
    const spy = mockFetch((url) => {
      if (url.includes('/public-key')) {
        const key = keys[Math.min(call, keys.length - 1)];
        call += 1;
        return { body: { publicKey: Buffer.from(key).toString('hex') } };
      }
      return { body: { signature: 'ab'.repeat(64) } };
    });

    const signer = new KmsEd25519Signer(KMS_URL, KEY_ID);
    const before = await signer.getPublicKeyHex();
    signer.rotate('new-key-id');
    const after = await signer.getPublicKeyHex();

    expect(after).not.toBe(before);
    spy.mockRestore();
  });
});

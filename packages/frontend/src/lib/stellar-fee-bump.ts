import { FeeBumpTransaction, Transaction } from '@stellar/stellar-sdk';

export interface SponsoredEnvelopeRequest {
  innerTransactionXdr: string;
  networkPassphrase: string;
  feeSource?: string;
}

export interface SponsoredTransactionResult {
  signedEnvelopeXdr: string;
  sponsored: boolean;
}

export function buildFeeBumpEnvelope(inner: Transaction, feeSource: string, baseFee = '100'): FeeBumpTransaction {
  if (!feeSource) throw new Error('A relayer fee source is required');
  const innerXdr = inner.toXDR();
  const feeBump = new FeeBumpTransaction(innerXdr, feeSource);
  feeBump.fee = baseFee;
  return feeBump;
}

export async function requestSponsoredEnvelope(transaction: Transaction, options: { endpoint?: string; networkPassphrase: string; signal?: AbortSignal }): Promise<string> {
  const endpoint = options.endpoint || '/wallet/sponsor-stellar-transaction';
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionXdr: transaction.toXDR(), networkPassphrase: options.networkPassphrase }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Sponsorship request failed (${response.status})`);
  const payload = await response.json() as { envelopeXdr?: string; signedEnvelopeXdr?: string; transactionXdr?: string };
  const envelope = payload.envelopeXdr || payload.signedEnvelopeXdr || payload.transactionXdr;
  if (!envelope) throw new Error('Sponsorship response did not include an envelope');
  return envelope;
}

export async function signSponsoredEnvelope(transaction: Transaction, signer: { signEnvelopeXdr: (xdr: string) => Promise<string> }, options: { networkPassphrase: string; endpoint?: string; signal?: AbortSignal }): Promise<SponsoredTransactionResult> {
  const sponsoredXdr = await requestSponsoredEnvelope(transaction, options);
  const signedEnvelopeXdr = await signer.signEnvelopeXdr(sponsoredXdr);
  return { signedEnvelopeXdr, sponsored: true };
}

export function isFeeBumpEnvelope(xdr: string): boolean {
  try {
    // Check if the XDR contains a fee bump by looking at the envelope type
    // A fee bump envelope has a different structure than a regular transaction
    const parsed = JSON.parse(Buffer.from(xdr, 'base64').toString());
    return parsed.switch?.name === 'envelopeTypeTxFeeBump';
  } catch {
    return false;
  }
}

/**
 * stellar-relayer.transport.ts  (BE-014)
 *
 * `SorobanRelayerTransport` — the @stellar/stellar-sdk implementation of the
 * relayer's network seam.
 *
 * Kept separate from `StellarRelayerService` so the retry/sequence/fee logic
 * can be tested without a node, and so deployments that only *read* chain
 * state never load the SDK.
 *
 * Encoding note
 * ─────────────
 * The contract takes `BytesN<32>` for the oracle key and `BytesN<64>` for the
 * signature. `nativeToScVal(..., { type: 'bytes' })` produces a variable-length
 * `Vec<u8>`, which the host rejects for a fixed-size argument, and
 * `Buffer.from(publicKey)` yields the 56-byte *strkey* rather than the 32 raw
 * key bytes. Both must be right or the invocation is rejected at simulation
 * time, before anything is signed.
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  RelayerAccountSnapshot,
  ResolutionSubmission,
  SequenceMismatchError,
  SorobanRelayerTransport,
} from './stellar-relayer.service';

/** How long to wait for a submitted transaction to reach a terminal state. */
const CONFIRMATION_TIMEOUT_MS = 60_000;
const CONFIRMATION_POLL_MS = 2_000;

/**
 * Fallback inclusion fee, in stroops.
 *
 * Used only when `getFeeStats` is unavailable; matches the SDK's own default
 * so a node that cannot answer does not push the relayer into refusing work.
 */
const DEFAULT_INCLUSION_FEE = 100;

export class StellarSdkRelayerTransport implements SorobanRelayerTransport {
  private readonly logger = new Logger(StellarSdkRelayerTransport.name);
  private readonly server: StellarSdk.rpc.Server;
  private readonly keypair: StellarSdk.Keypair;
  private readonly networkPassphrase: string;
  private readonly contract: StellarSdk.Contract;

  constructor(configService: ConfigService) {
    const secret = configService.get<string>('STELLAR_ORACLE_SECRET_KEY');
    if (!secret) {
      throw new Error('STELLAR_ORACLE_SECRET_KEY is required by the relayer');
    }
    const contractId = configService.get<string>(
      'STELLAR_OUTCOME_MANAGER_CONTRACT_ID',
    );
    if (!contractId) {
      throw new Error(
        'STELLAR_OUTCOME_MANAGER_CONTRACT_ID is required by the relayer',
      );
    }
    const rpcUrl =
      configService.get<string>('SOROBAN_RPC_URL') ??
      'https://soroban-testnet.stellar.org';

    this.keypair = StellarSdk.Keypair.fromSecret(secret);
    this.networkPassphrase = configService.get<string>(
      'STELLAR_NETWORK_PASSPHRASE',
      StellarSdk.Networks.TESTNET,
    );
    this.server = new StellarSdk.rpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith('http://'),
    });
    this.contract = new StellarSdk.Contract(contractId);
  }

  async loadAccount(): Promise<RelayerAccountSnapshot> {
    const account = await this.server.getAccount(this.keypair.publicKey());
    // The RPC Account object carries only the sequence; the native balance
    // has to be read separately.
    const balance = await this.server.getAssetBalance(
      this.keypair.publicKey(),
      StellarSdk.Asset.native(),
      this.networkPassphrase,
    );
    return {
      publicKey: account.accountId(),
      sequence: account.sequenceNumber(),
      balanceStroops: balance.balanceEntry?.amount ?? '0',
    };
  }

  /**
   * The network's current Soroban inclusion-fee market, in stroops.
   *
   * Read from `getFeeStats` rather than a ledger header: since Protocol 20
   * Soroban uses a dynamic fee market, and the classic `minFee` in a ledger
   * header says nothing about whether a contract invocation will be included.
   * `p50` is the median the market is currently clearing at, which is the
   * right reference for "what does inclusion cost right now".
   */
  async fetchMinFee(): Promise<number> {
    try {
      const stats = await this.server.getFeeStats();
      const raw = stats.sorobanInclusionFee?.p50 ?? stats.inclusionFee?.p50;
      const fee = Number(raw);
      return Number.isFinite(fee) && fee > 0 ? fee : DEFAULT_INCLUSION_FEE;
    } catch (err) {
      this.logger.warn(
        `getFeeStats unavailable (${(err as Error).message}); assuming the ` +
          'baseline inclusion fee',
      );
      return DEFAULT_INCLUSION_FEE;
    }
  }

  async sendOutcome(input: {
    contractId: string;
    account: RelayerAccountSnapshot;
    submission: ResolutionSubmission;
    feeStroops: number;
  }): Promise<{ txHash: string; surgeRatio: number }> {
    const contract = new StellarSdk.Contract(input.contractId);

    const invocation = contract.call(
      'submit_outcome',
      StellarSdk.nativeToScVal(BigInt(input.submission.callId), {
        type: 'u64',
      }),
      StellarSdk.nativeToScVal(input.submission.outcome, { type: 'bool' }),
      StellarSdk.nativeToScVal(BigInt(input.submission.finalPrice), {
        type: 'u128',
      }),
      StellarSdk.nativeToScVal(BigInt(input.submission.timestamp), {
        type: 'u64',
      }),
      // Raw 32 key bytes — not the 56-byte strkey.
      StellarSdk.nativeToScVal(input.submission.oraclePublicKey, {
        type: 'bytesN',
        size: 32,
      } as never),
      StellarSdk.nativeToScVal(input.submission.signature, {
        type: 'bytesN',
        size: 64,
      } as never),
    );

    // The account object carries the sequence the transaction must consume.
    const source = new StellarSdk.Account(
      input.account.publicKey,
      input.account.sequence,
    );
    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: String(input.feeStroops),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(invocation)
      .setTimeout(StellarSdk.TimeoutInfinite)
      .build();

    // Simulate before signing: a failure here means nothing is paid and
    // nothing is broadcast, which is exactly what we want for a bad payload.
    const simulation = await this.server.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(simulation)) {
      throw new Error(
        `Soroban simulation rejected the invocation: ${JSON.stringify(
          simulation.error,
        )}`,
      );
    }

    // Simulation reports the resource fee the network will actually charge. A
    // value above what we bid means the fee market moved while we built.
    const requiredFee = Number(
      (simulation as { minResourceFee?: string }).minResourceFee ??
        input.feeStroops,
    );
    if (requiredFee > input.feeStroops) {
      this.logger.warn(
        `simulation needs ${requiredFee} stroops of resource fee, built with ` +
          `${input.feeStroops} — resubmitting at the higher fee`,
      );
    }

    tx.sign(this.keypair);

    const result = await this.server.sendTransaction(tx);
    if (result.status === 'ERROR') {
      const detail = JSON.stringify(result.errorResult);
      if (/bad_seq/i.test(detail)) {
        throw new SequenceMismatchError(
          input.account.sequence,
          'unknown — see node error',
        );
      }
      throw new Error(`sendTransaction rejected: ${detail}`);
    }

    return { txHash: result.hash, surgeRatio: 1 };
  }

  async awaitConfirmation(
    txHash: string,
  ): Promise<{ success: boolean; error?: string }> {
    const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, CONFIRMATION_POLL_MS));
      const tx = await this.server.getTransaction(txHash);
      if (tx.status === StellarSdk.rpc.Api.GetTransactionStatus.NOT_FOUND) {
        continue;
      }
      if (tx.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
        return { success: true };
      }

      const detail = this.describeFailure(tx);
      // Losing the sequence race on-chain is recoverable, not fatal: the
      // relayer re-reads the account and resubmits under the fresh sequence.
      if (/bad_seq/i.test(detail)) {
        throw new SequenceMismatchError(txHash, 'failed on chain');
      }
      return {
        success: false,
        error: `transaction ${txHash} failed (${detail})`,
      };
    }
    return {
      success: false,
      error: `transaction ${txHash} not confirmed within ${CONFIRMATION_TIMEOUT_MS}ms`,
    };
  }

  /**
   * Best-effort human-readable description of a failed transaction.
   *
   * The xdr union shapes differ across SDK versions, so this reads defensively
   * rather than depending on a specific field layout.
   */
  private describeFailure(tx: unknown): string {
    const parts: string[] = [];
    const anyTx = tx as {
      resultXdr?: unknown;
      diagnosticEventsXdr?: unknown;
    };
    // xdr objects stringify to "[object Object]", so pull out the enum arm
    // names — which is also where the BadSeq code we need to detect lives.
    const armNames = (value: unknown): string[] => {
      if (value === null || value === undefined) return [];
      const name = (value as { name?: unknown }).name;
      return typeof name === 'string' ? [name] : [];
    };
    try {
      const result = anyTx.resultXdr as
        | { result?: { result?: { name?: string } } }
        | undefined;
      const names = armNames(result?.result?.result);
      if (names.length) parts.push(names.join('/'));
    } catch {
      /* unprintable xdr — fall through to the generic message */
    }
    try {
      if (Array.isArray(anyTx.diagnosticEventsXdr)) {
        const names = anyTx.diagnosticEventsXdr.flatMap((e) =>
          armNames((e as { inSorobanError?: unknown })?.inSorobanError),
        );
        if (names.length) parts.push(names.join('/'));
      }
    } catch {
      /* ignore */
    }
    return parts.length ? parts.join(' | ') : 'no diagnostic available';
  }
}

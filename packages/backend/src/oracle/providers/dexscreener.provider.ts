import { Injectable, Logger } from '@nestjs/common';
import { PriceProvider, PriceQuote } from './price-provider.interface';

const DEXSCREENER_TIMEOUT_MS = 2000;

interface DexScreenerTokensResponse {
  pairs?: Array<{
    chainId?: string;
    dexId?: string;
    priceUsd?: string;
    priceNatural?: string;
    baseToken?: { symbol?: string; address?: string };
    quoteToken?: { symbol?: string };
    volume?: { h24?: number };
    liquidity?: { usd?: number };
  }>;
}

@Injectable()
export class DexScreenerProvider implements PriceProvider {
  readonly name = 'dexscreener';

  private readonly logger = new Logger(DexScreenerProvider.name);

  async fetchQuote(symbol: string): Promise<PriceQuote | null> {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${symbol}`;

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(DEXSCREENER_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as DexScreenerTokensResponse;
      const pairs = (data?.pairs ?? []).filter(
        (pair) =>
          pair.baseToken?.symbol?.toUpperCase() === symbol.toUpperCase(),
      );

      let best: (typeof pairs)[number] | undefined;
      for (const pair of pairs) {
        if (!best || (pair.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) {
          best = pair;
        }
      }

      const priceUsd = best?.priceUsd ?? best?.priceNatural;
      if (!best || !priceUsd) {
        return null;
      }

      const price = Number(priceUsd);
      if (!Number.isFinite(price) || price <= 0) {
        return null;
      }

      return {
        source: this.name,
        price,
        volume24h: Number(best.volume?.h24 ?? 0),
        timestamp: Date.now(),
        symbol: symbol.toUpperCase(),
      };
    } catch (err) {
      this.logger.warn(
        `DexScreener fetchQuote failed for ${symbol}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

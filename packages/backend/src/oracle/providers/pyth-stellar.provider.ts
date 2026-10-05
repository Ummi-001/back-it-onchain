import { Injectable, Logger } from '@nestjs/common';
import { PriceProvider, PriceQuote } from './price-provider.interface';

const PYTH_TIMEOUT_MS = 2000;
const PYTH_HERMES_URL = 'https://hermes.pyth.network/v2/updates/price/latest';

const PYTH_FEED_IDS: Record<string, string> = {
  BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  XLM: '0xb7a8eba68a997cd0210c2e1e4ee811ad2d174b3611c22d9ebf16f4cb7e9ba850',
};

interface PythHermesResponse {
  parsed?: Array<{
    id: string;
    price: {
      price: string;
      conf: string;
      expo: number;
      publish_time: number;
    };
  }>;
}

@Injectable()
export class PythStellarProvider implements PriceProvider {
  readonly name = 'pyth-stellar';

  private readonly logger = new Logger(PythStellarProvider.name);

  async fetchQuote(symbol: string): Promise<PriceQuote | null> {
    const feedId = PYTH_FEED_IDS[symbol.toUpperCase()];
    if (!feedId) {
      return null;
    }

    const url = `${PYTH_HERMES_URL}?ids[]=${feedId}`;

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(PYTH_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as PythHermesResponse;
      const entry = data?.parsed?.[0];
      if (!entry?.price) {
        return null;
      }

      const rawPrice = Number(entry.price.price);
      const expo = entry.price.expo;
      if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
        return null;
      }

      const price = rawPrice * Math.pow(10, expo);
      const publishTimeMs = entry.price.publish_time * 1000;

      return {
        source: this.name,
        price,
        volume24h: 0,
        timestamp: publishTimeMs,
        symbol: symbol.toUpperCase(),
      };
    } catch (err) {
      this.logger.warn(
        `Pyth Hermes fetchQuote failed for ${symbol}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

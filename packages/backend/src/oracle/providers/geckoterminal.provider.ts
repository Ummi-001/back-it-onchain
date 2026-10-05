import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PriceProvider, PriceQuote } from './price-provider.interface';

const GECKOTERMINAL_TIMEOUT_MS = 2000;

interface GeckoTerminalTokenResponse {
  data?: {
    attributes?: {
      token_prices?: Record<string, string>;
    };
  };
}

@Injectable()
export class GeckoTerminalProvider implements PriceProvider {
  readonly name = 'geckoterminal';

  private readonly logger = new Logger(GeckoTerminalProvider.name);

  constructor(private readonly configService: ConfigService) {}

  async fetchQuote(symbol: string): Promise<PriceQuote | null> {
    const network =
      this.configService.get<string>('GECKOTERMINAL_NETWORK', 'base') ?? 'base';
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${symbol}/price`;

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(GECKOTERMINAL_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as GeckoTerminalTokenResponse;
      const raw = data?.data?.attributes?.token_prices?.[symbol.toLowerCase()];
      if (!raw) {
        return null;
      }

      const price = Number(raw);
      if (!Number.isFinite(price) || price <= 0) {
        return null;
      }

      return {
        source: this.name,
        price,
        volume24h: 0,
        timestamp: Date.now(),
        symbol: symbol.toUpperCase(),
      };
    } catch (err) {
      this.logger.warn(
        `GeckoTerminal fetchQuote failed for ${symbol}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

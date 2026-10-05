/**
 * redis.module.ts
 *
 * Exports `RedisClientProvider` so that more than one module can depend on the
 * single shared Redis connection without each opening its own.
 *
 * Before this existed, `RedisClientProvider` was listed in the providers of
 * several modules. Nest scopes providers per module, so each of those modules
 * built its own client and its own fallback stub — meaning a relayer's
 * sequence mutex and the indexer's leader lock could not see each other, and
 * every module paid for a redundant connection.
 */
import { Module } from '@nestjs/common';
import { RedisClientProvider } from './redis.config';

@Module({
  providers: [RedisClientProvider],
  exports: [RedisClientProvider],
})
export class RedisModule {}

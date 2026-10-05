import { Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { OracleModule } from '../oracle/oracle.module';

@Module({
  imports: [OracleModule],
  controllers: [TokensController],
  providers: [TokensService],
})
export class TokensModule {}

import { Global, Module } from '@nestjs/common';
import { ContractStatusService } from './contract-status.service';

@Global()
@Module({
  providers: [ContractStatusService],
  exports: [ContractStatusService],
})
export class ContractStatusModule {}

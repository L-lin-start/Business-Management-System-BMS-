import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProjectModule } from '../projects/project.module';
import { ContractController, TimeLimitAdminController } from './contract.controller';
import { ContractService } from './contract.service';
import { ContractStatusModule } from './contract-status.module';
import { TimeLimitService } from './time-limit.service';

@Module({
  imports: [AuthModule, ProjectModule, ContractStatusModule],
  controllers: [ContractController, TimeLimitAdminController],
  providers: [ContractService, TimeLimitService],
  exports: [ContractService, TimeLimitService],
})
export class ContractModule {}

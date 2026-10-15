import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OptionsAdminController } from './options-admin.controller';
import { OptionsController } from './options.controller';
import { OptionsService } from './options.service';

/** OptionsService 需要给合同/项目模块做类型校验，故设为全局模块并导出 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [OptionsController, OptionsAdminController],
  providers: [OptionsService],
  exports: [OptionsService],
})
export class OptionsModule {}

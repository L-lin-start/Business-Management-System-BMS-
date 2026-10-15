import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReminderConfigController, ReminderController } from './reminder.controller';
import { ReminderService } from './reminder.service';

/** ReminderService 导出给首页看板使用 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [ReminderController, ReminderConfigController],
  providers: [ReminderService],
  exports: [ReminderService],
})
export class ReminderModule {}

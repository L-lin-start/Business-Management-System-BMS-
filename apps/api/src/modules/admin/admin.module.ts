import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [AdminService],
  // 导出给「已删除数据」模块：恢复用户账号必须走 AdminService.restoreUser，
  // 它负责"不还原角色与部门"这条业务规则，直接 update 会绕过它。
  exports: [AdminService],
})
export class AdminModule {}

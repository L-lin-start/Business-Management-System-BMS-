import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ProjectAccessScopeService } from './project-access-scope.service';

/**
 * 项目及其附属数据的统一数据范围模块。
 *
 * 项目、流程、四类记录、附件和回款都必须复用这里，避免各模块各写一套范围规则。
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [ProjectAccessScopeService],
  exports: [ProjectAccessScopeService],
})
export class ProjectAccessScopeModule {}

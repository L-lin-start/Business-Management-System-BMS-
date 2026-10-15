import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { OptionsService, parseOptionModule } from './options.service';

@Controller('api/options')
@UseGuards(AccessTokenGuard)
export class OptionsController {
  constructor(@Inject(OptionsService) private readonly optionsService: OptionsService) {}

  /** 读取启用中的状态枚举（合同、项目等），供系统 A 下拉框与标签使用 */
  @Get('statuses')
  listStatuses() {
    return this.optionsService.listStatuses();
  }

  /** 读取某模块的下拉选项（合同类型、项目类型） */
  @Get('list/:moduleKey')
  listOptions(@Param('moduleKey') moduleKey: string) {
    return this.optionsService.listOptions(parseOptionModule(moduleKey));
  }

  /** 读取某模块的自定义字段定义，供系统 A 动态渲染录入表单与列表列 */
  @Get('fields/:moduleKey')
  listCustomFields(@Param('moduleKey') moduleKey: string) {
    return this.optionsService.listCustomFields(moduleKey);
  }
}

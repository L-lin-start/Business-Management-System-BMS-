import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DataScope } from '@prisma/client';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { DeleteReasonDto, RestoreReasonDto } from '../../infrastructure/delete/delete-reason.dto';
import { CustomerService } from './customer.service';
import { CreateCustomerDto, CustomerQueryDto, UpdateCustomerDto } from './dto/customer.dto';

@Controller('api/customers')
@UseGuards(AccessTokenGuard, PermissionGuard)
export class CustomerController {
  constructor(@Inject(CustomerService) private readonly customerService: CustomerService) {}

  @Get()
  @RequirePermission('customer.read')
  list(@Query() query: CustomerQueryDto, @Req() request: AuthenticatedRequest) {
    return this.customerService.list(query, request.auth.userId, this.scope(request));
  }

  @Get('owners')
  @RequirePermission('customer.read')
  listOwners() {
    return this.customerService.listOwners();
  }

  /**
   * 字段锁定规则：告诉前端「新建/编辑客户时，哪些字段不让填」。
   *
   * 为什么做成接口而不是前端自己判断角色：规则只应该在服务端定义一处，
   * 前端照做即可；否则前端按角色名硬编码判断，改了角色配置就会不一致。
   * 这也是 PRD 3.3「字段级权限」的落地点。
   *
   * 注意：必须声明在 @Get(':id') 之前，否则会被 :id 路由吃掉。
   */
  @Get('form-policy')
  @RequirePermission('customer.read')
  formPolicy(@Req() request: AuthenticatedRequest) {
    return this.customerService.formPolicy(request.auth.userId);
  }

  @Get(':id')
  @RequirePermission('customer.read')
  getById(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.customerService.getById(id, request.auth.userId, this.scope(request));
  }

  @Post()
  @RequirePermission('customer.manage')
  create(@Body() input: CreateCustomerDto, @Req() request: AuthenticatedRequest) {
    return this.customerService.create(input, request.auth.userId);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customer.manage')
  update(@Param('id') id: string, @Body() input: UpdateCustomerDto, @Req() request: AuthenticatedRequest) {
    return this.customerService.update(id, input, request.auth.userId, this.scope(request));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customer.delete')
  softDelete(@Param('id') id: string, @Body() body: DeleteReasonDto, @Req() request: AuthenticatedRequest) {
    return this.customerService.softDelete(id, request.auth.userId, this.scope(request), body.reason);
  }

  /** 恢复已删除的客户（PRD 7.1：仅管理员可恢复） */
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('system.admin.access')
  restore(@Param('id') id: string, @Body() body: RestoreReasonDto, @Req() request: AuthenticatedRequest) {
    return this.customerService.restore(id, request.auth.userId, body.reason);
  }

  private scope(request: AuthenticatedRequest) {
    return (request.auth.permissionScope ?? 'NONE') as DataScope;
  }
}

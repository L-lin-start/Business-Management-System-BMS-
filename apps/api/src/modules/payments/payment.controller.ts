import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DataScope } from '@prisma/client';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { DeleteReasonDto, RestoreReasonDto } from '../../infrastructure/delete/delete-reason.dto';
import { CreatePaymentDto, PaymentQueryDto, UpdatePaymentDto } from './dto/payment.dto';
import { PaymentService } from './payment.service';

@Controller('api/payments')
@UseGuards(AccessTokenGuard, PermissionGuard)
export class PaymentController {
  constructor(@Inject(PaymentService) private readonly paymentService: PaymentService) {}

  @Get()
  @RequirePermission('payment.manage')
  list(@Query() query: PaymentQueryDto, @Req() request: AuthenticatedRequest) { return this.paymentService.list(query, request.auth.userId, this.scope(request)); }

  @Get(':id')
  @RequirePermission('payment.manage')
  getById(@Param('id') id: string, @Req() request: AuthenticatedRequest) { return this.paymentService.getById(id, request.auth.userId, this.scope(request)); }

  @Post()
  @RequirePermission('payment.manage')
  create(@Body() input: CreatePaymentDto, @Req() request: AuthenticatedRequest) { return this.paymentService.create(input, request.auth.userId, this.scope(request)); }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payment.manage')
  update(@Param('id') id: string, @Body() input: UpdatePaymentDto, @Req() request: AuthenticatedRequest) { return this.paymentService.update(id, input, request.auth.userId, this.scope(request)); }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payment.manage')
  softDelete(@Param('id') id: string, @Body() body: DeleteReasonDto, @Req() request: AuthenticatedRequest) { return this.paymentService.softDelete(id, request.auth.userId, this.scope(request), body.reason); }

  /** 恢复已删除的回款（PRD 7.1：仅管理员可恢复） */
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('system.admin.access')
  restore(@Param('id') id: string, @Body() body: RestoreReasonDto, @Req() request: AuthenticatedRequest) { return this.paymentService.restore(id, request.auth.userId, body.reason); }

  private scope(request: AuthenticatedRequest) { return (request.auth.permissionScope ?? 'NONE') as DataScope; }
}

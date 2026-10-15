import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DataScope } from '@prisma/client';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import {
  ActionRecordService,
  FilingResultService,
  MailDeliveryService,
  OfficialDocumentService,
} from './record.service';
import {
  ActionRecordQueryDto,
  CreateActionRecordDto,
  CreateFilingResultDto,
  CreateMailDeliveryDto,
  CreateOfficialDocumentDto,
  FilingResultQueryDto,
  MailDeliveryQueryDto,
  OfficialDocumentQueryDto,
  RemoveRecordDto,
  UpdateActionRecordDto,
  UpdateFilingResultDto,
  UpdateMailDeliveryDto,
  UpdateOfficialDocumentDto,
} from './dto/record.dto';

/**
 * 附属业务数据的接口（PRD 2.2）：官文管理、邮件送达登记、动作记录、申报结果记录。
 *
 * 四类记录统一挂在这个控制器下，按资源路径分区：
 *   /api/records/official-documents
 *   /api/records/mail-deliveries
 *   /api/records/action-records
 *   /api/records/filing-results
 *
 * 权限：每类独立三个权限点（read / manage / delete），数据范围复用 RecordScopeService。
 * 删除一律要求填写原因（PRD 第七章）。
 */
@Controller('api/records')
@UseGuards(AccessTokenGuard, PermissionGuard)
export class RecordController {
  constructor(
    @Inject(OfficialDocumentService) private readonly officialDocuments: OfficialDocumentService,
    @Inject(MailDeliveryService) private readonly mailDeliveries: MailDeliveryService,
    @Inject(ActionRecordService) private readonly actionRecords: ActionRecordService,
    @Inject(FilingResultService) private readonly filingResults: FilingResultService,
  ) {}

  /* ------------------------------ 官文 ------------------------------ */

  @Get('official-documents')
  @RequirePermission('official_document.read')
  listOfficialDocuments(@Query() query: OfficialDocumentQueryDto, @Req() request: AuthenticatedRequest) {
    return this.officialDocuments.list(query, request.auth.userId, this.scope(request));
  }

  @Get('official-documents/:id')
  @RequirePermission('official_document.read')
  getOfficialDocument(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.officialDocuments.getById(id, request.auth.userId, this.scope(request));
  }

  @Post('official-documents')
  @RequirePermission('official_document.manage')
  createOfficialDocument(@Body() input: CreateOfficialDocumentDto, @Req() request: AuthenticatedRequest) {
    return this.officialDocuments.create(input, request.auth.userId, this.scope(request));
  }

  @Patch('official-documents/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('official_document.manage')
  updateOfficialDocument(@Param('id') id: string, @Body() input: UpdateOfficialDocumentDto, @Req() request: AuthenticatedRequest) {
    return this.officialDocuments.update(id, input, request.auth.userId, this.scope(request));
  }

  @Delete('official-documents/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('official_document.delete')
  removeOfficialDocument(@Param('id') id: string, @Body() input: RemoveRecordDto, @Req() request: AuthenticatedRequest) {
    return this.officialDocuments.remove(id, request.auth.userId, this.scope(request), input?.reason);
  }

  /* ---------------------------- 邮件送达 ---------------------------- */

  @Get('mail-deliveries')
  @RequirePermission('mail_delivery.read')
  listMailDeliveries(@Query() query: MailDeliveryQueryDto, @Req() request: AuthenticatedRequest) {
    return this.mailDeliveries.list(query, request.auth.userId, this.scope(request));
  }

  @Get('mail-deliveries/:id')
  @RequirePermission('mail_delivery.read')
  getMailDelivery(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.mailDeliveries.getById(id, request.auth.userId, this.scope(request));
  }

  @Post('mail-deliveries')
  @RequirePermission('mail_delivery.manage')
  createMailDelivery(@Body() input: CreateMailDeliveryDto, @Req() request: AuthenticatedRequest) {
    return this.mailDeliveries.create(input, request.auth.userId, this.scope(request));
  }

  @Patch('mail-deliveries/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('mail_delivery.manage')
  updateMailDelivery(@Param('id') id: string, @Body() input: UpdateMailDeliveryDto, @Req() request: AuthenticatedRequest) {
    return this.mailDeliveries.update(id, input, request.auth.userId, this.scope(request));
  }

  @Delete('mail-deliveries/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('mail_delivery.delete')
  removeMailDelivery(@Param('id') id: string, @Body() input: RemoveRecordDto, @Req() request: AuthenticatedRequest) {
    return this.mailDeliveries.remove(id, request.auth.userId, this.scope(request), input?.reason);
  }

  /* ---------------------------- 动作记录 ---------------------------- */

  @Get('action-records')
  @RequirePermission('action_record.read')
  listActionRecords(@Query() query: ActionRecordQueryDto, @Req() request: AuthenticatedRequest) {
    return this.actionRecords.list(query, request.auth.userId, this.scope(request));
  }

  @Post('action-records')
  @RequirePermission('action_record.manage')
  createActionRecord(@Body() input: CreateActionRecordDto, @Req() request: AuthenticatedRequest) {
    return this.actionRecords.create(input, request.auth.userId, this.scope(request));
  }

  @Patch('action-records/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('action_record.manage')
  updateActionRecord(@Param('id') id: string, @Body() input: UpdateActionRecordDto, @Req() request: AuthenticatedRequest) {
    return this.actionRecords.update(id, input, request.auth.userId, this.scope(request));
  }

  @Delete('action-records/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('action_record.delete')
  removeActionRecord(@Param('id') id: string, @Body() input: RemoveRecordDto, @Req() request: AuthenticatedRequest) {
    return this.actionRecords.remove(id, request.auth.userId, this.scope(request), input?.reason);
  }

  /* --------------------------- 申报结果记录 --------------------------- */

  @Get('filing-results')
  @RequirePermission('filing_result.read')
  listFilingResults(@Query() query: FilingResultQueryDto, @Req() request: AuthenticatedRequest) {
    return this.filingResults.list(query, request.auth.userId, this.scope(request));
  }

  @Post('filing-results')
  @RequirePermission('filing_result.manage')
  createFilingResult(@Body() input: CreateFilingResultDto, @Req() request: AuthenticatedRequest) {
    return this.filingResults.create(input, request.auth.userId, this.scope(request));
  }

  @Patch('filing-results/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('filing_result.manage')
  updateFilingResult(@Param('id') id: string, @Body() input: UpdateFilingResultDto, @Req() request: AuthenticatedRequest) {
    return this.filingResults.update(id, input, request.auth.userId, this.scope(request));
  }

  @Delete('filing-results/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('filing_result.delete')
  removeFilingResult(@Param('id') id: string, @Body() input: RemoveRecordDto, @Req() request: AuthenticatedRequest) {
    return this.filingResults.remove(id, request.auth.userId, this.scope(request), input?.reason);
  }

  private scope(request: AuthenticatedRequest) {
    return (request.auth.permissionScope ?? 'NONE') as DataScope;
  }
}

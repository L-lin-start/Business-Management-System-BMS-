import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { DeleteReasonDto, RestoreReasonDto } from '../../infrastructure/delete/delete-reason.dto';
import { AdminService } from './admin.service';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';
import { CreateRoleDto, UpdateRoleDto, UpdateRolePermissionsDto } from './dto/role.dto';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { CreateFieldDefinitionDto, FieldDefinitionQueryDto, UpdateFieldDefinitionDto } from './dto/field-definition.dto';

/**
 * 管理系统接口按 `system.admin.access` 权限点控制（PRD 3.2：权限在系统 B 配置，
 * 系统 A 按权限展示和操作），不再要求账号必须是 isSystemAdmin。
 */
@Controller('api/admin')
@UseGuards(AccessTokenGuard, PermissionGuard)
@RequirePermission('system.admin.access')
export class AdminController {
  constructor(@Inject(AdminService) private readonly adminService: AdminService) {}

  @Get('departments/tree')
  listDepartmentTree() {
    return this.adminService.listDepartmentTree();
  }

  @Post('departments')
  createDepartment(@Body() input: CreateDepartmentDto, @Req() request: AuthenticatedRequest) {
    return this.adminService.createDepartment(input, request.auth.userId);
  }

  @Patch('departments/:id')
  @HttpCode(HttpStatus.OK)
  updateDepartment(@Param('id') id: string, @Body() input: UpdateDepartmentDto, @Req() request: AuthenticatedRequest) {
    return this.adminService.updateDepartment(id, input, request.auth.userId);
  }

  /**
   * 删除部门。
   * 有子部门或成员时会被拒绝（409）并说明原因；根部门与最后一个部门不允许删除。
   */
  @Delete('departments/:id')
  @HttpCode(HttpStatus.OK)
  deleteDepartment(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.adminService.deleteDepartment(id, request.auth.userId);
  }

  @Get('users')
  listUsers() {
    return this.adminService.listUsers();
  }

  @Post('users')
  createUser(@Body() input: CreateUserDto, @Req() request: AuthenticatedRequest) {
    return this.adminService.createUser(input, request.auth.userId);
  }

  @Patch('users/:id')
  @HttpCode(HttpStatus.OK)
  updateUser(@Param('id') id: string, @Body() input: UpdateUserDto, @Req() request: AuthenticatedRequest) {
    return this.adminService.updateUser(id, input, request.auth.userId);
  }

  /**
   * 删除用户账号（软删除，需填删除原因）。
   *
   * 防呆规则见 AdminService.deleteUser：不能删自己、不能删系统管理员、
   * 至少保留一个启用中的管理员。
   */
  @Delete('users/:id')
  @HttpCode(HttpStatus.OK)
  deleteUser(@Param('id') id: string, @Body() body: DeleteReasonDto, @Req() request: AuthenticatedRequest) {
    return this.adminService.deleteUser(id, body.reason, request.auth.userId);
  }

  /** 恢复被删除的用户账号（角色与部门需重新分配，详见 AdminService.restoreUser） */
  @Post('users/:id/restore')
  @HttpCode(HttpStatus.OK)
  restoreUser(@Param('id') id: string, @Body() body: RestoreReasonDto, @Req() request: AuthenticatedRequest) {
    return this.adminService.restoreUser(id, request.auth.userId, body.reason);
  }

  @Get('roles')
  listRoles() {
    return this.adminService.listRoles();
  }

  @Post('roles')
  createRole(@Body() input: CreateRoleDto, @Req() request: AuthenticatedRequest) {
    return this.adminService.createRole(input, request.auth.userId);
  }

  @Patch('roles/:id')
  @HttpCode(HttpStatus.OK)
  updateRole(@Param('id') id: string, @Body() input: UpdateRoleDto, @Req() request: AuthenticatedRequest) {
    return this.adminService.updateRole(id, input, request.auth.userId);
  }

  @Get('permissions')
  listPermissions() {
    return this.adminService.listPermissions();
  }

  @Put('roles/:id/permissions')
  @HttpCode(HttpStatus.OK)
  updateRolePermissions(@Param('id') id: string, @Body() input: UpdateRolePermissionsDto, @Req() request: AuthenticatedRequest) {
    return this.adminService.updateRolePermissions(id, input, request.auth.userId);
  }

  @Get('audit-logs')
  listAuditLogs() {
    return this.adminService.listAuditLogs();
  }

  @Get('field-definitions')
  listFieldDefinitions(@Query() query: FieldDefinitionQueryDto) {
    return this.adminService.listFieldDefinitions(query.moduleKey);
  }

  @Post('field-definitions')
  createFieldDefinition(@Body() input: CreateFieldDefinitionDto, @Req() request: AuthenticatedRequest) {
    return this.adminService.createFieldDefinition(input, request.auth.userId);
  }

  @Patch('field-definitions/:id')
  @HttpCode(HttpStatus.OK)
  updateFieldDefinition(@Param('id') id: string, @Body() input: UpdateFieldDefinitionDto, @Req() request: AuthenticatedRequest) {
    return this.adminService.updateFieldDefinition(id, input, request.auth.userId);
  }

  @Delete('field-definitions/:id')
  @HttpCode(HttpStatus.OK)
  deleteFieldDefinition(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.adminService.deleteFieldDefinition(id, request.auth.userId);
  }
}

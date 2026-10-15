import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AuthenticatedRequest } from './access-token.guard';
import { PERMISSION_CODE_KEY } from './permission.decorator';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const permissionCode = this.reflector.getAllAndOverride<string>(PERMISSION_CODE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permissionCode) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = await this.prisma.user.findFirst({
      where: { id: request.auth.userId, status: 'ACTIVE', deletedAt: null },
      select: { isSystemAdmin: true },
    });
    if (!user) throw new ForbiddenException('当前账号不可用');

    if (user.isSystemAdmin) {
      request.auth.permissionScope = 'ALL';
      return true;
    }

    const permissions = await this.prisma.rolePermission.findMany({
      where: {
        allowed: true,
        permission: { code: permissionCode },
        role: { isActive: true, users: { some: { userId: request.auth.userId } } },
      },
      select: { dataScope: true },
    });
    const scopeOrder = ['ALL', 'DEPARTMENT_AND_DESCENDANTS', 'DEPARTMENT', 'RELATED', 'SELF', 'NONE'];
    const permission = permissions.sort((left, right) => scopeOrder.indexOf(left.dataScope) - scopeOrder.indexOf(right.dataScope))[0];
    if (!permission || permission.dataScope === 'NONE') {
      throw new ForbiddenException('无权执行此操作');
    }

    request.auth.permissionScope = permission.dataScope;
    return true;
  }
}

import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {}

  async login(input: LoginDto) {
    this.assertDatabaseEnabled();

    const user = await this.prisma.user.findFirst({
      where: {
        username: input.username,
        status: 'ACTIVE',
        deletedAt: null,
      },
      include: {
        roles: {
          include: {
            role: {
              select: {
                code: true,
                name: true,
              },
            },
          },
        },
        departments: {
          include: {
            department: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
        },
      },
    });

    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      username: user.username,
      roles: user.roles.map(({ role }) => role.code),
    });

    return {
      accessToken,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        isSystemAdmin: user.isSystemAdmin,
        roles: user.roles.map(({ role }) => role),
        departments: user.departments.map(({ department }) => department),
        permissions: await this.resolvePermissions(user.id, user.isSystemAdmin),
      },
    };
  }

  async getCurrentUser(userId: string) {
    this.assertDatabaseEnabled();

    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
        deletedAt: null,
      },
      include: {
        roles: {
          include: {
            role: { select: { code: true, name: true } },
          },
        },
        departments: {
          include: {
            department: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });

    if (!user) throw new UnauthorizedException('用户不存在或已停用');

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      isSystemAdmin: user.isSystemAdmin,
      roles: user.roles.map(({ role }) => role),
      departments: user.departments.map(({ department }) => department),
      permissions: await this.resolvePermissions(user.id, user.isSystemAdmin),
      // 供界面说明「你看到的是自己范围内的数据」；真正的判定仍在守卫与服务层
      dataScope: await this.resolveDataScope(user.id, user.isSystemAdmin),
    };
  }

  /**
   * 当前用户的有效权限点编码。系统 A 用它决定菜单/按钮是否可见，
   * 真正的拦截仍在后端守卫里做（PRD：权限在系统 B 配置，系统 A 按权限展示和操作）。
   */
  private async resolvePermissions(userId: string, isSystemAdmin: boolean): Promise<string[]> {
    if (isSystemAdmin) {
      const all = await this.prisma.permission.findMany({ select: { code: true } });
      return all.map((item) => item.code);
    }

    const rows = await this.prisma.rolePermission.findMany({
      where: {
        allowed: true,
        role: { isActive: true, users: { some: { userId } } },
      },
      select: { permission: { select: { code: true } } },
    });
    return [...new Set(rows.map((row) => row.permission.code))];
  }

  /**
   * 当前用户的**总体数据范围**（所有已授权限里最宽的那个）。
   *
   * 为什么要暴露给前端：实际的数据范围是**按请求、按权限点**解析的
   * （见 PermissionGuard），所以接口本身已经在按范围过滤 ——
   * 但界面上没有任何地方说明这件事。
   *
   * 后果是用户会困惑：销售在「提醒」里看到 10 条而管理员看到 25 条，
   * 屏幕上却没有一句话解释"你只看得到自己负责的"。这里给出一个总体判定，
   * 供界面显示"仅显示与您相关的数据"这类说明。
   *
   * 注意：它是"最宽的一个"，只能用于**展示说明**，不能当作权限判定依据 ——
   * 判定必须继续走 PermissionGuard + 各服务的 buildXxxWhere。
   */
  private async resolveDataScope(userId: string, isSystemAdmin: boolean): Promise<string> {
    if (isSystemAdmin) return 'ALL';
    const rows = await this.prisma.rolePermission.findMany({
      where: { allowed: true, role: { isActive: true, users: { some: { userId } } } },
      select: { dataScope: true },
    });
    const order = ['ALL', 'DEPARTMENT_AND_DESCENDANTS', 'DEPARTMENT', 'RELATED', 'SELF', 'NONE'];
    return rows
      .map((row) => row.dataScope)
      .sort((left, right) => order.indexOf(left) - order.indexOf(right))[0] ?? 'NONE';
  }

  private assertDatabaseEnabled() {
    if (this.configService.get('BMS_DATABASE_ENABLED') !== 'true') {
      throw new ServiceUnavailableException('本地数据库尚未启用，请先配置 DATABASE_URL');
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/** 不受节点分派限制的角色：可以推进任意节点（应急、纠错） */
export const NODE_ASSIGNEE_BYPASS_ROLES = ['SYSTEM_ADMIN', 'GENERAL_MANAGER'] as const;

/** 单个节点负责人的可读信息，供界面展示 */
export type NodeAssigneeDisplay = {
  /** 配置的负责人类型；目前只支持 ROLE */
  assigneeType: string | null;
  /** 配置的负责人标识（角色编码） */
  assigneeId: string | null;
  /** 角色可读名称，例如「专利代理人」；查不到时回退为编码 */
  roleName: string | null;
  /** 该角色下**在职**人员的姓名，界面直接展示"归谁办" */
  userNames: string[];
  /** 该角色下在职人数 */
  activeUserCount: number;
  /** 组装好的展示文案，例如「专利代理人（专利代理）」 */
  label: string;
  /**
   * 该节点是否处于"无人负责"状态：没配负责人、角色不存在/已停用、或角色下没有在职人员。
   * 这种节点不限制谁能推进（否则会把流程卡死），但界面上要提醒去配置。
   */
  unassigned: boolean;
};

type NodeLike = { assigneeType: string | null; assigneeId: string | null };

/**
 * 流程节点负责人解析与校验。
 *
 * 规则（业务确认 2026-10-14）：
 *   - 节点按**角色**指定负责人，该角色下所有在职人员都能处理该节点；
 *   - 推进节点时校验"你是不是**当前节点**的负责人"，不是就拒绝并说明归谁办；
 *   - 系统管理员与总经理**不受分派限制**，可推进任意节点（应急、纠错）；
 *   - 当前节点没配负责人（或角色下无人在职）时不限制，避免把流程卡死。
 *
 * 语义：由"当前节点的负责人"完成该节点并推进到下一步（交接给下一位）。
 */
@Injectable()
export class NodeAssigneeService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 当前用户是否为不受分派限制的管理角色 */
  async isBypassRole(userId: string): Promise<boolean> {
    const count = await this.prisma.userRole.count({
      where: {
        userId,
        role: { code: { in: [...NODE_ASSIGNEE_BYPASS_ROLES] }, isActive: true },
      },
    });
    return count > 0;
  }

  /** 当前用户持有的启用角色编码集合 */
  async readRoleCodes(userId: string): Promise<string[]> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId, role: { isActive: true } },
      select: { role: { select: { code: true } } },
    });
    return roles.map((item) => item.role.code);
  }

  /**
   * 批量给节点补上负责人可读信息。
   * 一次性把角色与在职人员查出来再内存匹配，避免按节点逐条查询（N+1）。
   */
  async decorateNodes<T extends NodeLike>(nodes: T[]): Promise<(T & { assignee: NodeAssigneeDisplay })[]> {
    const roles = await this.prisma.role.findMany({
      where: { isActive: true },
      select: {
        code: true,
        name: true,
        users: {
          where: { user: { status: 'ACTIVE' } },
          select: { user: { select: { displayName: true, username: true } } },
        },
      },
    });

    const roleNameByCode = new Map(roles.map((role) => [role.code, role.name]));
    const usersByRoleCode = new Map<string, string[]>();
    for (const role of roles) {
      usersByRoleCode.set(
        role.code,
        role.users.map((item) => item.user.displayName || item.user.username),
      );
    }

    return nodes.map((node) => {
      const code = node.assigneeId;
      const userNames = code ? (usersByRoleCode.get(code) ?? []) : [];
      const roleName = code ? (roleNameByCode.get(code) ?? code) : null;
      // 未配负责人、角色不存在或已停用、角色下没有在职人员 → 视为无人负责
      const unassigned = !code || !roleNameByCode.has(code) || userNames.length === 0;
      const label = node.assigneeType === 'ROLE' && roleName && !unassigned
        ? `${roleName}（${userNames.join('、')}）`
        : '未指定负责人';
      return {
        ...node,
        assignee: {
          assigneeType: node.assigneeType,
          assigneeId: node.assigneeId,
          roleName,
          userNames,
          activeUserCount: userNames.length,
          label,
          unassigned,
        },
      };
    });
  }

  /**
   * 校验当前用户能否推进处于该节点的项目。
   * @param currentNode 项目当前所在节点；为 null 表示尚未进入任何节点
   * @returns canTransition 是否允许；reason 不允许时的说明（可直接展示给用户）
   */
  async checkTransitionPermission(
    userId: string,
    currentNode: NodeLike | null,
  ): Promise<{ canTransition: boolean; reason: string | null; bypassed: boolean }> {
    // 尚未进入任何节点：由项目负责人/管理员起步，不做分派校验
    if (!currentNode) return { canTransition: true, reason: null, bypassed: false };

    // 节点没配负责人：不限制（否则流程会卡死）
    if (!currentNode.assigneeType || !currentNode.assigneeId) {
      return { canTransition: true, reason: null, bypassed: false };
    }

    if (await this.isBypassRole(userId)) {
      return { canTransition: true, reason: null, bypassed: true };
    }

    // 角色必须真实存在、启用、且有人在职，否则视为无人负责（不限制）
    const role = await this.prisma.role.findFirst({
      where: { code: currentNode.assigneeId, isActive: true },
      select: {
        name: true,
        users: { where: { user: { status: 'ACTIVE' } }, select: { userId: true } },
      },
    });
    if (!role || role.users.length === 0) {
      return { canTransition: true, reason: null, bypassed: false };
    }
    if (role.users.some((item) => item.userId === userId)) {
      return { canTransition: true, reason: null, bypassed: false };
    }

    return {
      canTransition: false,
      reason: `当前节点由「${role.name}」负责，你的角色不能推进。如需代推，请联系系统管理员或总经理。`,
      bypassed: false,
    };
  }
}

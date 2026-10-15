import { PrismaService } from '../../infrastructure/database/prisma.service';

/** 当前用户持有的启用角色编码 */
export async function readActiveRoleCodes(prisma: PrismaService, userId: string): Promise<string[]> {
  const roles = await prisma.userRole.findMany({
    where: { userId, role: { isActive: true } },
    select: { role: { select: { code: true } } },
  });
  return roles.map((item) => item.role.code);
}

/**
 * 「我负责的节点」对应的节点编码集合。
 *
 * 只取节点**编码**（而不是在查询里拼 jsonb 原始 SQL），这样 Prisma 能生成类型安全的
 * `currentNodeCode IN (...)` 条件。
 */
export async function resolveAssignedNodeCodes(prisma: PrismaService, roleCodes: string[]): Promise<string[]> {
  if (roleCodes.length === 0) return [];
  const nodes = await prisma.workflowNode.findMany({
    where: { assigneeType: 'ROLE', assigneeId: { in: roleCodes } },
    select: { code: true },
  });
  return [...new Set(nodes.map((node) => node.code))];
}

/**
 * 项目数据范围里「与我相关」的判定条件。
 *
 * 背景（业务确认 2026-10-14）：流程节点按角色分派负责人。但项目原来的范围只看
 * 「项目负责人 / 合同负责人 / 客户负责人是不是我」，导致**在流程里负责某节点的人看不到项目**
 * ——被分了活却看不见，也就无法推进。这与"每个节点由不同的人负责"直接冲突。
 *
 * 因此把"我持有某个角色、且该角色被指派为流程节点负责人"也算作与我相关：
 * 专利代理人能看到处于「提交申请 / 审查」的项目，流程人员能看到处于「受理 / 授权 / 下证」的项目。
 *
 * @returns `or` 为可直接并入 Prisma where 的相关条件数组
 */
export async function buildRelatedProjectOr(prisma: PrismaService, userId: string) {
  const roleCodes = await readActiveRoleCodes(prisma, userId);
  const nodeCodes = await resolveAssignedNodeCodes(prisma, roleCodes);
  const or: Record<string, unknown>[] = [
    { ownerId: userId },
    { contract: { ownerId: userId } },
    { contract: { customer: { ownerId: userId } } },
  ];
  if (nodeCodes.length > 0) {
    // 处于"我负责的节点"的项目：被分了活就要看得见（否则无从下手）
    or.push({ currentNodeCode: { in: nodeCodes } });
  }
  // 我经手过的项目：交接出去之后仍保留可见，让经手人能继续跟踪整体进度
  // （否则节点一转走项目就从视野里消失，看不到后续走到了哪一步）
  or.push({ nodeHistory: { some: { operatorId: userId } } });
  return { roleCodes, nodeCodes, or };
}

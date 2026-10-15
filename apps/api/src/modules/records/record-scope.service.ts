import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataScope } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { ProjectAccessScopeService } from '../../infrastructure/project-access/project-access-scope.service';

/**
 * 附属业务数据（官文 / 邮件送达 / 动作记录 / 申报结果）的归属与数据范围判定。
 *
 * ## 为什么单独抽出来
 *
 * 项目的可见范围判定此前被复制到 5 个地方（项目服务、推进服务、附件服务、回款服务的两份），
 * 阶段 3.6 改了"我负责的节点"之后只更新了其中两处，导致范围判定**不一致**：
 * 被分派了流程节点的人能看到项目、能推进节点，却看不到该项目的附件与回款。
 *
 * 因此四类附属记录统一走这里，判定口径与 `ProjectService` 保持一致：
 *   项目负责人 / 合同负责人 / 客户负责人 / **我在流程中负责的节点上的项目** / **我经手过的项目**
 *
 * 归属链（严格按 PRD）：
 *   官文       → 项目
 *   邮件送达   → 官文 → 项目
 *   动作记录   → 项目
 *   申报结果   → 项目
 */
@Injectable()
export class RecordScopeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProjectAccessScopeService) private readonly projectAccess: ProjectAccessScopeService,
  ) {}

  /**
   * 在给定数据范围下，判断用户能否访问某个项目。
   * @returns 项目摘要（含 contractId，便于上层复用）
   */
  async assertProjectAccess(projectId: string, userId: string, scope: DataScope) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, projectNo: true, contractId: true, ownerId: true },
    });
    if (!project) throw new NotFoundException('项目不存在或已删除');

    await this.projectAccess.assertProjectAccess(projectId, userId, scope);
    return project;
  }
  /** 判断用户能否访问某个项目（不做抛错，供列表过滤场景使用） */
  async canAccessProject(
    project: { id: string; ownerId: string | null; contractId: string },
    userId: string,
    scope: DataScope,
  ): Promise<boolean> {
    return this.projectAccess.canAccessProject(project.id, userId, scope);
  }

  async visibleProjectIds(userId: string, scope: DataScope) {
    return this.projectAccess.visibleProjectIds(userId, scope);
  }

  /**
   * 由官文 id 反查其所属项目，用于邮件送达登记的权限判定。
   * @param includeDeleted 编辑/删除场景需要拿到已软删的官文以给出准确报错
   */
  async resolveDocumentProject(officialDocumentId: string, includeDeleted = false) {
    const document = await this.prisma.officialDocument.findFirst({
      where: { id: officialDocumentId, ...(includeDeleted ? {} : { deletedAt: null }) },
      select: { id: true, documentName: true, projectId: true, deletedAt: true },
    });
    if (!document) throw new NotFoundException('官文不存在或已删除');
    const project = await this.prisma.project.findFirst({
      where: { id: document.projectId, deletedAt: null },
      select: { id: true, projectNo: true, contractId: true, ownerId: true },
    });
    if (!project) throw new NotFoundException('官文所属项目不存在或已删除');
    return { document, project };
  }
}

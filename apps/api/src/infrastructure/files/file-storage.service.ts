import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessScopeService } from '../project-access/project-access-scope.service';
import { AuthenticatedRequest } from '../../modules/auth/access-token.guard';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

/**
 * 定位 apps/api 包根目录（含 package.json 的那一层）。
 *
 * ## 为什么不用 process.cwd()
 *
 * 相对路径若按 `process.cwd()` 解析，附件目录会随**启动进程的工作目录**漂移。
 * Windows 服务 / 计划任务拉起进程时工作目录常常是 `C:\Windows\System32`，
 * 于是附件被写到别处 —— 表现是"数据库里记录都在、文件却找不到"，
 * 而且**不会报任何错**，排查时极难联想到是工作目录的问题。
 *
 * ## 为什么向上找 package.json 而不是写死层级
 *
 * 本文件在 `src/` 与 `dist/` 两种运行方式下相对包根的层级相同，
 * 但写死 `../..` 会在目录结构调整时静默失效。逐级向上找 package.json
 * 对两种运行方式都成立，也不怕后续重构。
 */
function findApiPackageRoot(startDir: string): string {
  let current = startDir;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return startDir;
}

export const FILE_RESOURCE_TYPES = ['Contract', 'Project', 'OfficialDocument'] as const;
export type FileResourceType = (typeof FILE_RESOURCE_TYPES)[number];

type UploadedFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

type FileOperation = 'read' | 'download' | 'upload' | 'delete';

const DEFAULT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
];

// MIME 类型可以通过环境变量收窄或扩展，但扩展名仍然做第二层校验，避免仅伪造请求头上传可执行文件。
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.webp', '.txt',
  '.doc', '.docx', '.xls', '.xlsx', '.zip',
]);

/**
 * 修复 multipart 上传里中文文件名被误解码的问题。
 *
 * 浏览器按 UTF-8 在 `Content-Disposition: filename` 里发送文件名，但 busboy/multer
 * 在某些情况下按 latin1 解码，于是「专利受理通知书.pdf」变成
 * 「ä¸“åˆ©å—ç†é€šçŸ¥ä¹¦.pdf」。之后清洗正则再把这些乱码字符替换成 `_`，
 * 最终存成「__________________.pdf」—— 用户看到的就是一长串下划线。
 *
 * 判断策略（保守，避免误伤本来就正常的文件名）：
 *   1. 若原串不含任何「可疑的 latin1 高位字符对」，直接原样返回；
 *   2. 否则尝试把原串按 latin1 还原成字节再按 UTF-8 解码；
 *   3. 只有在还原结果**不比自己更差**（替换字符不多于原串）时才采用还原结果。
 */
export function decodeUploadName(raw: string): string {
  if (!raw) return raw;

  // 已经是正常 Unicode（含中日韩字符）：直接返回
  if (/[\u3000-\u9fff\uf900-\ufaff]/.test(raw)) return raw;

  // 可疑信号：出现了 latin1 高位字节被「按字符」呈现的典型组合
  const looksMojibake = /[\u00c2-\u00c3\u00e2\u0080-\u008f]/.test(raw);
  if (!looksMojibake) return raw;

  try {
    const repaired = Buffer.from(raw, 'latin1').toString('utf8');
    const badBefore = (raw.match(/\uFFFD/g) ?? []).length;
    const badAfter = (repaired.match(/\uFFFD/g) ?? []).length;
    // 还原后替换字符更少，且确实包含中文，才认为修好了
    if (badAfter <= badBefore && /[\u3000-\u9fff\uf900-\ufaff]/.test(repaired)) return repaired;
  } catch {
    /* 还原失败则保持原样 */
  }
  return raw;
}

/**
 * 文件名安全化。
 *
 * 目标：**保留可读性**，只去掉真正危险的东西。
 *   - 去掉路径成分（防目录穿越）：交给 `basename`
 *   - 删除控制字符、路径分隔符、Windows 保留字符
 *   - 合并连续的被替换字符，避免出现一长串 `_`
 *   - 去掉前导点，避免生成隐藏文件
 *
 * 存储键用的是 UUID（见 `storageKey`），所以显示名不必承担防重名职责，
 * 可以放心保留中文、方括号、加号等常见但无害的字符。
 */
export function sanitizeUploadName(name: string): string {
  const base = basename(name || '')
    // 控制字符与路径分隔符：必须去掉
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '')
    // 其余保留中文、字母、数字与常见符号；连续被替换字符合并成一个下划线
    .replace(/[^\w\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef.()\[\]{}@#$&+=,'~!\- ]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return base || '未命名文件';
}

@Injectable()
export class FileStorageService {
  private readonly logger = new Logger(FileStorageService.name);
  private readonly rootPath: string;
  private readonly maxSizeBytes: number;
  private readonly allowedMimeTypes: Set<string>;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(ProjectAccessScopeService) private readonly projectAccess: ProjectAccessScopeService,
  ) {
    const configuredPath = config.get<string>('FILE_STORAGE_PATH') ?? './storage/uploads';
    // 相对路径按「包根目录」而非 process.cwd() 解析，避免工作目录漂移导致附件"消失"。
    // 生产建议直接配绝对路径（如 D:\bms\storage\uploads），语义最明确。
    this.rootPath = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(findApiPackageRoot(__dirname), configuredPath);
    const maxMb = Number(config.get<string>('FILE_MAX_SIZE_MB') ?? 20);
    this.maxSizeBytes = Math.max(1, Number.isFinite(maxMb) ? maxMb : 20) * 1024 * 1024;
    const configuredMimes = (config.get<string>('FILE_ALLOWED_MIME_TYPES') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    this.allowedMimeTypes = new Set(configuredMimes.length > 0 ? configuredMimes : DEFAULT_MIME_TYPES);

    // 启动时把解析结果打进日志：附件出问题时第一个要看的就是这个路径。
    this.logger.log(`附件存储目录：${this.rootPath}`);
    if (!isAbsolute(configuredPath) && config.get<string>('NODE_ENV') === 'production') {
      this.logger.warn(
        `生产环境使用了相对路径 FILE_STORAGE_PATH=${configuredPath}（已按包根目录解析为上面的绝对路径）。` +
          '建议改为绝对路径，避免目录结构变化后附件写入位置与预期不一致。',
      );
    }
  }

  async list(resourceType: FileResourceType, resourceId: string, userId: string) {
    await this.assertResourceAccess(resourceType, resourceId, userId, 'read');
    const files = await this.prisma.fileAsset.findMany({
      where: { resourceType, resourceId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { uploadedBy: { select: { id: true, displayName: true, username: true } } },
    });
    return files.map((file) => this.toResponse(file));
  }

  async upload(resourceType: FileResourceType, resourceId: string, file: UploadedFile | undefined, userId: string) {
    await this.assertResourceAccess(resourceType, resourceId, userId, 'upload');
    if (!file?.buffer || !file.originalname) throw new BadRequestException('请选择要上传的文件');
    if (file.size > this.maxSizeBytes) throw new BadRequestException(`文件不能超过 ${this.maxSizeBytes / 1024 / 1024} MB`);
    if (!this.allowedMimeTypes.has(file.mimetype)) throw new BadRequestException('不支持的文件类型，请上传 PDF、图片、Office 文档、文本或 ZIP 文件');

    const safeName = sanitizeUploadName(decodeUploadName(file.originalname));
    const extension = extname(safeName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) throw new BadRequestException('不支持的文件扩展名，请上传 PDF、图片、Office 文档、文本或 ZIP 文件');
    const storageKey = join(resourceType, resourceId, `${randomUUID()}${extension}`).replace(/\\/g, '/');
    const absolutePath = this.resolveStoragePath(storageKey);
    await mkdir(resolve(absolutePath, '..'), { recursive: true });
    await writeFile(absolutePath, file.buffer, { flag: 'wx' });

    try {
      const created = await this.prisma.fileAsset.create({
        data: {
          resourceType,
          resourceId,
          originalName: safeName,
          storageKey,
          mimeType: file.mimetype,
          sizeBytes: BigInt(file.size),
          uploadedById: userId,
        },
        include: { uploadedBy: { select: { id: true, displayName: true, username: true } } },
      });
      await this.auditService.record({ actorId: userId, action: 'FILE_UPLOAD', resourceType: 'FileAsset', resourceId: created.id, afterData: { resourceType, resourceId, originalName: safeName, sizeBytes: file.size } });
      return this.toResponse(created);
    } catch (error) {
      // 数据库写入失败时清理刚写入的文件，避免留下无主文件。
      const fs = await import('node:fs/promises');
      await fs.unlink(absolutePath).catch(() => undefined);
      throw error;
    }
  }

  async getForTransfer(id: string, userId: string, operation: Extract<FileOperation, 'read' | 'download'> = 'read') {
    const file = await this.prisma.fileAsset.findFirst({
      where: { id, deletedAt: null },
      include: { uploadedBy: { select: { id: true, displayName: true, username: true } } },
    });
    if (!file) throw new NotFoundException('附件不存在或已删除');
    await this.assertResourceAccess(file.resourceType as FileResourceType, file.resourceId, userId, operation);
    await this.auditService.record({
      actorId: userId,
      action: operation === 'download' ? 'FILE_DOWNLOAD' : 'FILE_VIEW',
      resourceType: 'FileAsset',
      resourceId: id,
      afterData: { resourceType: file.resourceType, resourceId: file.resourceId, originalName: file.originalName },
    });
    const path = this.resolveStoragePath(file.storageKey);
    return { ...file, path, stream: createReadStream(path), response: this.toResponse(file) };
  }

  async softDelete(id: string, userId: string) {
    const file = await this.prisma.fileAsset.findFirst({ where: { id, deletedAt: null } });
    if (!file) throw new NotFoundException('附件不存在或已删除');
    await this.assertResourceAccess(file.resourceType as FileResourceType, file.resourceId, userId, 'delete');
    const deleted = await this.prisma.fileAsset.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.auditService.record({ actorId: userId, action: 'FILE_DELETE', resourceType: 'FileAsset', resourceId: id, beforeData: { originalName: file.originalName, resourceType: file.resourceType, resourceId: file.resourceId }, afterData: { deletedAt: deleted.deletedAt } });
    return { ok: true };
  }

  private toResponse(file: { id: string; resourceType: string; resourceId: string; originalName: string; mimeType: string; sizeBytes: bigint; uploadedById: string | null; createdAt: Date; uploadedBy?: { id: string; displayName: string; username: string } | null }) {
    return {
      id: file.id,
      resourceType: file.resourceType,
      resourceId: file.resourceId,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: Number(file.sizeBytes),
      uploadedById: file.uploadedById,
      uploadedBy: file.uploadedBy ?? null,
      createdAt: file.createdAt,
    };
  }

  private resolveStoragePath(storageKey: string) {
    const root = resolve(this.rootPath);
    const target = resolve(root, storageKey);
    if (target !== root && !target.startsWith(root + '\\')) throw new BadRequestException('附件路径无效');
    return target;
  }

  private async assertResourceAccess(resourceType: FileResourceType, resourceId: string, userId: string, operation: FileOperation) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, status: 'ACTIVE', deletedAt: null }, select: { isSystemAdmin: true } });
    if (!user) throw new ForbiddenException('当前账号不可用');
    if (user.isSystemAdmin) return;

    const [actionPermissions, basePermissions] = await Promise.all([
      this.prisma.rolePermission.findMany({
        where: { allowed: true, permission: { code: { in: this.permissionCodes(resourceType, operation) } }, role: { isActive: true, users: { some: { userId } } } },
        select: { dataScope: true },
      }),
      this.prisma.rolePermission.findMany({
        where: { allowed: true, permission: { code: { in: this.basePermissionCodes(resourceType, operation) } }, role: { isActive: true, users: { some: { userId } } } },
        select: { dataScope: true },
      }),
    ]);
    if (actionPermissions.length === 0) throw new ForbiddenException('无权执行该附件操作');
    if (basePermissions.length === 0) throw new ForbiddenException('无权访问该业务数据');

    // 说明：`matchesScope` 内部会自己把 resourceId 解析成项目（官文 id 会反查其所属项目），
    // 这里直接传原始 resourceId 即可。
    const [actionScopeChecks, baseScopeChecks] = await Promise.all([
      Promise.all(actionPermissions.map((item) => this.matchesScope(resourceType, resourceId, userId, item.dataScope))),
      Promise.all(basePermissions.map((item) => this.matchesScope(resourceType, resourceId, userId, item.dataScope))),
    ]);
    if (!actionScopeChecks.some(Boolean) || !baseScopeChecks.some(Boolean)) throw new ForbiddenException('无权访问该业务数据的附件');
  }

  private permissionCodes(resourceType: FileResourceType, operation: FileOperation) {
    // 合同附件属于合同本身：上传、删除直接复用合同编辑权限，不要求额外的附件权限点。
    if (resourceType === 'Contract' && (operation === 'upload' || operation === 'delete')) return ['contract.manage'];
    if (resourceType === 'Contract' && (operation === 'read' || operation === 'download')) return ['contract.read', 'contract.manage'];
    return [`attachment.${operation}`];
  }

  private basePermissionCodes(resourceType: FileResourceType, operation: FileOperation) {
    if (resourceType === 'Contract') {
      return operation === 'upload' || operation === 'delete' ? ['contract.manage'] : ['contract.read', 'contract.manage'];
    }
    return ['project.read'];
  }

  /**
   * 把「附件资源 id」解析成对应的业务实体，供数据范围判定使用。
   *
   * ## 官文为什么特殊
   *
   * `resourceType = 'OfficialDocument'` 的 `resourceId` 在历史上有两种含义：
   *   - **项目 id**（旧）：「官文附件」标签最初是**项目级**的占位实现，直接把项目 id 传进来；
   *     数据库里已经存在这样落库的 `FileAsset` 记录，必须继续支持，否则老附件会全部打不开。
   *   - **官文 id**（新）：官文台账建好后，每条官文展开行里挂的是**该官文自己的**附件，
   *     这才是 PRD 4.5 想要的位置。
   *
   * 因此这里两种都查一遍（id 是 cuid，天然不会撞），任一命中即算命中。
   * 曾经的写法是直接把 `resourceId` 当成项目 id 去查项目，导致传官文 id 时必然查不到，
   * 抛出「项目不存在或已删除」—— 数据范围不是 ALL 的账号（销售、代理人、流程人员、财务）
   * 只要展开官文行就会报错，而 admin 因为 scope=ALL 提前返回，反而看不出来。
   */
  private async resolveScopeTarget(
    resourceType: FileResourceType,
    resourceId: string,
  ): Promise<{ projectIds: string[]; contractId: string | null }> {
    if (resourceType === 'Contract') {
      const contract = await this.prisma.contract.findFirst({
        where: { id: resourceId, deletedAt: null },
        select: { id: true, ownerId: true, customer: { select: { ownerId: true } } },
      });
      if (!contract) throw new NotFoundException('合同不存在或已删除');
      return { projectIds: [], contractId: contract.id };
    }

    if (resourceType === 'Project') {
      const project = await this.prisma.project.findFirst({ where: { id: resourceId, deletedAt: null }, select: { id: true } });
      if (!project) throw new NotFoundException('项目不存在或已删除');
      return { projectIds: [project.id], contractId: null };
    }

    // OfficialDocument：既可能是官文 id，也可能是历史上传进来的项目 id
    const [document, project] = await Promise.all([
      this.prisma.officialDocument.findFirst({ where: { id: resourceId, deletedAt: null }, select: { projectId: true } }),
      this.prisma.project.findFirst({ where: { id: resourceId, deletedAt: null }, select: { id: true } }),
    ]);
    const projectIds = [document?.projectId, project?.id].filter((item): item is string => Boolean(item));
    if (projectIds.length === 0) throw new NotFoundException('官文不存在或已删除');
    return { projectIds, contractId: null };
  }

  private async matchesScope(resourceType: FileResourceType, resourceId: string, userId: string, scope: string) {
    const target = await this.resolveScopeTarget(resourceType, resourceId);

    if (resourceType === 'Contract') {
      return this.projectAccess.canAccessContract(target.contractId as string, userId, scope as any);
    }
    const checks = await Promise.all(target.projectIds.map((projectId) => this.projectAccess.canAccessProject(projectId, userId, scope as any)));
    return checks.some(Boolean);
  }

}

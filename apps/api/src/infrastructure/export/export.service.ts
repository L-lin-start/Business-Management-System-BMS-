/**
 * 数据导出服务（PRD 4.12 / 5.10）。
 *
 * ## 设计要点
 *
 * 1. **权限与数据范围**：每行的过滤条件来自对应服务的 `buildExportWhere()`，
 *    它内部复用列表用的范围判定 —— 因此"列表看不到的数据，导出也拿不到"，
 *    不存在靠导出绕过数据范围的可能。
 * 2. **字段与格式可配**：列与格式取自 `ExportConfigService`（存在 SystemConfig），
 *    管理员在「管理系统 → 导出配置」里调整（PRD 5.10）。
 * 3. **金额口径与界面一致**：
 *    - 合同已收款 = 分摊到该合同的回款（`PaymentContractAllocation`）
 *      + 只挂在合同上、没有分摊记录的旧数据（`PaymentReceipt.contractId`）
 *    - 合同未收款 = 合同金额 − 已收款 − 累计调整额
 *    - 成本 = 该合同下项目的成本合计
 *    这套口径与 `ContractService.getById()` 完全一致，避免"界面和导出数字不一样"。
 */

import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DataScope, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ContractService } from '../../modules/contracts/contract.service';
import { ProjectService } from '../../modules/projects/project.service';
import { PaymentService } from '../../modules/payments/payment.service';
import { CostService } from '../../modules/costs/cost.service';
import { CustomerService } from '../../modules/customers/customer.service';
import { ContractQueryDto } from '../../modules/contracts/dto/contract.dto';
import { ProjectQueryDto } from '../../modules/projects/dto/project.dto';
import { PaymentQueryDto } from '../../modules/payments/dto/payment.dto';
import { CostQueryDto } from '../../modules/costs/dto/cost.dto';
import { CustomerQueryDto } from '../../modules/customers/dto/customer.dto';
import { ExportConfigService, ExportModule, EXPORT_DEFINITIONS, EXPORT_STATUS_LABELS } from './export-definitions';
import { CsvColumn, toCsv } from './csv.util';
import { buildXlsx, XlsxCell } from './xlsx.util';

/** 导出结果：交给控制器写 HTTP 响应 */
export type ExportResult = {
  filename: string;
  contentType: string;
  buffer: Buffer;
  rowCount: number;
  format: 'csv' | 'xlsx';
  fields: string[];
};

/** 把金额/日期统一成导出友好的文本形式 */
function money(value: Prisma.Decimal | number | string | null | undefined): string {
  if (value === null || value === undefined) return '0.00';
  return new Prisma.Decimal(value).toFixed(2);
}

function dateText(value: Date | null | undefined): string {
  if (!value) return '';
  const pad = (input: number) => String(input).padStart(2, '0');
  // 用本地日历字段拼接，避免 toISOString 在 UTC+8 下退一天
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function dateTimeText(value: Date | null | undefined): string {
  if (!value) return '';
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${dateText(value)} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function statusText(code: string | null | undefined): string {
  if (!code) return '';
  return EXPORT_STATUS_LABELS[code] ?? code;
}

/** 客户类型/合同类型等存的是编码，导出时尽量换成中文标签 */
async function optionLabels(prisma: PrismaService, moduleKey: string): Promise<Map<string, string>> {
  const rows = await prisma.statusDefinition.findMany({ where: { moduleKey }, select: { code: true, label: true } });
  return new Map(rows.map((row) => [row.code, row.label]));
}

/** 把控制层传来的原始查询参数转成各服务的 QueryDto。
 *
 * 导出不分页，所以 DTO 上的 `page` / `pageSize` 用不到；
 * 各服务的 `buildExportWhere` 只读取筛选字段，这里统一做一次转换，
 * 避免每个分支各写一次 `as unknown as`。
 */
function asQuery<T>(query: Record<string, string | undefined>): T {
  return query as unknown as T;
}

@Injectable()
export class ExportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ContractService) private readonly contractService: ContractService,
    @Inject(ProjectService) private readonly projectService: ProjectService,
    @Inject(PaymentService) private readonly paymentService: PaymentService,
    @Inject(CostService) private readonly costService: CostService,
    @Inject(CustomerService) private readonly customerService: CustomerService,
    @Inject(ExportConfigService) private readonly configService: ExportConfigService,
  ) {}

  /** 导出模块的权限要求（控制器与界面都用它展示"需要什么权限"） */
  permissionsOf(module: ExportModule): string[] {
    return EXPORT_DEFINITIONS[module].permissions;
  }

  /**
   * 解析该用户对某导出模块的**有效数据范围**。
   *
   * 为什么要单独做：导出权限是**按模块动态**的（customer.export / contract.export / …），
   * 而共享的 `PermissionGuard` 只认 `@RequirePermission` 声明的**单个**权限码。
   * 与其改动那个被 40+ 个接口依赖的守卫，不如把导出这一处的权限与范围解析
   * 收敛在本服务内 —— 逻辑只有一个入口，不会出现"某个模块忘了校验"。
   *
   * 范围取值与 `PermissionGuard` 完全一致：
   *   系统管理员 → ALL；否则取该用户所有命中角色中最宽的那个 scope；一个都没有 → 403。
   */
  async resolveScope(module: ExportModule, userId: string): Promise<DataScope> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: 'ACTIVE', deletedAt: null },
      select: { isSystemAdmin: true },
    });
    if (!user) throw new ForbiddenException('当前账号不可用');
    if (user.isSystemAdmin) return 'ALL';

    const required = this.permissionsOf(module);
    const rows = await this.prisma.rolePermission.findMany({
      where: {
        allowed: true,
        permission: { code: { in: required } },
        role: { isActive: true, users: { some: { userId } } },
      },
      select: { dataScope: true },
    });
    const order: DataScope[] = ['ALL', 'DEPARTMENT_AND_DESCENDANTS', 'DEPARTMENT', 'RELATED', 'SELF', 'NONE'];
    const picked = rows
      .map((row) => row.dataScope)
      .sort((left, right) => order.indexOf(left) - order.indexOf(right))
      .find((scope) => scope !== 'NONE');
    if (!picked) {
      throw new ForbiddenException(`无权导出该数据（需要权限：${required.join(' 或 ')}）`);
    }
    return picked;
  }

  /**
   * 执行导出。
   *
   * @param module 模块
   * @param query  与列表页相同的筛选条件（关键字/状态/客户/合同等）
   */
  async run(
    module: ExportModule,
    query: Record<string, string | undefined>,
    userId: string,
    dataScope: DataScope,
  ): Promise<ExportResult> {
    const config = await this.configService.get(module);
    const columns = await this.buildColumns(module);

    // 按配置裁剪字段；配置里若含未知字段，buildColumns 已过滤掉
    const picked = columns.filter((column) => config.fields.includes(column.key));
    const effective = picked.length > 0 ? picked : columns;

    const rows = await this.fetchRows(module, query, userId, dataScope);
    const headers = effective.map((column) => column.header);

    const buffer =
      config.format === 'xlsx'
        ? buildXlsx(
            EXPORT_DEFINITIONS[module].label,
            headers,
            rows.map((row) => effective.map((column): XlsxCell => this.toCell(column.value(row)))),
          )
        : Buffer.from(
            toCsv(
              effective as Array<CsvColumn<Record<string, unknown>>>,
              rows,
            ),
            'utf8',
          );

    return {
      filename: `${EXPORT_DEFINITIONS[module].label}导出.${config.format}`,
      contentType:
        config.format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8',
      buffer,
      rowCount: rows.length,
      format: config.format,
      fields: effective.map((column) => column.key),
    };
  }

  /** 数字保持数字（Excel 可求和），其余转字符串 */
  private toCell(value: unknown): XlsxCell {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return value;
    const text = String(value);
    // 金额是 "1234.00" 这种字符串：转成数字写入，便于 Excel 直接统计
    if (/^-?\d+(\.\d+)?$/.test(text) && text.length <= 15) return Number(text);
    return text;
  }

  /**
   * 组装列定义（含取值函数）。
   *
   * 取值函数在这里按模块实现，key 必须与 `EXPORT_DEFINITIONS` 对齐 ——
   * 两边不一致时会被过滤掉（该列不会出现在导出里），不会静默导出空列。
   */
  private async buildColumns(module: ExportModule) {
    const definitions = EXPORT_DEFINITIONS[module].columns;
    const [contractTypeLabels, customerTypeLabels, projectTypeLabels] = await Promise.all([
      optionLabels(this.prisma, 'contractType'),
      optionLabels(this.prisma, 'customerType'),
      optionLabels(this.prisma, 'projectType'),
    ]);

    // 每个模块的取值函数表
    const valueByKey: Record<string, (row: Record<string, unknown>) => unknown> = {
      // ---- 通用字段 ----
      createdAt: (row) => dateTimeText(row.createdAt as Date | null),
      // ---- 客户 ----
      name: (row) => row.name,
      customerType: (row) => customerTypeLabels.get(String(row.customerType ?? '')) ?? row.customerType ?? '',
      contactName: (row) => row.contactName,
      phone: (row) => row.phone,
      email: (row) => row.email,
      address: (row) => row.address,
      ownerName: (row) => (row.owner as { displayName?: string } | null)?.displayName ?? '',
      // ---- 合同 ----
      contractNo: (row) => row.contractNo,
      customerName: (row) => (row.customer as { name?: string } | null)?.name ?? '',
      contractType: (row) => contractTypeLabels.get(String(row.contractType ?? '')) ?? row.contractType ?? '',
      amount: (row) => money(row.amount as Prisma.Decimal),
      collectedAmount: (row) => money(row.collectedAmount as Prisma.Decimal | undefined),
      unpaidAmount: (row) => money(row.unpaidAmount as Prisma.Decimal | undefined),
      costAmount: (row) => money(row.costAmount as Prisma.Decimal | undefined),
      netProfit: (row) => money(row.netProfit as Prisma.Decimal | undefined),
      itemCount: (row) => row.itemCount,
      projectCount: (row) => row.projectCount,
      statusLabel: (row) => statusText(row.statusCode as string),
      signedAt: (row) => dateText(row.signedAt as Date | null),
      expiryDate: (row) => dateText(row.expiryDate as Date | null),
      remark: (row) => row.remark,
      terminatedAt: (row) => dateText(row.terminatedAt as Date | null),
      terminationReason: (row) => row.terminationReason,
      // ---- 项目 ----
      projectNo: (row) => row.projectNo,
      projectName: (row) => row.projectName,
      projectType: (row) => projectTypeLabels.get(String(row.projectType ?? '')) ?? row.projectType ?? '',
      currentNodeName: (row) => row.currentNodeName,
      startDate: (row) => dateText(row.startDate as Date | null),
      dueDate: (row) => dateText(row.dueDate as Date | null),
      sequence: (row) => row.sequence,
      // ---- 回款 ----
      receiptNo: (row) => row.receiptNo,
      receivedAt: (row) => dateText(row.receivedAt as Date | null),
      paymentMethod: (row) => row.paymentMethod,
      allocatedProjects: (row) => row.allocatedProjects,
      note: (row) => row.note,
      // ---- 成本 ----
      costType: (row) => row.costType,
      incurredAt: (row) => dateText(row.incurredAt as Date | null),
      // 项目/合同编号在成本行里来自关联对象
      projectNoFromRelation: (row) => (row.project as { projectNo?: string } | null)?.projectNo ?? '',
      contractNoFromRelation: (row) => (row.contract as { contractNo?: string } | null)?.contractNo ?? '',
    };

    return definitions.map((definition) => {
      // 成本模块的"所属项目/所属合同"来自关联对象，这里做 key 映射
      const key = definition.key;
      const resolver =
        valueByKey[key] ??
        (key === 'projectNo'
          ? valueByKey.projectNoFromRelation
          : key === 'contractNo'
            ? valueByKey.contractNoFromRelation
            : (row: Record<string, unknown>) => (row[key] === undefined ? '' : row[key]));
      return { ...definition, value: resolver! };
    });
  }

  /** 按模块取数（过滤条件复用各服务的 buildExportWhere） */
  private async fetchRows(
    module: ExportModule,
    query: Record<string, string | undefined>,
    userId: string,
    dataScope: DataScope,
  ): Promise<Array<Record<string, unknown>>> {
    if (module === 'customer') {
      const where = await this.customerService.buildExportWhere(asQuery<CustomerQueryDto>(query), userId, dataScope);
      return (await this.prisma.customer.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
        include: { owner: { select: { displayName: true } } },
      })) as unknown as Array<Record<string, unknown>>;
    }

    if (module === 'contract') {
      const where = await this.contractService.buildExportWhere(asQuery<ContractQueryDto>(query), userId, dataScope);
      const contracts = await this.prisma.contract.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        include: {
          customer: { select: { name: true } },
          owner: { select: { displayName: true } },
          _count: { select: { projects: true } },
        },
      });
      if (contracts.length === 0) return [];
      const ids = contracts.map((item) => item.id);
      const [allocations, legacyReceipts, adjustments, costs] = await Promise.all([
        this.prisma.paymentContractAllocation.findMany({
          where: { contractId: { in: ids }, payment: { deletedAt: null } },
          select: { contractId: true, amount: true },
        }),
        this.prisma.paymentReceipt.findMany({
          where: { contractId: { in: ids }, deletedAt: null, contractAllocations: { none: {} } },
          select: { contractId: true, amount: true },
        }),
        this.prisma.contractAmountAdjustment.findMany({
          where: { contractId: { in: ids }, deletedAt: null },
          select: { contractId: true, amount: true },
        }),
        this.prisma.costRecord.findMany({
          where: { deletedAt: null, project: { contractId: { in: ids }, deletedAt: null } },
          select: { amount: true, project: { select: { contractId: true } } },
        }),
      ]);
      const collectedBy = new Map<string, Prisma.Decimal>();
      const add = (contractId: string, amount: Prisma.Decimal) => {
        collectedBy.set(contractId, (collectedBy.get(contractId) ?? new Prisma.Decimal(0)).plus(amount));
      };
      for (const row of allocations) add(row.contractId, row.amount);
      for (const row of legacyReceipts) if (row.contractId) add(row.contractId, row.amount);
      const adjustedBy = new Map<string, Prisma.Decimal>();
      for (const row of adjustments) {
        adjustedBy.set(row.contractId, (adjustedBy.get(row.contractId) ?? new Prisma.Decimal(0)).plus(row.amount));
      }
      const costBy = new Map<string, Prisma.Decimal>();
      for (const row of costs) {
        const contractId = row.project?.contractId;
        if (!contractId) continue;
        costBy.set(contractId, (costBy.get(contractId) ?? new Prisma.Decimal(0)).plus(row.amount));
      }

      return contracts.map((contract) => {
        const collected = collectedBy.get(contract.id) ?? new Prisma.Decimal(0);
        const adjusted = adjustedBy.get(contract.id) ?? new Prisma.Decimal(0);
        const cost = costBy.get(contract.id) ?? new Prisma.Decimal(0);
        return {
          ...contract,
          projectCount: contract._count.projects,
          collectedAmount: collected,
          unpaidAmount: contract.amount.minus(collected).minus(adjusted),
          costAmount: cost,
          netProfit: collected.minus(cost),
        } as unknown as Record<string, unknown>;
      });
    }

    if (module === 'project') {
      const where = await this.projectService.buildExportWhere(asQuery<ProjectQueryDto>(query), userId, dataScope);
      const projects = await this.prisma.project.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { sequence: 'asc' }],
        include: {
          contract: { select: { contractNo: true, customer: { select: { name: true } } } },
          owner: { select: { displayName: true } },
          workflowVersion: { select: { nodes: { select: { code: true, name: true } } } },
        },
      });
      if (projects.length === 0) return [];
      const ids = projects.map((item) => item.id);
      const [payments, costs] = await Promise.all([
        this.prisma.projectPaymentAllocation.findMany({
          where: { projectId: { in: ids }, payment: { deletedAt: null } },
          select: { projectId: true, amount: true },
        }),
        this.prisma.costRecord.findMany({
          where: { projectId: { in: ids }, deletedAt: null },
          select: { projectId: true, amount: true },
        }),
      ]);
      const collectedBy = new Map<string, Prisma.Decimal>();
      for (const row of payments) {
        collectedBy.set(row.projectId, (collectedBy.get(row.projectId) ?? new Prisma.Decimal(0)).plus(row.amount));
      }
      const costBy = new Map<string, Prisma.Decimal>();
      for (const row of costs) {
        costBy.set(row.projectId, (costBy.get(row.projectId) ?? new Prisma.Decimal(0)).plus(row.amount));
      }

      return projects.map((project) => {
        const nodes = project.workflowVersion?.nodes ?? [];
        const collected = collectedBy.get(project.id) ?? new Prisma.Decimal(0);
        const cost = costBy.get(project.id) ?? new Prisma.Decimal(0);
        return {
          ...project,
          customerName: project.contract.customer?.name ?? '',
          currentNodeName: nodes.find((node) => node.code === project.currentNodeCode)?.name ?? '',
          collectedAmount: collected,
          costAmount: cost,
          netProfit: collected.minus(cost),
        } as unknown as Record<string, unknown>;
      });
    }

    if (module === 'payment') {
      const where = await this.paymentService.buildExportWhere(asQuery<PaymentQueryDto>(query), userId, dataScope);
      const payments = await this.prisma.paymentReceipt.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        include: {
          contract: { select: { contractNo: true, customer: { select: { name: true } } } },
          contractAllocations: { select: { contract: { select: { contractNo: true } } } },
          allocations: { select: { project: { select: { projectNo: true } } } },
        },
      });
      return payments.map((payment) => ({
        ...payment,
        // 跨合同回款时 legacy `contract` 为 null，用 contractAllocations 兜底列出全部合同
        contractNo: payment.contract?.contractNo ?? payment.contractAllocations.map((item) => item.contract.contractNo).join('、'),
        customerName: payment.contract?.customer?.name ?? '',
        allocatedProjects: payment.allocations.map((item) => item.project.projectNo).join('、'),
      })) as unknown as Array<Record<string, unknown>>;
    }

    // cost
    const where = await this.costService.buildExportWhere(asQuery<CostQueryDto>(query), userId, dataScope);
    return (await this.prisma.costRecord.findMany({
      where,
      orderBy: { incurredAt: 'desc' },
      include: {
        contract: { select: { contractNo: true } },
        project: { select: { projectNo: true } },
      },
    })) as unknown as Array<Record<string, unknown>>;
  }

  /** 导出配置读写（管理系统用） */
  listConfigs() {
    return this.configService.listAll();
  }

  saveConfig(module: ExportModule, input: { format?: string; fields?: string[] }) {
    return this.configService.save(module, input);
  }
}


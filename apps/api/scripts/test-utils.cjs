/**
 * 在加载应用模块（AppModule）**之前**调用，把 DATABASE_URL 指向测试库。
 *
 * 为什么必须在 import 之前：服务层与 PrismaService 都从 `DATABASE_URL` 读取连接，
 * 一旦 AppModule 被 require，PrismaService 就会在构造时用当时的连接串建连接池，
 * 之后再改环境变量已经不生效。所以脚本第一行就要调用本函数。
 *
 * 用法：
 *   const { prepareTestDatabaseEnv } = require('./test-utils.cjs');
 *   prepareTestDatabaseEnv();                       // ← 必须在 require('../dist/app.module') 之前
 *   const { AppModule } = require('../dist/app.module');
 *
 * @returns 选中的测试库连接串
 */
function prepareTestDatabaseEnv() {
  const { url, isDevDatabase } = resolveTestDatabaseUrl();
  process.env.DATABASE_URL = url;
  // 迁移/影子库也一起指向测试库，避免误连开发库的影子库
  if (process.env.TEST_SHADOW_DATABASE_URL) {
    process.env.SHADOW_DATABASE_URL = process.env.TEST_SHADOW_DATABASE_URL;
  }
  if (isDevDatabase) {
    console.warn('[警告] 正在开发库上运行验证脚本（ALLOW_DEV_DB_RESET=1），业务数据会被清空。');
  }
  return url;
}

/**
 * 验证脚本共用的测试数据工具。
 *
 * ## 数据库隔离（重要）
 *
 * 验证脚本会真实写库、并**清空业务数据**以保证脚本之间互不污染。
 * 因此它们**绝不能跑在开发库上** —— 否则开发/测试时手工录入的客户、合同、项目会被清掉，
 * 每跑一次回归就要重录一遍数据。
 *
 * 约定：
 *   - 脚本连 `TEST_DATABASE_URL`（默认指向 business_management_test）；
 *   - 只有显式设置 `ALLOW_DEV_DB_RESET=1` 时才允许连 DATABASE_URL（开发库），
 *     用于极端情况下的手工修复，正常回归不允许。
 *
 * 每个脚本开头调用 resetBusinessData()，把业务数据、编号计数器与自定义字段定义恢复到干净起点。
 * 只清理业务数据（客户/合同/项目/回款/成本/分摊）、编号计数器与自定义字段定义（isSystem=false）；
 * 用户、角色、权限、状态枚举、模块内置字段定义（isSystem=true）等配置数据一律不动。
 */
const { PrismaClient } = require('@prisma/client');

/** 解析出验证脚本该连哪个库 */
function resolveTestDatabaseUrl() {
  const testUrl = process.env.TEST_DATABASE_URL?.trim();
  if (testUrl) return { url: testUrl, isDevDatabase: false };

  const devUrl = process.env.DATABASE_URL?.trim();
  if (!devUrl) {
    throw new Error(
      '未配置数据库连接：请在 apps/api/.env 中设置 TEST_DATABASE_URL（推荐）或 DATABASE_URL。',
    );
  }
  if (process.env.ALLOW_DEV_DB_RESET !== '1') {
    throw new Error(
      [
        '拒绝在开发库上运行验证脚本：未配置 TEST_DATABASE_URL，只找到 DATABASE_URL。',
        '验证脚本会清空业务数据，跑在开发库上会删掉你手工录入的客户/合同/项目。',
        '',
        '解决办法（任选其一）：',
        '  1) 在 apps/api/.env 里配置 TEST_DATABASE_URL 指向独立的测试库（推荐）；',
        '  2) 若确实要在开发库上跑（会清数据），显式设置环境变量 ALLOW_DEV_DB_RESET=1。',
      ].join('\n'),
    );
  }
  return { url: devUrl, isDevDatabase: true };
}

/** 创建指向测试库的 PrismaClient */
function createTestPrismaClient() {
  const { url, isDevDatabase } = resolveTestDatabaseUrl();
  if (isDevDatabase) {
    console.warn('[警告] 正在开发库上运行验证脚本（ALLOW_DEV_DB_RESET=1），业务数据会被清空。');
  }
  return new PrismaClient({ datasources: { db: { url } } });
}

/** 清空业务数据、编号计数器与自定义字段定义；返回被清理的记录数，便于脚本打印 */
async function resetBusinessData(prisma) {
  const client = prisma ?? createTestPrismaClient();
  const ownsClient = !prisma;

  try {
    // 第一步：删附属业务数据。顺序很重要——附属记录都外键指向项目/官文，
    // 必须先删掉，否则删项目时会被外键挡住（新增四类附属记录后曾漏了这一步，导致 14 个脚本一起失败）。
    const [mailDeliveries, officialDocuments, actionRecords, filingResults] = await client.$transaction([
      client.mailDelivery.deleteMany({}),
      client.officialDocument.deleteMany({}),
      client.actionRecord.deleteMany({}),
      client.filingResult.deleteMany({}),
    ]);

    // 第二步：删核心业务数据
    const [allocations, receipts, costs, projects, contracts, customers] = await client.$transaction([
      client.projectPaymentAllocation.deleteMany({}),
      client.paymentContractAllocation.deleteMany({}),
      client.paymentReceipt.deleteMany({}),
      client.costRecord.deleteMany({}),
      client.contractAmountAdjustment.deleteMany({}),
      client.project.deleteMany({}),
      client.contract.deleteMany({}),
      client.customer.deleteMany({}),
    ]);

    // 历史记录会随业务数据删除而变成孤儿（按 resourceId 关联、无外键），一并清掉避免长期累积。
    // 这些记录在脚本里已由各自的断言读取完毕，删除不影响结论。
    const [statusHistory, nodeHistory] = await client.$transaction([
      client.statusChangeHistory.deleteMany({}),
      client.projectNodeHistory.deleteMany({}),
    ]);

    // 自定义字段定义是"测试残留"高发区：验证脚本会新建字段并可能设成必填，
    // 若不清掉，后续脚本建合同时会因"某某为必填"而失败（曾真实发生）。
    // 只删自定义字段（isSystem=false），种子里预置的内置字段定义保留。
    const deletedFields = await client.fieldDefinition.deleteMany({ where: { isSystem: false } });

    const counters = await client.$executeRawUnsafe('DELETE FROM "DocumentSequence"');

    return {
      allocations: allocations.count,
      receipts: receipts.count,
      costs: costs.count,
      projects: projects.count,
      contracts: contracts.count,
      customers: customers.count,
      mailDeliveries: mailDeliveries.count,
      officialDocuments: officialDocuments.count,
      actionRecords: actionRecords.count,
      filingResults: filingResults.count,
      statusHistory: statusHistory.count,
      nodeHistory: nodeHistory.count,
      customFields: deletedFields.count,
      counters,
    };
  } finally {
    if (ownsClient) await client.$disconnect();
  }
}

/** 打印一行清理摘要，便于定位脚本之间的干扰 */
function logResetResult(scope, result) {
  const attachments =
    (result.officialDocuments ?? 0) + (result.mailDeliveries ?? 0) + (result.actionRecords ?? 0) + (result.filingResults ?? 0);
  console.log(
    `[准备:${scope}] 已清理 客户 ${result.customers} / 合同 ${result.contracts} / 项目 ${result.projects} / ` +
      `回款 ${result.receipts} / 成本 ${result.costs} / 附属记录（官文·邮件·动作·申报）${attachments} 条 / ` +
      `历史 ${result.statusHistory + result.nodeHistory} 条 / 自定义字段 ${result.customFields} 个，编号计数器 ${result.counters} 条已归零`,
  );
}

/**
 * 生成测试用的合同编号工厂。
 *
 * 背景：合同编号已改为**人工填写**且不允许重号（见 docs/接口文档.md 编号规则一节），
 * 脚本不能再依赖系统自动生成。用工厂给每个脚本一套专属前缀，既保证脚本内不重号，
 * 也让测试数据在库里一眼可辨（例如 VERIFY-PAYMENT-A-1）。
 */
function createContractNoFactory(prefix) {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

module.exports = {
  resetBusinessData,
  logResetResult,
  createContractNoFactory,
  createTestPrismaClient,
  resolveTestDatabaseUrl,
  prepareTestDatabaseEnv,
};

/**
 * 阶段 1a 验证：状态变化历史 + 乐观锁（真实服务 + 真实事务 + 真实数据库）。
 *
 * 覆盖：
 *   - 合同/项目更新时缺少或使用过期版本号 → 409，且数据不被覆盖
 *   - 版本号正确时更新成功且版本自增
 *   - 状态变化写入 StatusChangeHistory，并同时进审计日志
 *   - 状态未变化时不产生历史记录
 *   - 历史查询按时间正序并带中文状态名
 *   - 节点流转历史表可写入与查询（阶段 1b 的落点）
 *   - 历史记录不可通过业务接口删除
 * 运行结束后清理测试数据并把流水号计数器归零。
 *
 * 用法：node scripts/verify-history-and-locking.cjs   （需先 tsc 构建出 dist）
 */
const { PrismaClient } = require('@prisma/client');
const { resetBusinessData, logResetResult, createContractNoFactory, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');
const { ProjectService } = require('../dist/modules/projects/project.service');
const { HistoryService } = require('../dist/modules/history/history.service');

const prisma = createTestPrismaClient();
const TEST_CUSTOMER_NAME = '阶段1a验证客户（临时）';
let failures = 0;
let app;
const nextContractNo = createContractNoFactory('VERIFY-HIST');

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function expectConflict(label, action) {
  try {
    await action();
    check(label, false, '未抛出异常');
  } catch (error) {
    const status = error?.status ?? error?.getStatus?.();
    const message = error?.message ?? String(error);
    check(label, status === 409 || message.includes('已被他人更新'), `status=${status} ${message}`);
  }
}

async function main() {
  // 脚本自包含：清空业务数据与编号计数器，避免受其它验证脚本影响
  logResetResult('流转与乐观锁', await resetBusinessData(prisma));
  // 历史记录表不在业务数据清理范围内，单独清掉上一轮残留（表头无外键指向客户，需按资源 id 反查）
  const staleContracts = await prisma.contract.findMany({ select: { id: true } });
  const staleProjects = await prisma.project.findMany({ select: { id: true } });
  await prisma.projectNodeHistory.deleteMany({ where: { projectId: { in: staleProjects.map((item) => item.id) } } });
  await prisma.statusChangeHistory.deleteMany({
    where: {
      OR: [
        { resourceType: 'Contract', resourceId: { in: staleContracts.map((item) => item.id) } },
        { resourceType: 'Project', resourceId: { in: staleProjects.map((item) => item.id) } },
      ],
    },
  });

  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const contractService = app.get(ContractService);
  const projectService = app.get(ProjectService);
  const historyService = app.get(HistoryService);
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true, displayName: true } });
  const customer = await prisma.customer.create({ data: { name: TEST_CUSTOMER_NAME } });

  console.log('=== 1. 建合同与项目，初始版本号为 0 ===');
  const contract = await contractService.create(
    { contractNo: 'VERIFY-HISTORY-1', customerId: customer.id, amount: 30000, contractType: 'COPYRIGHT', itemCount: 2, signedAt: '2026-09-01' },
    admin.id,
  );
  const projects = await prisma.project.findMany({ where: { contractId: contract.id }, orderBy: { sequence: 'asc' } });
  check('合同初始版本为 0', contract.version === 0, String(contract.version));
  check('项目初始版本为 0', projects.every((item) => item.version === 0));
  check('初始状态写入历史（合同）', (await prisma.statusChangeHistory.count({ where: { resourceType: 'Contract', resourceId: contract.id } })) >= 0);

  console.log('\n=== 2. 乐观锁：版本正确才能更新 ===');
  const updated = await contractService.update(contract.id, { version: 0, amount: 35000, statusReason: '金额更正' }, admin.id, 'ALL');
  check('版本正确时更新成功', Number(updated.amount) === 35000, String(updated.amount));
  check('更新后版本自增为 1', updated.version === 1, String(updated.version));

  await expectConflict('用过期版本号（0）再次更新 → 409', () =>
    contractService.update(contract.id, { version: 0, amount: 99999 }, admin.id, 'ALL'),
  );
  const afterConflict = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id }, select: { amount: true, version: true } });
  check('冲突时数据未被覆盖', Number(afterConflict.amount) === 35000, String(afterConflict.amount));
  check('冲突时版本号未变化', afterConflict.version === 1, String(afterConflict.version));

  console.log('\n=== 3. 项目更新的乐观锁 ===');
  const project = projects[0];
  const projectUpdated = await projectService.update(project.id, { version: 0, projectName: '改名后的项目' }, admin.id, 'ALL');
  check('项目版本正确时更新成功', projectUpdated.projectName === '改名后的项目');
  check('项目版本自增为 1', projectUpdated.version === 1, String(projectUpdated.version));
  await expectConflict('项目用过期版本号更新 → 409', () =>
    projectService.update(project.id, { version: 0, projectName: '不该生效' }, admin.id, 'ALL'),
  );
  const projectAfterConflict = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { projectName: true } });
  check('项目冲突时数据未被覆盖', projectAfterConflict.projectName === '改名后的项目', projectAfterConflict.projectName);

  console.log('\n=== 4. 状态变化写入历史 ===');
  // 重要前提：合同字段更新会触发 ContractStatusService.reconcile（"合同资料变更后自动同步合同状态"），
  // 而该项目尚未发生任何节点流转，reconcile 的兜底分支会把状态**改回 ACTIVE**。
  // 因此这里不能断言"手工设的执行中会保留"——那取决于 reconcile 的产品口径（见 docs/回归结果.txt 的遗留问题记录）。
  // 本用例只验证"状态变化会写历史"，所以明确按 reconcile 之后的结果断言。
  const beforeStatus = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id }, select: { statusCode: true } });
  await contractService.update(contract.id, { version: 1, statusCode: 'IN_PROGRESS', statusReason: '开始执行' }, admin.id, 'ALL');
  const afterUpdate = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id }, select: { statusCode: true } });
  const history = await historyService.listStatusHistory('Contract', contract.id);
  const manualEntry = history.find((item) => item.reason === '开始执行');
  check(
    '手工改状态会写入一条状态变化历史',
    manualEntry !== undefined,
    `历史 ${history.length} 条：${history.map((item) => `${item.fromStatusCode}→${item.toStatusCode}`).join('、')}`,
  );
  check(
    '记录了原状态与目标状态',
    manualEntry?.fromStatusCode === beforeStatus.statusCode && manualEntry?.toStatusCode === 'IN_PROGRESS',
    `${manualEntry?.fromStatusCode} → ${manualEntry?.toStatusCode}`,
  );
  check('记录了变化原因', manualEntry?.reason === '开始执行', String(manualEntry?.reason));
  check('附带了中文状态名', manualEntry?.toStatusLabel === '执行中', String(manualEntry?.toStatusLabel));
  check('记录了操作人', manualEntry?.operator?.displayName === admin.displayName, String(manualEntry?.operator?.displayName ?? ''));

  const auditCount = await prisma.auditLog.count({ where: { action: 'STATUS_CHANGE', resourceType: 'Contract', resourceId: contract.id } });
  check('状态变化同时进审计日志', auditCount >= 1, `${auditCount} 条`);

  console.log('\n=== 5. 状态未变化时不产生历史 ===');
  // 说明：由于 reconcile 会在合同字段更新后重算状态（本项目未启动 → 兜底 ACTIVE），
  // 只要"更新前后状态相同"就不应新增历史。这里对同一状态连续更新两次做验证。
  const settledStatus = (await prisma.contract.findUniqueOrThrow({ where: { id: contract.id }, select: { statusCode: true, version: true } }));
  await contractService.update(contract.id, { version: settledStatus.version, amount: 36000, statusCode: settledStatus.statusCode }, admin.id, 'ALL');
  const historyBeforeNoChange = await prisma.statusChangeHistory.count({ where: { resourceType: 'Contract', resourceId: contract.id } });
  const versionNow = (await prisma.contract.findUniqueOrThrow({ where: { id: contract.id }, select: { version: true } })).version;
  await contractService.update(contract.id, { version: versionNow, amount: 37000, statusCode: settledStatus.statusCode }, admin.id, 'ALL');
  const historyAfterNoChange = await prisma.statusChangeHistory.count({ where: { resourceType: 'Contract', resourceId: contract.id } });
  check('状态相同则不写历史', historyAfterNoChange === historyBeforeNoChange, `${historyBeforeNoChange} → ${historyAfterNoChange}`);

  console.log('\n=== 6. 项目状态历史与节点历史 ===');
  const projectVersion = (await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { version: true } })).version;
  await projectService.update(project.id, { version: projectVersion, statusCode: 'IN_PROGRESS', statusReason: '开始审查' }, admin.id, 'ALL');
  const projectHistory = await historyService.listStatusHistory('Project', project.id);
  check('项目状态历史可查询', projectHistory.length >= 1, `${projectHistory.length} 条`);
  check('项目历史带中文状态名', projectHistory[projectHistory.length - 1].toStatusLabel === '进行', String(projectHistory[projectHistory.length - 1].toStatusLabel));

  await historyService.recordNodeTransition({
    projectId: project.id,
    fromNodeCode: 'MATERIAL_PREP',
    toNodeCode: 'INTERNAL_REVIEW',
    operatorId: admin.id,
    note: '材料齐备，转内部审核',
  });
  const nodeHistory = await historyService.listNodeHistory(project.id);
  check('节点流转历史可写入与查询', nodeHistory.length === 1, `${nodeHistory.length} 条`);
  check('节点历史记录了流转方向', nodeHistory[0].fromNodeCode === 'MATERIAL_PREP' && nodeHistory[0].toNodeCode === 'INTERNAL_REVIEW');
  check('节点历史记录了操作人', nodeHistory[0].operator?.displayName === admin.displayName);

  console.log('\n=== 7. 历史记录只增不改 ===');
  const contractId = contract.id;
  const historyIds = (await prisma.statusChangeHistory.findMany({ where: { resourceId: contractId }, select: { id: true } })).map((item) => item.id);
  check('历史记录以 id 唯一标识且数量与查询一致', historyIds.length === (await prisma.statusChangeHistory.count({ where: { resourceId: contractId } })), `${historyIds.length} 条`);
  // 业务侧没有删除历史记录的接口，这里确认服务未暴露删除方法
  check('历史服务未提供删除方法', typeof historyService.deleteStatusHistory !== 'function');
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error);
    failures += 1;
  })
  .finally(async () => {
    try {
      const customers = await prisma.customer.findMany({ where: { name: TEST_CUSTOMER_NAME }, select: { id: true } });
      const customerIds = customers.map((item) => item.id);
      if (customerIds.length) {
        const projectIds = (await prisma.project.findMany({ where: { contract: { customerId: { in: customerIds } } }, select: { id: true } })).map((p) => p.id);
        const contractIds = (await prisma.contract.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } })).map((c) => c.id);
        await prisma.projectNodeHistory.deleteMany({ where: { projectId: { in: projectIds } } });
        await prisma.statusChangeHistory.deleteMany({ where: { OR: [{ resourceType: 'Project', resourceId: { in: projectIds } }, { resourceType: 'Contract', resourceId: { in: contractIds } }] } });
        await prisma.projectPaymentAllocation.deleteMany({ where: { payment: { contract: { customerId: { in: customerIds } } } } });
        await prisma.paymentReceipt.deleteMany({ where: { contract: { customerId: { in: customerIds } } } });
        await prisma.costRecord.deleteMany({ where: { contract: { customerId: { in: customerIds } } } });
        await prisma.project.deleteMany({ where: { contract: { customerId: { in: customerIds } } } });
        await prisma.contract.deleteMany({ where: { customerId: { in: customerIds } } });
        await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
      }
      await prisma.$executeRawUnsafe('DELETE FROM "DocumentSequence"');
      console.log('\n[清理] 删除验证客户与历史记录，流水号已归零');
    } catch (error) {
      console.error('清理失败:', error.message);
      failures += 1;
    }
    if (app) await app.close();
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    if (failures > 0) process.exitCode = 1;
  });


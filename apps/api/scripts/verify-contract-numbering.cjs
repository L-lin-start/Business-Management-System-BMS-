/**
 * 编号规则验证：合同编号人工填写 + 项目编号派生。
 *
 * 规则（用户 2026-10-14 确认）：
 *   1. 合同编号由人工填入，不再自动生成
 *   2. 非空、不含空白字符（空格/制表/换行）、不超过 50 字
 *   3. 重号直接拒绝，提示「合同编号已存在」
 *   4. 项目编号 = 人工填的合同编号 + "-" + 序号，按件数顺序下排
 *   5. 改合同编号时，其下所有项目编号**自动跟着改**（保持前缀一致）
 *
 * 用法：node scripts/verify-contract-numbering.cjs   （需先 tsc 构建出 dist）
 */
const { PrismaClient } = require('@prisma/client');
const { resetBusinessData, logResetResult, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');
const { ProjectService } = require('../dist/modules/projects/project.service');

const prisma = createTestPrismaClient();
const TEST_CUSTOMER_NAME = '编号规则验证客户（临时）';
let failures = 0;
let app;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function expectFailure(label, action, expectedFragment) {
  try {
    await action();
    check(label, false, '未抛出异常');
  } catch (error) {
    const message = error?.message ?? String(error);
    check(label, message.includes(expectedFragment), message);
  }
}

async function main() {
  logResetResult('编号规则', await resetBusinessData(prisma));
  // 清理可能残留的自定义字段定义（验证脚本曾把「客户来源」改成必填，会阻塞建客户）
  await prisma.fieldDefinition.deleteMany({ where: { fieldKey: { startsWith: 'custom_customer_' } } });

  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const contractService = app.get(ContractService);
  const projectService = app.get(ProjectService);
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true } });
  const customer = await prisma.customer.create({ data: { name: TEST_CUSTOMER_NAME } });

  console.log('=== 1. 合同编号由人工填写 ===');
  const customNo = 'HT-2026-A001';
  const created = await contractService.create(
    { customerId: customer.id, contractNo: customNo, contractType: 'PATENT', amount: 30000, itemCount: 3, signedAt: '2026-09-01' },
    admin.id,
  );
  check('保存的合同编号就是人工填的值', created.contractNo === customNo, created.contractNo);
  check('不再自动生成 HT+年份+序号', !/^HT2026\d{3}$/.test(created.contractNo), created.contractNo);

  console.log('\n=== 2. 项目编号 = 人工合同编号 + 序号 ===');
  const projects = await prisma.project.findMany({ where: { contractId: created.id }, orderBy: { sequence: 'asc' } });
  check('生成了 3 个项目', projects.length === 3, String(projects.length));
  check(
    `项目编号为 ${customNo}-1…-3`,
    projects.map((p) => p.projectNo).join(',') === `${customNo}-1,${customNo}-2,${customNo}-3`,
    projects.map((p) => p.projectNo).join(','),
  );
  check('序号顺序下排', projects.map((p) => p.sequence).join(',') === '1,2,3', projects.map((p) => p.sequence).join(','));

  console.log('\n=== 3. 编号不能为空 ===');
  await expectFailure(
    '不填合同编号 → 拒绝',
    () => contractService.create({ customerId: customer.id, contractNo: '', amount: 100, itemCount: 1 }, admin.id),
    '合同编号',
  );
  await expectFailure(
    '只填空格 → 拒绝',
    () => contractService.create({ customerId: customer.id, contractNo: '   ', amount: 100, itemCount: 1 }, admin.id),
    '合同编号',
  );

  console.log('\n=== 4. 编号不能含空白字符 ===');
  await expectFailure(
    '含空格 → 拒绝',
    () => contractService.create({ customerId: customer.id, contractNo: 'HT 2026 002', amount: 100, itemCount: 1 }, admin.id),
    '合同编号',
  );

  console.log('\n=== 5. 重号直接拒绝 ===');
  await expectFailure(
    '用已存在的编号建合同 → 拒绝',
    () => contractService.create({ customerId: customer.id, contractNo: customNo, amount: 100, itemCount: 1 }, admin.id),
    '已存在',
  );
  const countAfterDuplicate = await prisma.contract.count({ where: { contractNo: customNo } });
  check('被拒绝时未产生重复合同', countAfterDuplicate === 1, String(countAfterDuplicate));

  console.log('\n=== 6. 编号风格不限（业务怎么编都行） ===');
  const styles = ['2026-专利-001', 'ZL2026A', 'A/B/C-01', '合同编号_001'];
  for (const style of styles) {
    const record = await contractService.create(
      { customerId: customer.id, contractNo: style, amount: 100, itemCount: 1, autoGenerateProjects: false },
      admin.id,
    );
    check(`「${style}」可以保存`, record.contractNo === style, record.contractNo);
  }

  console.log('\n=== 7. 改合同编号：项目编号自动跟着改 ===');
  const renumberTarget = await contractService.create(
    { customerId: customer.id, contractNo: 'OLD-001', contractType: 'PATENT', amount: 10000, itemCount: 3 },
    admin.id,
  );
  const beforeProjects = await prisma.project.findMany({ where: { contractId: renumberTarget.id }, orderBy: { sequence: 'asc' } });
  check('改前项目编号为 OLD-001-1…3', beforeProjects.map((p) => p.projectNo).join(',') === 'OLD-001-1,OLD-001-2,OLD-001-3', beforeProjects.map((p) => p.projectNo).join(','));

  const renumbered = await contractService.update(renumberTarget.id, { version: renumberTarget.version, contractNo: 'NEW-888' }, admin.id, 'ALL');
  check('合同编号已改为 NEW-888', renumbered.contractNo === 'NEW-888', renumbered.contractNo);
  check('接口返回同步更新的项目数 = 3', renumbered.renumberedProjects === 3, String(renumbered.renumberedProjects));

  const afterProjects = await prisma.project.findMany({ where: { contractId: renumberTarget.id }, orderBy: { sequence: 'asc' } });
  check(
    '项目编号自动变成 NEW-888-1…3',
    afterProjects.map((p) => p.projectNo).join(',') === 'NEW-888-1,NEW-888-2,NEW-888-3',
    afterProjects.map((p) => p.projectNo).join(','),
  );
  check('项目 id 未变（是改编号不是重建）', afterProjects.map((p) => p.id).sort().join(',') === beforeProjects.map((p) => p.id).sort().join(','));

  const renumberAudit = await prisma.auditLog.findFirst({ where: { action: 'RENUMBER', resourceId: renumberTarget.id } });
  check('改编号写入审计日志', renumberAudit !== null && renumberAudit.reason?.includes('OLD-001'), renumberAudit?.reason ?? '(无)');

  console.log('\n=== 8. 改成已存在的编号 → 拒绝 ===');
  await expectFailure(
    '改成别人已用的编号 → 拒绝',
    () => contractService.update(renumberTarget.id, { version: renumbered.version, contractNo: customNo }, admin.id, 'ALL'),
    '已存在',
  );
  const unchanged = await prisma.contract.findUniqueOrThrow({ where: { id: renumberTarget.id }, select: { contractNo: true } });
  check('被拒绝时编号未被改动', unchanged.contractNo === 'NEW-888', unchanged.contractNo);

  console.log('\n=== 9. 编号不变时不触发项目重编号 ===');
  const current = await prisma.contract.findUniqueOrThrow({ where: { id: renumberTarget.id }, select: { version: true } });
  const noChange = await contractService.update(renumberTarget.id, { version: current.version, amount: 12000 }, admin.id, 'ALL');
  check('只改金额时不同步项目编号', noChange.renumberedProjects === 0, String(noChange.renumberedProjects));

  console.log('\n=== 10. 改编号后仍可继续按件数补建项目 ===');
  const growTarget = await contractService.create(
    { customerId: customer.id, contractNo: 'GROW-100', amount: 5000, itemCount: 2 },
    admin.id,
  );
  const grown = await contractService.update(growTarget.id, { version: growTarget.version, contractNo: 'GROW-200', itemCount: 4 }, admin.id, 'ALL');
  check('改编号同时调大件数：同步改名 2 个 + 补建 2 个', grown.renumberedProjects === 2 && grown.generatedProjectCount === 2, `改名 ${grown.renumberedProjects} / 补建 ${grown.generatedProjectCount}`);
  const grownProjects = await prisma.project.findMany({ where: { contractId: growTarget.id }, orderBy: { sequence: 'asc' } });
  check(
    '4 个项目编号连续且都用新前缀',
    grownProjects.map((p) => p.projectNo).join(',') === 'GROW-200-1,GROW-200-2,GROW-200-3,GROW-200-4',
    grownProjects.map((p) => p.projectNo).join(','),
  );

  console.log('\n=== 11. 项目编号唯一性 ===');
  const allProjectNos = await prisma.project.findMany({ select: { projectNo: true } });
  const uniqueNos = new Set(allProjectNos.map((p) => p.projectNo));
  check('全部项目编号唯一', uniqueNos.size === allProjectNos.length, `${uniqueNos.size} / ${allProjectNos.length}`);

  console.log('\n=== 12. 手工建项目的编号也由合同编号派生 ===');
  const manual = await projectService.create({ contractId: created.id, projectName: '正常补建项目' }, admin.id);
  check('手工建项目编号沿用合同编号前缀', manual.projectNo.startsWith(`${customNo}-`), manual.projectNo);
  check('序号接着已有项目下排（第 4 个）', manual.projectNo === `${customNo}-4`, manual.projectNo);
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await resetBusinessData(prisma);
      await prisma.fieldDefinition.deleteMany({ where: { fieldKey: { startsWith: 'custom_customer_' } } });
      console.log('\n[清理] 已清理业务数据与残留字段定义，编号计数器已归零');
    } catch (error) {
      console.error('清理失败:', error.message);
      failures += 1;
    }
    if (app) await app.close();
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    if (failures > 0) process.exitCode = 1;
  });

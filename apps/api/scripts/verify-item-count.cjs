/**
 * 合同按件数自动生成项目：验证脚本（真实服务 + 真实事务 + 真实数据库）。
 *
 * 覆盖：
 *   - 件数 N 生成 N 个项目，编号为 合同号-1 … 合同号-N
 *   - 项目名称默认为「合同类型 + 项目-序号」
 *   - 件数缺省为 1（不传 itemCount）
 *   - autoGenerateProjects=false 时不生成项目
 *   - 生成的项目状态为 PENDING、负责人跟随合同
 *   - 合同详情返回件数与已生成项目数
 *   - 修改合同件数不会增删已有项目
 *   - 自动生成的项目写入审计日志
 * 运行结束后清理测试数据并把流水号计数器归零。
 *
 * 用法：node scripts/verify-item-count.cjs   （需先 tsc 构建出 dist）
 */
const { resetBusinessData, logResetResult, createContractNoFactory, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');
const { PrismaClient } = require('@prisma/client');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');

const prisma = createTestPrismaClient();
const TEST_CUSTOMER_NAME = '件数验证客户（临时）';
let failures = 0;
let app;
const nextContractNo = createContractNoFactory('VERIFY-COUNT');

function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function cleanup() {
  const result = await resetBusinessData(prisma);
  console.log(`\n[清理] 已清理 客户 ${result.customers} / 合同 ${result.contracts} / 项目 ${result.projects}，流水号已归零`);
}

/**
 * 让脚本自包含：先清掉上一次可能残留的验证数据并把流水号归零，
 * 合同编号由本脚本人工指定（VERIFY-COUNT-N），不受其它验证脚本影响。
 */
async function resetFixtures() {
  const result = await resetBusinessData(prisma);
  logResetResult('件数', result);

}

async function main() {
  await resetFixtures();
  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const contractService = app.get(ContractService);
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true, displayName: true } });
  const customer = await prisma.customer.create({ data: { name: TEST_CUSTOMER_NAME, customerType: '企业' } });

  console.log('=== 1. 件数 4 生成 4 个项目（PRD 第十二章示例） ===');
  const contract = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 40000, contractType: 'COPYRIGHT', itemCount: 4, signedAt: '2026-05-01' },
    admin.id,
  );
  const firstNo = contract.contractNo;
  check(`合同号为人工填写的 ${firstNo}`, firstNo.startsWith('VERIFY-COUNT-'), firstNo);
  check('件数保存为 4', contract.itemCount === 4, String(contract.itemCount));
  check('返回自动生成项目数 4', contract.generatedProjectCount === 4, String(contract.generatedProjectCount));

  const projects = await prisma.project.findMany({
    where: { contractId: contract.id },
    orderBy: { sequence: 'asc' },
    include: { owner: { select: { displayName: true } } },
  });
  check('数据库中存在 4 个项目', projects.length === 4, `实际 ${projects.length}`);
  check(
    `项目编号为 ${firstNo}-1 … ${firstNo}-4`,
    projects.map((item) => item.projectNo).join(',') === `${firstNo}-1,${firstNo}-2,${firstNo}-3,${firstNo}-4`,
    projects.map((item) => item.projectNo).join(','),
  );
  check(
    '项目名称为「软著项目-序号」',
    projects.map((item) => item.projectName).join(',') === '软著项目-1,软著项目-2,软著项目-3,软著项目-4',
    projects.map((item) => item.projectName).join(','),
  );
  check('项目序号为 1..4', projects.map((item) => item.sequence).join(',') === '1,2,3,4', projects.map((item) => item.sequence).join(','));
  check('初始状态均为 PENDING', projects.every((item) => item.statusCode === 'PENDING'));
  check('负责人跟随合同创建人', projects.every((item) => item.owner?.displayName === admin.displayName), projects[0]?.owner?.displayName ?? 'null');
  check('所有项目都挂在同一合同下', projects.every((item) => item.contractId === contract.id));

  console.log('\n=== 2. 不传件数时缺省 1 件 ===');
  const single = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 1000, contractType: 'TRADEMARK', signedAt: '2026-05-02' },
    admin.id,
  );
  const singleProjects = await prisma.project.findMany({ where: { contractId: single.id } });
  check('缺省件数为 1', single.itemCount === 1, String(single.itemCount));
  check('只生成 1 个项目', singleProjects.length === 1, `实际 ${singleProjects.length}`);
  check(`项目编号为 ${single.contractNo}-1`, singleProjects[0]?.projectNo === `${single.contractNo}-1`, singleProjects[0]?.projectNo);

  console.log('\n=== 3. autoGenerateProjects=false 时不生成项目 ===');
  const skipped = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 2000, contractType: 'PATENT', itemCount: 3, autoGenerateProjects: false, signedAt: '2026-05-03' },
    admin.id,
  );
  const skippedProjects = await prisma.project.count({ where: { contractId: skipped.id } });
  check('件数为 3 但未生成项目', skippedProjects === 0, `实际 ${skippedProjects}`);
  check('件数仍然保存为 3', skipped.itemCount === 3, String(skipped.itemCount));

  console.log('\n=== 4. 第二个合同的序号与编号独立 ===');
  const second = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 5000, contractType: 'COPYRIGHT', itemCount: 2, signedAt: '2026-05-04' },
    admin.id,
  );
  const secondProjects = await prisma.project.findMany({ where: { contractId: second.id }, orderBy: { sequence: 'asc' } });
  check(
    `第二个合同项目编号为 ${second.contractNo}-1、${second.contractNo}-2`,
    secondProjects.map((item) => item.projectNo).join(',') === `${second.contractNo}-1,${second.contractNo}-2`,
    secondProjects.map((item) => item.projectNo).join(','),
  );

  console.log('\n=== 6. 调大件数自动补建项目 ===');
  const beforeIncrease = await prisma.project.count({ where: { contractId: contract.id } });
  const updated = await contractService.update(contract.id, { itemCount: 6 }, admin.id, 'ALL');
  const afterIncrease = await prisma.project.findMany({ where: { contractId: contract.id }, orderBy: { sequence: 'asc' } });
  const stored = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id }, select: { itemCount: true } });
  check('件数已更新为 6', stored.itemCount === 6, String(stored.itemCount));
  check('项目由 4 个补建为 6 个', afterIncrease.length === 6, `实际 ${afterIncrease.length}`);
  check('接口返回本次补建数量 2', updated.generatedProjectCount === 2, String(updated.generatedProjectCount));
  check(
    `补建项目编号连续 ${firstNo}-5、-6`,
    afterIncrease.map((item) => item.projectNo).join(',') === `${firstNo}-1,${firstNo}-2,${firstNo}-3,${firstNo}-4,${firstNo}-5,${firstNo}-6`,
    afterIncrease.map((item) => item.projectNo).join(','),
  );
  check(
    '补建项目名称延续「软著项目-序号」',
    afterIncrease[4].projectName === '软著项目-5' && afterIncrease[5].projectName === '软著项目-6',
    `${afterIncrease[4].projectName}, ${afterIncrease[5].projectName}`,
  );
  console.log(`  [INFO] 改件数前 ${beforeIncrease} 个项目`);

  console.log('\n=== 7. 件数不能调到小于已有项目数 ===');
  let decreaseError = null;
  try {
    await contractService.update(contract.id, { itemCount: 3 }, admin.id, 'ALL');
  } catch (error) {
    decreaseError = error;
  }
  check('调减被拒绝', decreaseError !== null, decreaseError?.constructor?.name ?? '未报错');
  check('拒绝原因说明已有项目数', Boolean(decreaseError?.message?.includes('6')), decreaseError?.message ?? '');
  const afterReject = await prisma.project.count({ where: { contractId: contract.id } });
  check('拒绝后项目数不变（仍为 6）', afterReject === 6, `实际 ${afterReject}`);

  console.log('\n=== 8. 删除项目后序号不复用（避免与历史编号冲突） ===');
  const last = afterIncrease[afterIncrease.length - 1];
  await prisma.project.update({ where: { id: last.id }, data: { deletedAt: new Date() } });
  await contractService.update(contract.id, { itemCount: 7 }, admin.id, 'ALL');
  const afterRecreate = await prisma.project.findMany({
    where: { contractId: contract.id, deletedAt: null },
    orderBy: { sequence: 'asc' },
  });
  // 原有 6 个，软删 1 个（在册 5 个），件数调到 7 → 补建 2 个（序号 7、8），在册回到 7 个
  check('软删一个项目后调大件数，在册项目数补足到 7', afterRecreate.length === 7, `实际在册 ${afterRecreate.length}`);
  check(
    '补建项目取用未被占用的序号（跳过已删的 -6，得到 -7 与 -8）',
    afterRecreate.map((item) => item.sequence).join(',') === '1,2,3,4,5,7,8',
    afterRecreate.map((item) => item.sequence).join(','),
  );

  console.log('\n=== 9. 合同详情回显件数与项目 ===');
  const detail = await contractService.getById(contract.id, admin.id, 'ALL');
  check('详情返回件数 7', detail.itemCount === 7, String(detail.itemCount));
  check('详情返回 7 个在册项目', detail.projects.length === 7, `实际 ${detail.projects.length}`);

  console.log('\n=== 10. 自动生成的项目有审计日志 ===');
  // 审计日志不可删除，多轮验证会累积同名记录，因此按本次合同的 resourceId 精确匹配。
  const audits = await prisma.auditLog.findMany({
    where: { resourceType: 'Project', action: 'CREATE', resourceId: { in: afterIncrease.map((item) => item.id) } },
    select: { resourceId: true, reason: true, afterData: true },
  });
  const initialAudits = audits.filter((item) => item.reason === `合同 ${contract.contractNo} 按件数 4 自动生成`);
  check('首次生成留痕 4 条', initialAudits.length === 4, `实际 ${initialAudits.length}`);
  check(
    `首次留痕覆盖全部 4 个项目编号（${firstNo}-1…4）`,
    [`${firstNo}-1`, `${firstNo}-2`, `${firstNo}-3`, `${firstNo}-4`].every((no) =>
      initialAudits.some((item) => item.afterData?.projectNo === no),
    ),
  );
  const backfillReason = `合同 ${contract.contractNo} 件数由 4 调整为 6，自动补建`;
  const backfillAudits = await prisma.auditLog.findMany({
    where: { resourceType: 'Project', action: 'CREATE', reason: backfillReason, resourceId: { in: afterIncrease.map((item) => item.id) } },
    select: { afterData: true },
  });
  check('补建留痕 2 条且说明件数调整', backfillAudits.length === 2, `实际 ${backfillAudits.length}`);
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (error) {
      console.error('清理失败:', error.message);
      failures += 1;
    }
    if (app) await app.close();
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    if (failures > 0) process.exitCode = 1;
  });




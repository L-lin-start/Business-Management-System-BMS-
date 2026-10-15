/**
 * 回款/成本改为「项目级登记、合同级汇总」后的验证（真实服务 + 真实事务 + 真实数据库）。
 *
 * 覆盖：
 *   - 合同已收款 = 其下收款单金额之和；项目回款 = 分摊到该项目的金额之和
 *   - 一笔回款可跨多个合同，并可继续分摊到项目
 *   - 合同分配合计 ≠ 回款总额 → 400
 *   - 同一项目重复分摊 → 400
 *   - 软删除项目后不能再被分摊
 *   - 成本登记在项目上、合同归属由项目带出；删除后不计入汇总
 *   - 合同详情返回已收款/成本/未收款/净收益汇总；项目详情返回本项目回款与成本
 * 运行结束后清理测试数据并把流水号计数器归零。
 *
 * 用法：node scripts/verify-payment-allocation.cjs   （需先 tsc 构建出 dist）
 */
const { resetBusinessData, logResetResult, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');
const { PrismaClient } = require('@prisma/client');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');
const { ProjectService } = require('../dist/modules/projects/project.service');
const { PaymentService } = require('../dist/modules/payments/payment.service');
const { CostService } = require('../dist/modules/costs/cost.service');

const prisma = createTestPrismaClient();
const TEST_CUSTOMER_NAME = '回款分摊验证客户（临时）';
let failures = 0;
let app;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function resetFixtures() {
  const result = await resetBusinessData(prisma);
  logResetResult('回款分摊', result);

}

async function expectFailure(label, action, expectedFragment) {
  try {
    await action();
    check(label, false, '未抛出异常');
  } catch (error) {
    const message = error?.message ?? String(error);
    check(label, !expectedFragment || message.includes(expectedFragment), message);
  }
}

async function main() {
  await resetFixtures();
  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const contractService = app.get(ContractService);
  const projectService = app.get(ProjectService);
  const paymentService = app.get(PaymentService);
  const costService = app.get(CostService);
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true } });
  const customer = await prisma.customer.create({ data: { name: TEST_CUSTOMER_NAME, customerType: '企业' } });

  console.log('=== 1. 准备两张合同，第一张 3 个项目 ===');
  const contractA = await contractService.create(
    { contractNo: 'VERIFY-PAYMENT-A', customerId: customer.id, amount: 30000, contractType: 'COPYRIGHT', itemCount: 3, signedAt: '2026-09-01' },
    admin.id,
  );
  const contractB = await contractService.create(
    { contractNo: 'VERIFY-PAYMENT-B', customerId: customer.id, amount: 10000, contractType: 'TRADEMARK', itemCount: 1, signedAt: '2026-09-02' },
    admin.id,
  );
  const projectsA = await prisma.project.findMany({ where: { contractId: contractA.id }, orderBy: { sequence: 'asc' } });
  const projectsB = await prisma.project.findMany({ where: { contractId: contractB.id }, orderBy: { sequence: 'asc' } });
  check('合同 A 生成 3 个项目', projectsA.length === 3, projectsA.map((p) => p.projectNo).join(', '));
  check('合同 B 生成 1 个项目', projectsB.length === 1, projectsB[0]?.projectNo ?? '');

  console.log('\n=== 2. 一笔回款拆到同一合同的两个项目 ===');
  const payment = await paymentService.create(
    {
      contractId: contractA.id,
      amount: 20000,
      receivedAt: '2026-09-20',
      paymentMethod: '银行转账',
      allocations: [
        { projectId: projectsA[0].id, amount: 12000 },
        { projectId: projectsA[1].id, amount: 8000 },
      ],
    },
    admin.id,
  );
  check('回款号按 HK+年份 生成', payment.receiptNo === 'HK2026001', payment.receiptNo);
  check('收款单归属合同 A', payment.contractId === contractA.id);
  check('分摊记录 2 条', payment.allocations.length === 2, String(payment.allocations.length));

  console.log('\n=== 3. 分摊校验 ===');
  await expectFailure(
    '分摊合计不等于总额 → 拒绝',
      () => paymentService.create(
        { amount: 5000, receivedAt: '2026-09-21', contractAllocations: [{ contractId: contractA.id, amount: 4000 }] },
        admin.id,
      ),
    '合同分配金额合计必须等于回款总额',
  );
  const crossPayment = await paymentService.create(
    {
      amount: 5000,
      receivedAt: '2026-09-21',
      contractAllocations: [
        { contractId: contractA.id, amount: 3000 },
        { contractId: contractB.id, amount: 2000 },
      ],
    },
    admin.id,
  );
  check('一笔回款可对应两个合同', crossPayment.contractId === null && crossPayment.contractAllocations.length === 2, String(crossPayment.contractAllocations.length));
  await expectFailure(
    '同一项目重复分摊 → 拒绝',
    () =>
      paymentService.create(
        {
          contractId: contractA.id,
          amount: 5000,
          receivedAt: '2026-09-21',
          allocations: [
            { projectId: projectsA[0].id, amount: 2000 },
            { projectId: projectsA[0].id, amount: 3000 },
          ],
        },
        admin.id,
      ),
    '不能重复分摊',
  );

  console.log('\n=== 4. 项目视角的回款 ===');
  const projectDetail1 = await projectService.getById(projectsA[0].id, admin.id, 'ALL');
  const projectDetail2 = await projectService.getById(projectsA[1].id, admin.id, 'ALL');
  const projectDetail3 = await projectService.getById(projectsA[2].id, admin.id, 'ALL');
  check('项目 1 回款 12000', projectDetail1.totals.collectedAmount === '12000.00', projectDetail1.totals.collectedAmount);
  check('项目 2 回款 8000', projectDetail2.totals.collectedAmount === '8000.00', projectDetail2.totals.collectedAmount);
  check('项目 3 回款 0', projectDetail3.totals.collectedAmount === '0.00', projectDetail3.totals.collectedAmount);
  check('项目 1 能查到这条回款的单号', projectDetail1.payments[0]?.payment?.receiptNo === 'HK2026001', projectDetail1.payments[0]?.payment?.receiptNo ?? '');

  console.log('\n=== 5. 合同视角的汇总 ===');
  const contractDetail = await contractService.getById(contractA.id, admin.id, 'ALL');
  check('合同已收款包含跨合同分配 23000', contractDetail.totals.collectedAmount === '23000.00', contractDetail.totals.collectedAmount);
  check('合同未收款 = 金额 - 已收款 = 7000', contractDetail.totals.unpaidAmount === '7000.00', contractDetail.totals.unpaidAmount);
  check('合同成本暂为 0', contractDetail.totals.costAmount === '0.00', contractDetail.totals.costAmount);
  check('合同净收益 = 23000', contractDetail.totals.netProfit === '23000.00', contractDetail.totals.netProfit);
  check('合同详情列出 2 张收款单（含跨合同回款）', contractDetail.receipts.length === 2, String(contractDetail.receipts.length));
  const splitReceipt = contractDetail.receipts.find((item) => item.receiptNo === 'HK2026001');
  check(
    '收款单分摊明细能看出落到哪些项目',
    splitReceipt?.allocations.map((item) => item.project.projectNo).join(',') === `${projectsA[0].projectNo},${projectsA[1].projectNo}`,
    splitReceipt?.allocations.map((item) => item.project.projectNo).join(',') ?? '',
  );

  console.log('\n=== 6. 一笔回款拆到全部 3 个项目后合同收款不再重复计算 ===');
  // 业务确认（2026-10-14）：允许超收，但必须带 confirmOverpay 明确确认。
  // 本用例刻意让收款超过合同金额（合同 30000，已收 23000，本次 9000），
  // 借此同时验证「超额必须确认」与「超收后汇总口径仍正确」。
  await paymentService.create(
    {
      contractId: contractA.id,
      amount: 9000,
      receivedAt: '2026-09-25',
      confirmOverpay: true,
      allocations: [
        { projectId: projectsA[0].id, amount: 3000 },
        { projectId: projectsA[1].id, amount: 3000 },
        { projectId: projectsA[2].id, amount: 3000 },
      ],
    },
    admin.id,
  );
  const contractAfter = await contractService.getById(contractA.id, admin.id, 'ALL');
  const projectSum = (
    await Promise.all(projectsA.map((item) => projectService.getById(item.id, admin.id, 'ALL')))
  ).reduce((sum, item) => sum + Number(item.totals.collectedAmount), 0);
  // 不变式：合同已收款 = 该合同的全部收款单分配金额合计（含跨合同分到本合同的份额）
  // 20000 + 3000 + 9000 = 32000
  check('合同已收款 = 各分配合计 32000', contractAfter.totals.collectedAmount === '32000.00', contractAfter.totals.collectedAmount);
  check('项目回款合计不重复计算项目分摊', projectSum === 29000, String(projectSum));

  console.log('\n=== 6b. 超额收款必须二次确认（业务确认 2026-10-14） ===');
  // 合同 A 应收净额 30000，当前已收 32000 —— 再收 1 元即为超收。
  let overpayError = null;
  try {
    await paymentService.create(
      { contractId: contractA.id, amount: 1, receivedAt: '2026-09-26', allocations: [{ projectId: projectsA[2].id, amount: 1 }] },
      admin.id,
    );
  } catch (error) {
    overpayError = error;
  }
  check('超额但不带确认 → 拒绝', overpayError !== null, overpayError ? '已拒绝' : '竟然通过了');
  check(
    '拒绝时返回可识别错误码 OVERPAY_CONFIRMATION_REQUIRED',
    overpayError?.response?.code === 'OVERPAY_CONFIRMATION_REQUIRED',
    String(overpayError?.response?.code),
  );
  check(
    '拒绝时给出超收明细（供前端弹确认框）',
    Array.isArray(overpayError?.response?.overpays) && overpayError.response.overpays.length === 1,
    JSON.stringify(overpayError?.response?.overpays ?? null),
  );
  const overDetail = overpayError?.response?.overpays?.[0];
  check('超收金额算对（应收 30000、已收 32000、本次 1 → 超 2001）', overDetail?.overAmount === 2001, String(overDetail?.overAmount));

  // 带确认即放行
  const confirmed = await paymentService.create(
    { contractId: contractA.id, amount: 1, receivedAt: '2026-09-26', confirmOverpay: true, allocations: [{ projectId: projectsA[2].id, amount: 1 }] },
    admin.id,
  );
  check('带 confirmOverpay 后允许登记（保留超收灵活性）', Number(confirmed.amount) === 1, String(confirmed.amount));
  const afterOverpay = await contractService.getById(contractA.id, admin.id, 'ALL');
  check('超收后合同已收款累计正确 32001', afterOverpay.totals.collectedAmount === '32001.00', afterOverpay.totals.collectedAmount);
  // 这笔 1 元只是用来验证放行路径，用完即软删，避免影响后续用例的金额断言
  await paymentService.softDelete(confirmed.id, admin.id, 'ALL', '验证完成，清理超额确认用例的数据');

  console.log('\n=== 7. 成本登记在项目上、合同带出归属 ===');
  const cost = await costService.create(
    { projectId: projectsA[0].id, costType: '官费', amount: 1500, incurredAt: '2026-09-22', note: '申请官费' },
    admin.id,
  );
  check('成本的合同归属由项目带出', cost.contractId === contractA.id);
  check('成本挂在项目上', cost.projectId === projectsA[0].id);

  const contractWithCost = await contractService.getById(contractA.id, admin.id, 'ALL');
  check('合同成本 = 其下项目成本之和 1500', contractWithCost.totals.costAmount === '1500.00', contractWithCost.totals.costAmount);
  // 净收益按已收款算：32000 - 1500 = 30500
  check('合同净收益 = 32000 - 1500 = 30500', contractWithCost.totals.netProfit === '30500.00', contractWithCost.totals.netProfit);
  const projectWithCost = await projectService.getById(projectsA[0].id, admin.id, 'ALL');
  check('项目净收益 = 15000 - 1500 = 13500', projectWithCost.totals.netProfit === '13500.00', projectWithCost.totals.netProfit);

  console.log('\n=== 8. 软删除后的口径 ===');
  await costService.remove(cost.id, admin.id, 'ALL', '验证软删除后口径');
  const afterCostDelete = await contractService.getById(contractA.id, admin.id, 'ALL');
  check('删除成本后合同成本回到 0', afterCostDelete.totals.costAmount === '0.00', afterCostDelete.totals.costAmount);

  const firstPayment = await prisma.paymentReceipt.findFirstOrThrow({ where: { contractId: contractA.id }, orderBy: { receivedAt: 'asc' } });
  await paymentService.softDelete(firstPayment.id, admin.id, 'ALL', '验证软删除后口径');
  const afterPaymentDelete = await contractService.getById(contractA.id, admin.id, 'ALL');
  // 删掉 20000 那张（整单归属 A）后：3000（跨合同份额）+ 9000 = 12000
  check('删除 20000 收款单后合同已收款剩 12000', afterPaymentDelete.totals.collectedAmount === '12000.00', afterPaymentDelete.totals.collectedAmount);

  const projectAfterDelete = await projectService.getById(projectsA[0].id, admin.id, 'ALL');
  check('项目 1 回款回到 3000', projectAfterDelete.totals.collectedAmount === '3000.00', projectAfterDelete.totals.collectedAmount);

  console.log('\n=== 9. 已删除项目不能再被分摊 ===');
  await projectService.softDelete(projectsA[1].id, admin.id, 'ALL', '验证已删除项目不能再被分摊');
  await expectFailure(
    '分摊到已删除项目 → 拒绝',
    () =>
      paymentService.create(
        { contractId: contractA.id, amount: 1000, receivedAt: '2026-09-30', allocations: [{ projectId: projectsA[1].id, amount: 1000 }] },
        admin.id,
      ),
    '存在无效或已删除的项目',
  );

  console.log('\n=== 10. 看板口径（已收款按收款单、成本按项目） ===');
  const dashboard = await app.get(require('../dist/modules/dashboard/dashboard.service').DashboardService).overview(admin.id, 'ALL');
  const expectedCollected = await prisma.paymentContractAllocation.aggregate({ where: { payment: { deletedAt: null } }, _sum: { amount: true } });
  const expectedCost = await prisma.costRecord.aggregate({ where: { deletedAt: null }, _sum: { amount: true } });
  check('看板已收款 = 全部有效收款单合计', dashboard.collectedAmount === Number(expectedCollected._sum.amount ?? 0).toFixed(2), dashboard.collectedAmount);
  check('看板成本 = 全部有效成本合计', dashboard.costAmount === Number(expectedCost._sum.amount ?? 0).toFixed(2), dashboard.costAmount);
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error);
    failures += 1;
  })
  .finally(async () => {
    try {
      const customers = await prisma.customer.findMany({ where: { name: TEST_CUSTOMER_NAME }, select: { id: true } });
      const ids = customers.map((item) => item.id);
      if (ids.length) {
        await prisma.projectPaymentAllocation.deleteMany({ where: { payment: { OR: [{ contract: { customerId: { in: ids } } }, { contractAllocations: { some: { contract: { customerId: { in: ids } } } } }] } } });
        await prisma.paymentContractAllocation.deleteMany({ where: { contract: { customerId: { in: ids } } } });
        await prisma.paymentReceipt.deleteMany({ where: { OR: [{ contract: { customerId: { in: ids } } }, { contractAllocations: { some: { contract: { customerId: { in: ids } } } } }] } });
        await prisma.costRecord.deleteMany({ where: { contract: { customerId: { in: ids } } } });
        await prisma.project.deleteMany({ where: { contract: { customerId: { in: ids } } } });
        await prisma.contract.deleteMany({ where: { customerId: { in: ids } } });
        await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      }
      await prisma.$executeRawUnsafe('DELETE FROM "DocumentSequence"');
      console.log(`\n[清理] 删除验证客户 ${ids.length} 个，流水号已归零`);
    } catch (error) {
      console.error('清理失败:', error.message);
      failures += 1;
    }
    if (app) await app.close();
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    if (failures > 0) process.exitCode = 1;
  });





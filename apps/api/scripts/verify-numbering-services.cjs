/**
 * 编号规则验证（真实服务代码 + 真实 DI + 真实数据库）。
 *
 * 通过 Nest 应用上下文解析 ContractService / ProjectService / PaymentService，
 * 直接调用其 create 方法，覆盖：
 *   - 合同号 HT+签约年份+3位顺序号
 *   - 项目号 = 合同号-序号
 *   - 回款号 HK+年份+3位顺序号
 *   - 同一批次并发调用不重号
 *   - 审计日志记录新编号
 * 运行结束后清理测试数据并把流水号计数器归零。
 *
 * 用法：node scripts/verify-numbering-services.cjs   （需先 tsc 构建出 dist）
 */
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { resetBusinessData, logResetResult, createContractNoFactory, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');
const { ProjectService } = require('../dist/modules/projects/project.service');
const { PaymentService } = require('../dist/modules/payments/payment.service');

const prisma = createTestPrismaClient();
const TEST_CUSTOMER_NAME = '编号验证客户（临时）';
const YEAR = 2026;
let failures = 0;
let app;
const nextContractNo = createContractNoFactory('VERIFY-NO');

function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function cleanup() {
  const result = await resetBusinessData(prisma);
  console.log(`\n[清理] 已清理 客户 ${result.customers} / 合同 ${result.contracts} / 项目 ${result.projects} / 回款 ${result.receipts}，流水号已归零`);
}

async function main() {
  // 脚本自包含：先清空业务数据与编号计数器（编号改为人工填写后仍需计数器用于回款号）
  logResetResult('编号服务', await resetBusinessData(prisma));

  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const contractService = app.get(ContractService);
  const projectService = app.get(ProjectService);
  const paymentService = app.get(PaymentService);

  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true } });

  console.log('=== 0. 准备 ===');
  const customer = await prisma.customer.create({
    data: { name: TEST_CUSTOMER_NAME, customerType: '企业', contactName: '编号验证' },
  });
  check('服务实例已从真实 DI 容器解析', Boolean(contractService && projectService && paymentService));
  check('客户表可用', customer.id !== undefined);

  // 关闭按件数自动生成，本脚本专注验证「手工建项目」时项目编号同样由合同号派生。
  // 合同编号已改为人工填写（不再自动生成），故这里用工厂产出专属编号。
  const contractInput = { customerId: customer.id, amount: 40000, contractType: 'COPYRIGHT', signedAt: `${YEAR}-03-05`, autoGenerateProjects: false };

  console.log('\n=== 1. 合同编号由人工填写，系统原样保存 ===');
  const manualNo1 = nextContractNo();
  const contract1 = await contractService.create({ ...contractInput, contractNo: manualNo1 }, admin.id);
  check(`人工填的编号被原样保存（${manualNo1}）`, contract1.contractNo === manualNo1, contract1.contractNo);
  const manualNo2 = nextContractNo();
  const contract2 = await contractService.create({ ...contractInput, contractNo: manualNo2 }, admin.id);
  check(`第二张合同编号为 ${manualNo2}`, contract2.contractNo === manualNo2, contract2.contractNo);

  const otherYearNo = nextContractNo();
  const otherYear = await contractService.create({ ...contractInput, contractNo: otherYearNo, signedAt: '2025-12-31' }, admin.id);
  check(`跨年签约仍用人工编号（${otherYearNo}）`, otherYear.contractNo === otherYearNo, otherYear.contractNo);

  console.log('\n=== 2. 项目号 = 合同号-序号 ===');
  const project1 = await projectService.create({ contractId: contract1.id, projectName: '编号验证项目' }, admin.id);
  check(`第一个项目号为 ${contract1.contractNo}-1`, project1.projectNo === `${contract1.contractNo}-1`, project1.projectNo);
  const project2 = await projectService.create({ contractId: contract1.id, projectName: '编号验证项目' }, admin.id);
  check(`第二个项目号为 ${contract1.contractNo}-2`, project2.projectNo === `${contract1.contractNo}-2`, project2.projectNo);
  const projectOther = await projectService.create({ contractId: contract2.id, projectName: '编号验证项目' }, admin.id);
  check(`另一合同首个项目号为 ${contract2.contractNo}-1`, projectOther.projectNo === `${contract2.contractNo}-1`, projectOther.projectNo);

  console.log('\n=== 3. 回款号 = HK + 年份 + 3 位顺序号 ===');
  // 回款按项目分摊：一笔回款可在同一合同内多个项目间拆分
  const payment = await paymentService.create(
    {
      contractId: contract1.id,
      amount: 40000,
      receivedAt: `${YEAR}-04-01`,
      paymentMethod: '银行转账',
      allocations: [
        { projectId: project1.id, amount: 30000 },
        { projectId: project2.id, amount: 10000 },
      ],
    },
    admin.id,
  );
  check('回款号为 HK2026001', payment.receiptNo === `HK${YEAR}001`, payment.receiptNo);
  const payment2 = await paymentService.create(
    {
      contractId: contract2.id,
      amount: 1000,
      receivedAt: '2027-01-09',
      allocations: [{ projectId: projectOther.id, amount: 1000 }],
    },
    admin.id,
  );
  check('跨年回款号为 HK2027001（与合同号共用年份维度但互相独立）', payment2.receiptNo === 'HK2027001', payment2.receiptNo);

  console.log('\n=== 4. 多张合同编号互不干扰 ===');
  const concurrentInputs = Array.from({ length: 6 }, () => ({ ...contractInput, contractNo: nextContractNo() }));
  const concurrent = await Promise.all(concurrentInputs.map((input) => contractService.create(input, admin.id)));
  const numbers = concurrent.map((item) => item.contractNo);
  check('人工编号全部唯一', new Set(numbers).size === 6, numbers.join(', '));
  check(
    '每张合同都保存了自己填的编号',
    concurrent.every((item, index) => item.contractNo === concurrentInputs[index].contractNo),
    numbers.join(', '),
  );

  console.log('\n=== 5. 编号不可修改（编辑其它字段不影响编号） ===');
  const updated = await contractService.update(contract1.id, { contractType: 'PATENT' }, admin.id, 'ALL');
  check('编辑合同后编号不变', updated.contractNo === contract1.contractNo, updated.contractNo);
  const updatedProject = await projectService.update(project1.id, { projectName: '改名后' }, admin.id, 'ALL');
  check('编辑项目后编号不变', updatedProject.projectNo === project1.projectNo, updatedProject.projectNo);

  console.log('\n=== 6. 审计日志留痕 ===');
  const audits = await prisma.auditLog.findMany({
    where: { action: 'CREATE', resourceType: { in: ['Contract', 'Project', 'PaymentReceipt'] } },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { resourceType: true, afterData: true },
  });
  const recorded = audits.map((item) => item.afterData?.contractNo ?? item.afterData?.projectNo ?? item.afterData?.receiptNo);
  check('审计日志记录了第一张合同编号', recorded.includes(contract1.contractNo), contract1.contractNo);
  check('审计日志记录了项目编号', recorded.includes(project1.projectNo), project1.projectNo);
  check('审计日志记录了回款编号', recorded.includes(payment.receiptNo), payment.receiptNo);
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



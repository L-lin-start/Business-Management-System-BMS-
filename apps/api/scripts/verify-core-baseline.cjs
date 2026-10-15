/**
 * 核心基线的隔离验证：只创建并清理本脚本自己的客户、合同和回款。
 * 不会清空开发库中的其他业务数据。
 */
const { PrismaClient } = require('@prisma/client');
const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');
const { PaymentService } = require('../dist/modules/payments/payment.service');

const prisma = createTestPrismaClient();
const marker = `核心基线验证-${Date.now()}`;
let app;

function check(label, condition, detail = '') {
  if (!condition) throw new Error(`${label}${detail ? `：${detail}` : ''}`);
  console.log(`PASS ${label}`);
}

async function main() {
  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const contractService = app.get(ContractService);
  const paymentService = app.get(PaymentService);
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true } });
  const customer = await prisma.customer.create({ data: { name: marker, customerType: '企业', ownerId: admin.id } });

  const contractA = await contractService.create({ customerId: customer.id, amount: 1000, contractType: 'PROJECT', itemCount: 1, businessStartAt: '2026-09-01' }, admin.id);
  const contractB = await contractService.create({ customerId: customer.id, amount: 500, contractType: 'PROJECT', itemCount: 1, businessStartAt: '2026-09-02' }, admin.id);
  check('合同保存人工业务起算日', contractA.businessStartAt instanceof Date);

  const payment = await paymentService.create({
    amount: 300,
    receivedAt: '2026-09-20',
    contractAllocations: [
      { contractId: contractA.id, amount: 200 },
      { contractId: contractB.id, amount: 100 },
    ],
  }, admin.id);
  check('一笔回款可对应多个合同', payment.contractId === null && payment.contractAllocations.length === 2);

  const detailA = await contractService.getById(contractA.id, admin.id, 'ALL');
  const detailB = await contractService.getById(contractB.id, admin.id, 'ALL');
  check('合同 A 只统计自己的分配金额', detailA.totals.collectedAmount === '200.00', detailA.totals.collectedAmount);
  check('合同 B 只统计自己的分配金额', detailB.totals.collectedAmount === '100.00', detailB.totals.collectedAmount);

  try {
    await contractService.update(contractA.id, { version: detailA.version, statusCode: 'COMPLETED' }, admin.id, 'ALL');
    throw new Error('未阻止未完成合同直接标记完成');
  } catch (error) {
    check('合同完成条件校验生效', String(error.message).includes('全部项目完成'));
  }
}

main().finally(async () => {
  const customers = await prisma.customer.findMany({ where: { name: marker }, select: { id: true } });
  const customerIds = customers.map((item) => item.id);
  const contractIds = (await prisma.contract.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } })).map((item) => item.id);
  const paymentIds = (await prisma.paymentReceipt.findMany({ where: { contractAllocations: { some: { contractId: { in: contractIds } } } }, select: { id: true } })).map((item) => item.id);
  await prisma.projectPaymentAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await prisma.paymentContractAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await prisma.paymentReceipt.deleteMany({ where: { id: { in: paymentIds } } });
  await prisma.statusChangeHistory.deleteMany({ where: { resourceId: { in: contractIds } } });
  await prisma.auditLog.deleteMany({ where: { resourceId: { in: [...contractIds, ...paymentIds] } } });
  await prisma.project.deleteMany({ where: { contractId: { in: contractIds } } });
  await prisma.contract.deleteMany({ where: { id: { in: contractIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  if (app) await app.close();
  await prisma.$disconnect();
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

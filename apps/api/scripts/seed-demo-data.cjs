/**
 * 演示数据：给开发库灌一批像真实业务的客户 / 合同 / 项目 / 回款 / 成本，
 * 便于打开界面到处点、验证功能，不必每次手工录入。
 *
 * 用法：
 *   node scripts/seed-demo-data.cjs            # 灌到开发库（DATABASE_URL）
 *   node scripts/seed-demo-data.cjs --reset    # 先清空业务数据再灌
 *   node scripts/seed-demo-data.cjs --test     # 灌到测试库（TEST_DATABASE_URL）
 *
 * 说明：
 *   - 只动业务数据（客户/合同/项目/回款/成本），不动用户、角色、权限、流程模板等配置；
 *   - 用真实的 Service 层创建，因此会走完整校验、自动生成编号、按件数生成项目、绑定流程；
 *   - 合同编号为人工指定（新规则），前缀统一用 DEMO- 便于识别与整体清理。
 */
const path = require('node:path');
const fs = require('node:fs');

// 手动加载 .env（不依赖 dotenv）：脚本可能在 prisma 等目录下以其它 cwd 运行
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const useTest = process.argv.includes('--test');
const doReset = process.argv.includes('--reset');
const targetUrl = useTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
if (!targetUrl) {
  console.error(`未找到 ${useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'}，请检查 apps/api/.env`);
  process.exit(1);
}
process.env.DATABASE_URL = targetUrl;

const { PrismaClient } = require('@prisma/client');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { CustomerService } = require('../dist/modules/customers/customer.service');
const { ContractService } = require('../dist/modules/contracts/contract.service');
const { PaymentService } = require('../dist/modules/payments/payment.service');
const { CostService } = require('../dist/modules/costs/cost.service');

const prisma = new PrismaClient({ datasources: { db: { url: targetUrl } } });

/** 演示数据定义：客户 → 合同 → 项目上的回款/成本 */
const DEMO = [
  {
    customer: { name: '星海智能科技有限公司', customerType: '企业客户', contactName: '陈志远', phone: '13811110001', email: 'chen@xinghai-demo.com', address: '上海市浦东新区张江路 88 号' },
    contracts: [
      { contractNo: 'DEMO-2026-001', contractType: 'PATENT', product: '发明专利代理服务', amount: 90000, itemCount: 3, unitPrice: 30000, paymentTerm: 'INSTALLMENT', signedAt: '2026-08-05', remark: '分两期支付，首期 50%' },
    ],
  },
  {
    customer: { name: '云图网络技术有限公司', customerType: '企业客户', contactName: '林晓', phone: '13811110002', email: 'lin@yuntu-demo.com', address: '北京市海淀区中关村大街 1 号' },
    contracts: [
      { contractNo: 'DEMO-2026-002', contractType: 'TRADEMARK', product: '商标注册代理', amount: 24000, itemCount: 4, unitPrice: 6000, paymentTerm: 'FULL', signedAt: '2026-08-20' },
      { contractNo: 'DEMO-2026-003', contractType: 'COPYRIGHT', product: '软件著作权登记', amount: 15000, itemCount: 3, unitPrice: 5000, paymentTerm: 'FULL', signedAt: '2026-09-10' },
    ],
  },
  {
    customer: { name: '恒信医疗器械股份有限公司', customerType: '企业客户', contactName: '王海涛', phone: '13811110003', email: 'wang@hengxin-demo.com', address: '广州市天河区珠江新城 66 号' },
    contracts: [
      { contractNo: 'DEMO-2026-004', contractType: 'PATENT', product: '实用新型专利代理', amount: 48000, itemCount: 4, unitPrice: 12000, paymentTerm: 'INSTALLMENT', signedAt: '2026-09-01' },
    ],
  },
];

/** 回款计划：按合同编号指定，分摊到该项目下的前 N 个项目 */
const PAYMENTS = [
  { contractNo: 'DEMO-2026-001', amount: 45000, receivedAt: '2026-08-10', paymentMethod: '银行转账', note: '首期款 50%', spreadTo: 2 },
  { contractNo: 'DEMO-2026-001', amount: 20000, receivedAt: '2026-09-25', paymentMethod: '银行转账', note: '中期款', spreadTo: 1 },
  { contractNo: 'DEMO-2026-002', amount: 24000, receivedAt: '2026-08-28', paymentMethod: '对公转账', note: '全款', spreadTo: 4 },
  { contractNo: 'DEMO-2026-004', amount: 24000, receivedAt: '2026-09-15', paymentMethod: '银行转账', note: '首期款', spreadTo: 2 },
];

/** 成本计划：按合同编号指定，挂到该项目上 */
const COSTS = [
  { contractNo: 'DEMO-2026-001', costType: '官费', amount: 4500, incurredAt: '2026-08-12', note: '发明专利申请费' },
  { contractNo: 'DEMO-2026-001', costType: '代理成本', amount: 6000, incurredAt: '2026-08-15', note: '外部撰写费' },
  { contractNo: 'DEMO-2026-002', costType: '官费', amount: 1200, incurredAt: '2026-08-25', note: '商标规费' },
  { contractNo: 'DEMO-2026-004', costType: '官费', amount: 2000, incurredAt: '2026-09-05', note: '实用新型申请费' },
];

async function main() {
  console.log(`目标数据库：${targetUrl.replace(/^[^:]+:[^@]+@/, '***@')}${useTest ? '（测试库）' : '（开发库）'}\n`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const customerService = app.get(CustomerService);
  const contractService = app.get(ContractService);
  const paymentService = app.get(PaymentService);
  const costService = app.get(CostService);

  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true, displayName: true } });
  console.log(`操作人：${admin.displayName}\n`);

  if (doReset) {
    console.log('--reset：清空既有业务数据…');
    await prisma.projectPaymentAllocation.deleteMany({});
    await prisma.paymentContractAllocation.deleteMany({});
    await prisma.paymentReceipt.deleteMany({});
    await prisma.costRecord.deleteMany({});
    await prisma.contractAmountAdjustment.deleteMany({});
    await prisma.project.deleteMany({});
    await prisma.contract.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.statusChangeHistory.deleteMany({});
    await prisma.projectNodeHistory.deleteMany({});
    await prisma.reminder.deleteMany({});
    await prisma.$executeRawUnsafe('DELETE FROM "DocumentSequence"');
    console.log('  已清空\n');
  }

  /** 合同编号 → { contract, projects }，供后面的回款/成本引用 */
  const created = new Map();

  for (const group of DEMO) {
    // 客户：ownerId 交给服务端按角色规则处理（管理员可指派，这里显式指派给 admin）
    const customer = await customerService.create({ ...group.customer, ownerId: admin.id }, admin.id);
    console.log(`客户：${customer.name}`);

    for (const spec of group.contracts) {
      const contract = await contractService.create({ ...spec, customerId: customer.id, ownerId: admin.id }, admin.id);
      const projects = await prisma.project.findMany({ where: { contractId: contract.id }, orderBy: { sequence: 'asc' } });
      created.set(spec.contractNo, { contract, projects });
      console.log(`  合同：${contract.contractNo}（${spec.contractType}，¥${Number(spec.amount).toLocaleString('zh-CN')}，${projects.length} 个项目）`);
      console.log(`    项目：${projects.map((p) => p.projectNo).join('、')}`);
    }
  }

  console.log('\n登记回款：');
  for (const plan of PAYMENTS) {
    const target = created.get(plan.contractNo);
    if (!target) continue;
    const projects = target.projects.slice(0, plan.spreadTo);
    // 平均分摊，余数给第一个项目，保证分摊合计等于回款总额
    const per = Math.floor((plan.amount / projects.length) * 100) / 100;
    let allocated = 0;
    const allocations = projects.map((project, index) => {
      const amount = index === projects.length - 1 ? Number((plan.amount - allocated).toFixed(2)) : per;
      allocated = Number((allocated + amount).toFixed(2));
      return { projectId: project.id, amount };
    });
    const payment = await paymentService.create(
      { contractId: target.contract.id, amount: plan.amount, receivedAt: plan.receivedAt, paymentMethod: plan.paymentMethod, note: plan.note, allocations },
      admin.id,
    );
    console.log(`  ${payment.receiptNo}  ${plan.contractNo}  ¥${plan.amount.toLocaleString('zh-CN')}  ${plan.note}`);
  }

  console.log('\n登记成本：');
  for (const plan of COSTS) {
    const target = created.get(plan.contractNo);
    if (!target) continue;
    const project = target.projects[0];
    const cost = await costService.create(
      { projectId: project.id, costType: plan.costType, amount: plan.amount, incurredAt: plan.incurredAt, note: plan.note },
      admin.id,
    );
    console.log(`  ${plan.contractNo}  ${project.projectNo}  ${plan.costType}  ¥${plan.amount.toLocaleString('zh-CN')}`);
  }

  // 让部分项目往前推几步，这样流程面板上能看到不同节点、不同负责人
  console.log('\n推进部分项目（让流程分布在不同节点）：');
  const { TransitionService } = require('../dist/modules/workflows/transition.service');
  const transitionService = app.get(TransitionService);
  const advancePlan = [
    { contractNo: 'DEMO-2026-001', index: 0, steps: 2, reason: '演示：已提交并受理' },
    { contractNo: 'DEMO-2026-001', index: 1, steps: 1, reason: '演示：已提交' },
    { contractNo: 'DEMO-2026-002', index: 0, steps: 3, reason: '演示：推到最后阶段' },
    { contractNo: 'DEMO-2026-004', index: 0, steps: 1, reason: '演示：已提交' },
  ];
  for (const plan of advancePlan) {
    const target = created.get(plan.contractNo);
    if (!target) continue;
    const project = target.projects[plan.index];
    if (!project) continue;
    for (let i = 0; i < plan.steps; i += 1) {
      const current = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { version: true, currentNodeCode: true } });
      const view = await transitionService.availableTransitions(project.id, admin.id, 'ALL');
      if (!view.nextNode) break;
      await transitionService.transition(project.id, { version: current.version, reason: plan.reason }, admin.id, 'ALL');
    }
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { currentNodeCode: true } });
    console.log(`  ${project.projectNo} → 当前节点 ${after.currentNodeCode}`);
  }

  console.log('\n统计：');
  const [customers, contracts, projects, receipts, costs] = await prisma.$transaction([
    prisma.customer.count(),
    prisma.contract.count(),
    prisma.project.count(),
    prisma.paymentReceipt.count(),
    prisma.costRecord.count(),
  ]);
  console.log(`  客户 ${customers} / 合同 ${contracts} / 项目 ${projects} / 回款 ${receipts} / 成本 ${costs}`);
  console.log('\n演示数据准备完成。打开 http://127.0.0.1:5173 即可查看。');
  console.log('（合同编号均以 DEMO- 开头，便于识别与整体清理）');

  await app.close();
}

main()
  .catch((error) => {
    console.error('\n生成演示数据失败：', error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

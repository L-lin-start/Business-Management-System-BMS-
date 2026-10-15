#!/usr/bin/env node
/**
 * 端到端流程测试数据准备（幂等，可反复执行）。
 *
 * ## 做什么
 *
 * 1. 把所有账号（含新建的专利代理）密码统一设为 `11111111`
 * 2. 补建缺失的「专利代理人」账号（专利流程的「提交申请」「审查」归该角色，原先无人）
 * 3. 为每个账号建一个专属客户 + 合同 + 项目，负责人各不相同
 * 4. 特意把项目停在**不同节点**，使每个角色登录后都有活在手上
 *
 * ## 为什么用真实链路而不是直接插数据库
 *
 * 走 `ContractService.create` 会一并生成：合同编号、项目编号、流程版本绑定、
 * 首节点进入时间、审计日志。直接 INSERT 会缺这些，测出来的行为不算数。
 *
 * ## 用法
 *
 *   cd apps/api; node scripts/seed-e2e-test-data.cjs
 *
 * 数据都带 `E2E-` 前缀，测试完整理时可据此识别。
 */
require('reflect-metadata');
const bcrypt = require('bcryptjs');
const { NestFactory } = require('@nestjs/core');
const { PrismaClient } = require('@prisma/client');
const { AppModule } = require('../dist/app.module');
const { ContractService } = require('../dist/modules/contracts/contract.service');
const { TransitionService } = require('../dist/modules/workflows/transition.service');

/** 统一测试密码：8 位纯数字，满足 MinLength(8) 且无复杂度要求 */
const PASSWORD = '11111111';

const prisma = new PrismaClient({
  datasources: { db: { url: 'postgresql://bms_dev:BmsDev_2026_Q7m9L2x8R4v6@localhost:5432/business_management_dev' } },
});

/**
 * 测试场景定义。
 *
 * `stopAtNode` 用来把项目**提前推进到指定节点**，让"当前节点负责人"正好是
 * 我们想测的那个角色 —— 这样登录该角色就能真正做一次推进，而不是看到"不归我"。
 */
const SCENARIOS = [
  {
    key: 'salesA-patent',
    account: { username: 'aaa', displayName: '销售A' },
    customerName: 'E2E-华宇智能科技有限公司',
    contractNo: 'E2E-SALES-A-专利',
    contractType: 'PATENT',
    contractTypeLabel: '专利',
    amount: 12000,
    stopAtNode: null, // 停在首节点「提交申请」，由专利代理人开第一枪
    note: '销售A 负责；专利流程，首节点归专利代理人',
  },
  {
    key: 'salesA-trademark',
    account: { username: 'aaa', displayName: '销售A' },
    customerName: 'E2E-华宇智能科技有限公司',
    contractNo: 'E2E-SALES-A-商标',
    contractType: 'TRADEMARK',
    contractTypeLabel: '商标',
    amount: 8000,
    stopAtNode: null, // 首节点「提交申请」归商标代理人
    note: '销售A 负责；商标流程，首节点归商标代理人',
  },
  {
    key: 'salesB-copyright',
    account: { username: 'bbb', displayName: '销售B' },
    customerName: 'E2E-蓝鲸软件股份有限公司',
    contractNo: 'E2E-SALES-B-软著',
    contractType: 'COPYRIGHT',
    contractTypeLabel: '软著',
    amount: 6000,
    stopAtNode: null, // 软著全部节点归流程人员
    note: '销售B 负责；软著流程，节点归流程人员',
  },
  {
    key: 'general-process',
    account: { username: 'lll', displayName: '流程' },
    customerName: 'E2E-远航物流有限公司',
    contractNo: 'E2E-通用流程',
    contractType: 'OTHER',
    contractTypeLabel: '其他',
    amount: 5000,
    // 停到「内部审核」：该节点归申报复核人，用来测"跨角色交接"
    stopAtNode: 'INTERNAL_REVIEW',
    note: '流程人员负责；走通用流程（8 节点），停在「内部审核」由申报复核人接手',
  },
];

async function main() {
  console.log('=== 端到端测试数据准备 ===\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const contractService = app.get(ContractService);
  const transitionService = app.get(TransitionService);

  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });

  // ---------- 1. 账号：补建专利代理 + 统一密码 ----------
  console.log('[1/4] 账号准备');
  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  let patentAgent = await prisma.user.findFirst({ where: { username: 'zldl' } });
  if (!patentAgent) {
    const role = await prisma.role.findFirstOrThrow({ where: { code: 'PATENT_AGENT' } });
    const rootDept = await prisma.department.findFirst({ where: { parentId: null }, orderBy: { createdAt: 'asc' } });
    patentAgent = await prisma.user.create({
      data: {
        username: 'zldl',
        displayName: '专利代理',
        passwordHash,
        status: 'ACTIVE',
        roles: { create: [{ roleId: role.id }] },
        ...(rootDept ? { departments: { create: [{ departmentId: rootDept.id, isPrimary: true }] } } : {}),
      },
    });
    console.log(`  ✅ 新建账号 专利代理（zldl）—— 原 PATENT_AGENT 角色下无任何用户`);
  } else {
    console.log('  - 账号 专利代理（zldl）已存在');
  }

  const resetResult = await prisma.user.updateMany({
    where: { deletedAt: null },
    data: { passwordHash },
  });
  console.log(`  ✅ 已把 ${resetResult.count} 个账号密码统一为 ${PASSWORD}`);

  const accounts = await prisma.user.findMany({
    where: { deletedAt: null },
    include: { roles: { include: { role: { select: { code: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log('');
  for (const item of accounts) {
    const roleCode = item.roles.map((x) => x.role.code).join('、') || '（无角色）';
    console.log(`    ${String(item.username).padEnd(10)} ${String(item.displayName).padEnd(10)} ${roleCode}`);
  }

  // ---------- 2. 客户 ----------
  console.log('\n[2/4] 客户');
  const customerIds = {};
  for (const scenario of SCENARIOS) {
    if (customerIds[scenario.customerName]) continue;
    let customer = await prisma.customer.findFirst({ where: { name: scenario.customerName, deletedAt: null } });
    if (!customer) {
      // 客户负责人跟随场景账号（客户归属规则：管理者可自由指派）
      const owner = await prisma.user.findFirstOrThrow({ where: { username: scenario.account.username } });
      customer = await prisma.customer.create({
        data: {
          name: scenario.customerName,
          ownerId: owner.id,
          contactName: '测试联系人',
          phone: '13800000000',
          email: `e2e-${scenario.key}@example.com`,
          address: '上海市浦东新区测试路 1 号',
        },
      });
      console.log(`  ✅ 新建客户 ${customer.name}`);
    } else {
      console.log(`  - 客户已存在 ${customer.name}`);
    }
    customerIds[scenario.customerName] = customer.id;
  }

  // ---------- 3. 合同（自动生成项目）----------
  console.log('\n[3/4] 合同与项目');
  const created = [];
  for (const scenario of SCENARIOS) {
    const existing = await prisma.contract.findFirst({ where: { contractNo: scenario.contractNo, deletedAt: null } });
    if (existing) {
      console.log(`  - 合同已存在，跳过 ${scenario.contractNo}`);
      created.push({ scenario, contract: existing });
      continue;
    }

    const owner = await prisma.user.findFirstOrThrow({ where: { username: scenario.account.username } });
    const contract = await contractService.create(
      {
        contractNo: scenario.contractNo,
        customerId: customerIds[scenario.customerName],
        contractType: scenario.contractType,
        amount: scenario.amount,
        itemCount: 1,
        ownerId: owner.id,
        remark: `端到端流程测试：${scenario.note}`,
      },
      admin.id,
      'ALL',
    );
    console.log(`  ✅ 新建合同 ${contract.contractNo}（${scenario.contractTypeLabel}，负责人=${scenario.account.displayName}）`);
    created.push({ scenario, contract });
  }

  // ---------- 4. 把项目推进到指定节点 ----------
  console.log('\n[4/4] 项目节点定位');
  const finalRows = [];
  for (const { scenario, contract } of created) {
    const projects = await prisma.project.findMany({
      where: { contractId: contract.id, deletedAt: null },
      orderBy: { sequence: 'asc' },
    });
    for (const project of projects) {
      // 项目负责人默认跟随合同创建人，这里改成场景账号，便于用该账号登录验证数据范围
      const owner = await prisma.user.findFirstOrThrow({ where: { username: scenario.account.username } });
      if (project.ownerId !== owner.id) {
        await prisma.project.update({ where: { id: project.id }, data: { ownerId: owner.id } });
      }

      if (scenario.stopAtNode) {
        const current = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { currentNodeCode: true } });
        if (current.currentNodeCode !== scenario.stopAtNode) {
          // 只能逐节点推进（transition 明确拒绝跳节点），所以循环；
          // 每推一步版本号都会 +1，必须重新读，否则乐观锁直接 409。
          // admin 不受节点分派限制，所以可以一路代推到位。
          const path = [];
          for (let step = 0; step < 12; step += 1) {
            const snapshot = await prisma.project.findUniqueOrThrow({
              where: { id: project.id },
              select: { currentNodeCode: true, version: true },
            });
            if (snapshot.currentNodeCode === scenario.stopAtNode) break;
            try {
              await transitionService.transition(
                project.id,
                { version: snapshot.version, reason: '端到端测试数据准备：定位到指定节点' },
                admin.id,
                'ALL',
              );
              const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { currentNodeCode: true } });
              path.push(after.currentNodeCode);
            } catch (error) {
              console.log(`  ⚠ ${project.projectNo} 推进中断：${error instanceof Error ? error.message : error}`);
              break;
            }
          }
          const landed = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { currentNodeCode: true } });
          if (landed.currentNodeCode === scenario.stopAtNode) {
            console.log(`  ✅ ${project.projectNo} 已推进到 ${scenario.stopAtNode}（路径 ${path.join(' → ')}）`);
          } else {
            console.log(`  ⚠ ${project.projectNo} 未能到达 ${scenario.stopAtNode}，当前为 ${landed.currentNodeCode}`);
          }
        }
      }

      const after = await prisma.project.findUniqueOrThrow({
        where: { id: project.id },
        select: { projectNo: true, projectName: true, statusCode: true, currentNodeCode: true, owner: { select: { displayName: true } } },
      });
      finalRows.push({
        contractNo: contract.contractNo,
        label: scenario.contractTypeLabel,
        owner: after.owner?.displayName ?? '（无）',
        projectNo: after.projectNo,
        status: after.statusCode,
        node: after.currentNodeCode ?? '-',
      });
    }
  }

  console.log('\n=== 最终数据 ===');
  console.log('合同号'.padEnd(20) + '类型'.padEnd(6) + '项目负责人'.padEnd(12) + '项目号'.padEnd(20) + '状态'.padEnd(14) + '当前节点');
  for (const row of finalRows) {
    console.log(
      String(row.contractNo).padEnd(20) +
        String(row.label).padEnd(6) +
        String(row.owner).padEnd(12) +
        String(row.projectNo).padEnd(20) +
        String(row.status).padEnd(14) +
        String(row.node),
    );
  }

  await app.close();
}

main()
  .catch((error) => {
    console.error('\n准备失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());



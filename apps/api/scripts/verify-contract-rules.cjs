/**
 * 阶段 3.1 验证：PRD 合同字段补齐 + 合同终止 + 金额调整。
 *
 * 覆盖（对照 PRD 4.2 / 4.11 / 5.7 / 8.1 / 8.2）：
 *   - PRD 8.2 补齐的字段：产品、单价、付款方式、备注、联系人快照
 *   - 单价 × 件数 与合同金额不一致时给出提示（不阻止保存）
 *   - 付款方式只接受系统 B 配置的选项
 *   - 联系人快照：留空取客户当前值；客户信息变更不改写历史合同
 *   - 合同终止 5 要素齐全 + 终止类型/处理方式必须是配置好的选项
 *   - 「项目一并终止」把未完成项目置为已终止，已完成项目保持完成
 *   - 重复终止被拒绝；乐观锁冲突返回 409
 *   - 金额调整：单独记账不改原金额；调整后应收不得小于已收款
 *   - 汇总口径：未收款 = 合同金额 - 已收款 - 累计调整额
 *   - 撤销调整用软删除，保留痕迹
 *
 * 用法：node scripts/verify-contract-rules.cjs   （需先 tsc 构建出 dist）
 */
const { PrismaClient } = require('@prisma/client');
const { resetBusinessData, logResetResult, createContractNoFactory, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');

const prisma = createTestPrismaClient();
const TEST_CUSTOMER_NAME = '合同规则验证客户（临时）';
let failures = 0;
let app;
const nextContractNo = createContractNoFactory('VERIFY-RULE');

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
  logResetResult('合同规则', await resetBusinessData(prisma));

  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const contractService = app.get(ContractService);
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true, displayName: true } });
  const customer = await prisma.customer.create({
    data: { name: TEST_CUSTOMER_NAME, contactName: '张三', phone: '13800000000', email: 'zhangsan@example.com', address: '上海市浦东新区' },
  });

  console.log('=== 1. PRD 8.2 补齐的合同字段 ===');
  const created = await contractService.create(
    {
      contractNo: nextContractNo(), customerId: customer.id,
      contractType: 'PATENT',
      product: '发明专利代理服务',
      amount: 30000,
      unitPrice: 15000,
      itemCount: 2,
      paymentTerm: 'INSTALLMENT',
      remark: '分两期支付',
      signedAt: '2026-09-01',
    },
    admin.id,
  );
  check('产品已保存', created.product === '发明专利代理服务', String(created.product));
  check('单价已保存', Number(created.unitPrice) === 15000, String(created.unitPrice));
  check('付款方式已保存（编码）', created.paymentTerm === 'INSTALLMENT', String(created.paymentTerm));
  check('备注已保存', created.remark === '分两期支付', String(created.remark));
  check('单价 × 件数 = 金额 → 无提示', created.amountWarning === null, String(created.amountWarning));

  console.log('\n=== 2. 联系人快照（留空时取客户当前值） ===');
  check('公司名称取自客户名称', created.companyName === TEST_CUSTOMER_NAME, String(created.companyName));
  check('联系人取自客户', created.contactName === '张三', String(created.contactName));
  check('联系电话取自客户', created.contactPhone === '13800000000', String(created.contactPhone));
  check('联系人邮箱取自客户（PRD 8.1 客户邮箱字段）', created.contactEmail === 'zhangsan@example.com', String(created.contactEmail));
  check('公司地址取自客户', created.companyAddress === '上海市浦东新区', String(created.companyAddress));

  // 客户信息变更后，历史合同的快照不应被改写
  await prisma.customer.update({
    where: { id: customer.id },
    data: { name: '改名后的公司', contactName: '李四', phone: '13900000000' },
  });
  const afterCustomerChange = await contractService.getById(created.id, admin.id, 'ALL');
  check('客户改名后历史合同快照不变', afterCustomerChange.companyName === TEST_CUSTOMER_NAME, String(afterCustomerChange.companyName));
  check('客户联系变更后历史合同联系人不变', afterCustomerChange.contactName === '张三', String(afterCustomerChange.contactName));

  console.log('\n=== 3. 单价与金额不一致时提示 ===');
  const mismatch = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 20000, unitPrice: 15000, itemCount: 2, signedAt: '2026-09-02' },
    admin.id,
  );
  check('不一致时返回提示而非报错', typeof mismatch.amountWarning === 'string', String(mismatch.amountWarning));
  check('提示里给出算出的金额', mismatch.amountWarning?.includes('30000.00') === true, String(mismatch.amountWarning));

  console.log('\n=== 4. 付款方式受控 ===');
  await expectFailure(
    '提交未配置的付款方式 → 拒绝',
    () => contractService.create({ contractNo: nextContractNo(), customerId: customer.id, amount: 100, paymentTerm: '随便写的', signedAt: '2026-09-03' }, admin.id),
    '不在可选范围内',
  );
  const fullPay = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 100, paymentTerm: '全款', signedAt: '2026-09-03' },
    admin.id,
  );
  check('按中文标签「全款」也能提交并归一为编码', fullPay.paymentTerm === 'FULL', String(fullPay.paymentTerm));

  console.log('\n=== 5. 合同终止：PRD 4.2 的 5 个要素 ===');
  const terminateTarget = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 50000, contractType: 'PATENT', itemCount: 3, signedAt: '2026-09-05' },
    admin.id,
  );
  const projects = await prisma.project.findMany({ where: { contractId: terminateTarget.id }, orderBy: { sequence: 'asc' } });
  check('生成 3 个项目', projects.length === 3, String(projects.length));
  // 把第 1 个项目置为已完成，验证终止时不会被改掉
  await prisma.project.update({ where: { id: projects[0].id }, data: { statusCode: 'COMPLETED' } });

  await expectFailure(
    '终止类型不在选项内 → 拒绝',
    () => contractService.terminate(terminateTarget.id, {
      version: terminateTarget.version,
      terminatedAt: '2026-09-10',
      terminationType: '不存在的类型',
      terminationReason: '测试',
      unfinishedProjectAction: 'TERMINATE',
      unpaidAmountAction: 'KEEP_CLAIM',
    }, admin.id, 'ALL'),
    '不在可选范围内',
  );

  const terminated = await contractService.terminate(
    terminateTarget.id,
    {
      version: terminateTarget.version,
      terminatedAt: '2026-09-10',
      terminationType: 'CUSTOMER_REQUEST',
      terminationReason: '客户业务调整，不再继续申报',
      unfinishedProjectAction: 'TERMINATE',
      unpaidAmountAction: 'KEEP_CLAIM',
    },
    admin.id,
    'ALL',
  );
  check('① 终止日期已记录', terminated.terminatedAt !== null, terminated.terminatedAt?.toISOString().slice(0, 10) ?? '');
  check('② 终止类型已记录', terminated.terminationType === 'CUSTOMER_REQUEST', String(terminated.terminationType));
  check('③ 终止原因已记录', terminated.terminationReason === '客户业务调整，不再继续申报', String(terminated.terminationReason));
  check('④ 未完成项目处理方式已记录', terminated.unfinishedProjectAction === 'TERMINATE', String(terminated.unfinishedProjectAction));
  check('⑤ 未回款处理方式已记录', terminated.unpaidAmountAction === 'KEEP_CLAIM', String(terminated.unpaidAmountAction));
  check('合同状态变为已终止', terminated.statusCode === 'TERMINATED', terminated.statusCode);
  check('记录了终止操作人', terminated.terminatedById === admin.id);

  const afterTerminate = await prisma.project.findMany({ where: { contractId: terminateTarget.id }, orderBy: { sequence: 'asc' } });
  check('未完成项目被一并终止', afterTerminate.filter((item) => item.statusCode === 'TERMINATED').length === 2, afterTerminate.map((item) => item.statusCode).join(','));
  check('已完成项目保持完成（不抹掉历史）', afterTerminate.find((item) => item.id === projects[0].id)?.statusCode === 'COMPLETED');

  const projectHistory = await prisma.statusChangeHistory.findMany({ where: { resourceType: 'Project', toStatusCode: 'TERMINATED' } });
  check('项目被终止写入状态变化历史', projectHistory.length === 2, String(projectHistory.length));
  const contractHistory = await prisma.statusChangeHistory.findFirst({ where: { resourceType: 'Contract', resourceId: terminateTarget.id, toStatusCode: 'TERMINATED' } });
  check('合同终止写入状态变化历史', contractHistory !== null && contractHistory.reason === '客户业务调整，不再继续申报');

  await expectFailure('重复终止 → 拒绝', () => contractService.terminate(terminateTarget.id, {
    version: terminated.version,
    terminatedAt: '2026-09-11',
    terminationType: 'OTHER',
    terminationReason: '再来一次',
    unfinishedProjectAction: 'TERMINATE',
    unpaidAmountAction: 'KEEP_CLAIM',
  }, admin.id, 'ALL'), '已终止');

  const fresh = await prisma.contract.findUniqueOrThrow({ where: { id: terminateTarget.id }, select: { version: true } });
  await expectFailure('终止用过期版本号 → 409', () => contractService.terminate(terminateTarget.id, {
    version: fresh.version - 1,
    terminatedAt: '2026-09-11',
    terminationType: 'OTHER',
    terminationReason: '版本过期',
    unfinishedProjectAction: 'TERMINATE',
    unpaidAmountAction: 'KEEP_CLAIM',
  }, admin.id, 'ALL'), '已被他人更新');

  console.log('\n=== 6. 终止时保留项目继续执行 ===');
  const keepTarget = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 10000, itemCount: 2, signedAt: '2026-09-06' },
    admin.id,
  );
  await contractService.terminate(keepTarget.id, {
    version: keepTarget.version,
    terminatedAt: '2026-09-12',
    terminationType: 'TRANSFER_BUSINESS',
    terminationReason: '转入新合同',
    unfinishedProjectAction: 'KEEP_RUNNING',
    unpaidAmountAction: 'KEEP_CLAIM',
  }, admin.id, 'ALL');
  const keptProjects = await prisma.project.findMany({ where: { contractId: keepTarget.id } });
  check('选择「项目继续执行」时项目状态不变', keptProjects.every((item) => item.statusCode === 'PENDING'), keptProjects.map((item) => item.statusCode).join(','));

  console.log('\n=== 7. 金额调整（退款 / 折扣 / 部分豁免） ===');
  const adjustTarget = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 10000, itemCount: 1, signedAt: '2026-09-07' },
    admin.id,
  );
  const adjustProject = await prisma.project.findFirstOrThrow({ where: { contractId: adjustTarget.id } });

  check('未调整时未收款 = 10000', (await contractService.getById(adjustTarget.id, admin.id, 'ALL')).totals.unpaidAmount === '10000.00');

  const refund = await contractService.createAdjustment(
    adjustTarget.id,
    { adjustType: 'REFUND', amount: 2000, reason: '客户取消部分服务', occurredAt: '2026-09-08' },
    admin.id,
    'ALL',
  );
  check('退款调整已记账', refund.adjustType === 'REFUND' && Number(refund.amount) === 2000);

  const afterRefund = await contractService.getById(adjustTarget.id, admin.id, 'ALL');
  check('原合同金额未被改动', afterRefund.totals.contractAmount === '10000.00', afterRefund.totals.contractAmount);
  check('累计调整额 = 2000', afterRefund.totals.adjustedAmount === '2000.00', afterRefund.totals.adjustedAmount);
  check('应收净额 = 8000', afterRefund.totals.netReceivable === '8000.00', afterRefund.totals.netReceivable);
  check('未收款 = 10000 - 0 - 2000 = 8000', afterRefund.totals.unpaidAmount === '8000.00', afterRefund.totals.unpaidAmount);

  await contractService.createAdjustment(
    adjustTarget.id,
    { adjustType: 'DISCOUNT', amount: 500, reason: '老客户折扣', occurredAt: '2026-09-08' },
    admin.id,
    'ALL',
  );
  const afterDiscount = await contractService.getById(adjustTarget.id, admin.id, 'ALL');
  check('多笔调整累加 = 2500', afterDiscount.totals.adjustedAmount === '2500.00', afterDiscount.totals.adjustedAmount);
  check('未收款随之变为 7500', afterDiscount.totals.unpaidAmount === '7500.00', afterDiscount.totals.unpaidAmount);

  await expectFailure(
    '调整类型不在选项内 → 拒绝',
    () => contractService.createAdjustment(adjustTarget.id, { adjustType: '乱写', amount: 100, occurredAt: '2026-09-09' }, admin.id, 'ALL'),
    '不在可选范围内',
  );

  console.log('\n=== 8. 调整后应收不能小于已收款 ===');
  // 已收 7000，若再调整 2000 → 应收 10000 - 2500 - 2000 = 5500 < 7000，应被拒绝
  const receipt = await prisma.paymentReceipt.create({
    data: { receiptNo: 'HK2026888', contractId: adjustTarget.id, amount: 7000, receivedAt: new Date('2026-09-09') },
  });
  await prisma.projectPaymentAllocation.create({ data: { paymentId: receipt.id, projectId: adjustProject.id, amount: 7000 } });

  await expectFailure(
    '调整后应收 < 已收款 → 拒绝并说明原因',
    () => contractService.createAdjustment(adjustTarget.id, { adjustType: 'REFUND', amount: 2000, occurredAt: '2026-09-10' }, admin.id, 'ALL'),
    '小于已收款',
  );
  const afterReject = await contractService.getById(adjustTarget.id, admin.id, 'ALL');
  check('被拒绝时未产生调整记录', afterReject.totals.adjustedAmount === '2500.00', afterReject.totals.adjustedAmount);
  check('未收款 = 10000 - 7000 - 2500 = 500', afterReject.totals.unpaidAmount === '500.00', afterReject.totals.unpaidAmount);
  check('净收益仍按已收款 - 成本计算', afterReject.totals.netProfit === '7000.00', afterReject.totals.netProfit);

  console.log('\n=== 9. 撤销调整（软删除留痕） ===');
  const listed = await contractService.listAdjustments(adjustTarget.id, admin.id, 'ALL');
  check('明细返回 2 笔', listed.items.length === 2, String(listed.items.length));
  check('明细返回累计额', listed.total === '2500.00', listed.total);

  await contractService.removeAdjustment(adjustTarget.id, refund.id, admin.id, 'ALL');
  const afterRemove = await contractService.getById(adjustTarget.id, admin.id, 'ALL');
  check('撤销后累计调整额回到 500', afterRemove.totals.adjustedAmount === '500.00', afterRemove.totals.adjustedAmount);
  check('未收款回到 2500', afterRemove.totals.unpaidAmount === '2500.00', afterRemove.totals.unpaidAmount);
  const softDeleted = await prisma.contractAmountAdjustment.findUniqueOrThrow({ where: { id: refund.id } });
  check('撤销是软删除，记录仍在（审计可追）', softDeleted.deletedAt !== null);
  const removeAudit = await prisma.auditLog.findFirst({ where: { action: 'SOFT_DELETE', resourceType: 'ContractAmountAdjustment', resourceId: refund.id } });
  check('撤销写入审计日志', removeAudit !== null);

  console.log('\n=== 10. 审计留痕 ===');
  check('合同创建写入审计日志', (await prisma.auditLog.count({ where: { resourceType: 'Contract', resourceId: adjustTarget.id, action: 'CREATE' } })) >= 1);
  check('金额调整写入审计日志', (await prisma.auditLog.count({ where: { action: 'ADJUST_AMOUNT', resourceId: adjustTarget.id } })) === 2);
  check('合同终止写入审计日志', (await prisma.auditLog.count({ where: { action: 'TERMINATE', resourceId: terminateTarget.id } })) === 1);
  const terminateAudit = await prisma.auditLog.findFirst({ where: { action: 'TERMINATE', resourceId: terminateTarget.id } });
  check('终止审计记录了处理方式', terminateAudit?.afterData?.terminatedProjects === 2, JSON.stringify(terminateAudit?.afterData ?? {}));
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await resetBusinessData(prisma);
      console.log('\n[清理] 已清理业务数据，编号计数器已归零');
    } catch (error) {
      console.error('清理失败:', error.message);
      failures += 1;
    }
    if (app) await app.close();
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    if (failures > 0) process.exitCode = 1;
  });

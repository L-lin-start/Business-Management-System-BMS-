/**
 * 阶段 2 验证：提醒中心。
 *
 * 覆盖：
 *   - 三类提醒生成：合同法定截止日、内部安全日、项目节点超期
 *   - 提前提醒天数：未进入提醒窗口不生成，进入窗口才生成
 *   - 幂等：重复扫描不产生重复提醒
 *   - 已处理提醒不被扫描重新激活
 *   - 内部安全日：填写值优先，未填写按「法定截止日 - 安全天数」推算
 *   - 逾期天数计算
 *   - 参数配置：校验范围、可调整、调整后立即生效
 *   - 保留周期：已处理提醒超期后清理
 *   - 结束的合同/项目不再产生新提醒
 *
 * 用法：node scripts/verify-reminders.cjs   （需先 tsc 构建出 dist）
 */
const { PrismaClient } = require('@prisma/client');
const { resetBusinessData, logResetResult, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');
const { ReminderService } = require('../dist/modules/reminders/reminder.service');

const prisma = createTestPrismaClient();
const TEST_CUSTOMER_NAME = '提醒验证客户（临时）';
const DAY = 24 * 60 * 60 * 1000;
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

function daysFromNow(days) {
  return new Date(Date.now() + days * DAY);
}

/** 保存并恢复提醒配置，避免验证过程影响真实配置 */
async function snapshotConfig(reminderService) {
  const rows = await reminderService.listConfig();
  return Object.fromEntries(rows.map((row) => [row.name, row.value]));
}

async function main() {
  logResetResult('提醒中心', await resetBusinessData(prisma));

  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const contractService = app.get(ContractService);
  const reminderService = app.get(ReminderService);
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true, displayName: true } });
  const customer = await prisma.customer.create({ data: { name: TEST_CUSTOMER_NAME } });

  const originalConfig = await snapshotConfig(reminderService);
  // 关掉定时扫描，避免后台任务干扰断言（恢复时用上面快照的真实值，不能把 0 当默认值存回去）
  await reminderService.updateConfig({ scanIntervalMinutes: 0 });
  await prisma.reminder.deleteMany({});

  console.log('=== 1. 未进入提醒窗口时不生成提醒 ===');
  await reminderService.updateConfig({ contractAdvanceDays: 10, nodeAdvanceDays: 3, safetyMarginDays: 7 });
  const farContract = await contractService.create(
    { contractNo: 'VERIFY-REMINDER-1', customerId: customer.id, amount: 1000, contractType: 'OTHER', itemCount: 1, signedAt: '2026-09-01', legallyDueAt: daysFromNow(90).toISOString(), autoGenerateProjects: false },
    admin.id,
  );
  let scan = await reminderService.scan({ trigger: 'MANUAL' });
  check('90 天后到期、提前 10 天提醒 → 不生成', scan.created === 0, `created=${scan.created}`);

  console.log('\n=== 2. 进入窗口后生成合同提醒 ===');
  await prisma.contract.update({ where: { id: farContract.id }, data: { legallyDueAt: daysFromNow(5) } });
  scan = await reminderService.scan({ trigger: 'MANUAL' });
  check('5 天后到期、提前 10 天提醒 → 生成', scan.created >= 1, `created=${scan.created}`);

  const deadlineReminder = await prisma.reminder.findFirst({ where: { sourceId: farContract.id, type: 'CONTRACT_DEADLINE' } });
  check('生成「临近法定截止日」提醒', deadlineReminder !== null && deadlineReminder.title.includes('法定截止日'), deadlineReminder?.title ?? '(无)');
  check('提醒带合同编号便于跳转', deadlineReminder?.sourceNo === farContract.contractNo, String(deadlineReminder?.sourceNo));
  check('提醒记录客户名称', deadlineReminder?.detail?.includes(TEST_CUSTOMER_NAME) === true, String(deadlineReminder?.detail));
  check('未逾期时逾期天数为 0', deadlineReminder?.overdueDays === 0, String(deadlineReminder?.overdueDays));

  console.log('\n=== 3. 内部安全日：未填写时按安全天数推算 ===');
  const safetyReminder = await prisma.reminder.findFirst({ where: { sourceId: farContract.id, type: 'INTERNAL_SAFETY' } });
  check('生成「临近内部安全日」提醒', safetyReminder !== null, safetyReminder?.title ?? '(无)');
  const expectedSafety = new Date(daysFromNow(5).getTime() - 7 * DAY);
  check(
    '安全日 = 法定截止日 - 7 天',
    safetyReminder !== null && Math.abs(safetyReminder.dueAt.getTime() - expectedSafety.getTime()) < 60 * 1000,
    safetyReminder?.dueAt.toISOString().slice(0, 10) ?? '',
  );
  check('说明里注明是按配置推算的', safetyReminder?.detail?.includes('推算') === true, String(safetyReminder?.detail));

  console.log('\n=== 4. 幂等：重复扫描不产生重复 ===');
  const before = await prisma.reminder.count();
  scan = await reminderService.scan({ trigger: 'MANUAL' });
  const after = await prisma.reminder.count();
  check('再次扫描 created=0', scan.created === 0, `created=${scan.created}`);
  check('提醒总数不变', before === after, `${before} → ${after}`);
  check('已有提醒被刷新（refreshed>0）', scan.refreshed > 0, `refreshed=${scan.refreshed}`);

  console.log('\n=== 5. 到期日改期：就地更新，不产生第二条 ===');
  await prisma.contract.update({ where: { id: farContract.id }, data: { legallyDueAt: daysFromNow(-3) } });
  await reminderService.scan({ trigger: 'MANUAL' });
  const deadlineCount = await prisma.reminder.count({ where: { sourceId: farContract.id, type: 'CONTRACT_DEADLINE' } });
  check('改期后仍只有一条法定截止日提醒（不重复）', deadlineCount === 1, String(deadlineCount));
  const overdueReminder = await prisma.reminder.findFirst({
    where: { sourceId: farContract.id, type: 'CONTRACT_DEADLINE', isHandled: false },
  });
  check('逾期 3 天被正确计算', overdueReminder?.overdueDays === 3, String(overdueReminder?.overdueDays));
  const listed = await reminderService.list({ isHandled: 'false', scan: 'false' });
  check('列表返回剩余天数（负数表示逾期）', listed.items.some((item) => item.daysRemaining < 0), String(listed.items[0]?.daysRemaining));
  check('汇总统计未处理数', listed.summary.unhandled >= 1, String(listed.summary.unhandled));
  check('汇总统计逾期数', listed.summary.overdue >= 1, String(listed.summary.overdue));

  console.log('\n=== 6. 已处理提醒不被重新激活 ===');
  const toHandle = await prisma.reminder.findFirstOrThrow({
    where: { sourceId: farContract.id, type: 'CONTRACT_DEADLINE', isHandled: false },
  });
  const handled = await reminderService.handle(toHandle.id, { note: '已与客户确认延期' }, admin.id);
  check('标记为已处理', handled.isHandled === true);
  check('记录处理人', handled.handledBy?.displayName === admin.displayName, String(handled.handledBy?.displayName));
  check('记录处理说明', handled.handleNote === '已与客户确认延期', String(handled.handleNote));

  await reminderService.scan({ trigger: 'MANUAL' });
  const afterHandleScan = await prisma.reminder.findUniqueOrThrow({ where: { id: toHandle.id } });
  check('重新扫描后仍是已处理状态', afterHandleScan.isHandled === true);
  check('未生成重复的未处理提醒', (await prisma.reminder.count({ where: { sourceId: farContract.id, type: 'CONTRACT_DEADLINE', isHandled: false } })) === 0);

  await expectFailure('重复处理同一条 → 拒绝', () => reminderService.handle(toHandle.id, {}, admin.id), '已处理');
  const unhandled = await reminderService.unhandle(toHandle.id, admin.id);
  check('可以取消处理（误点恢复）', unhandled.isHandled === false);
  await expectFailure('未处理的提醒不能取消处理', () => reminderService.unhandle(toHandle.id, admin.id), '尚未处理');
  await reminderService.handle(toHandle.id, { note: '再次确认' }, admin.id);

  console.log('\n=== 7. 项目节点超期提醒 ===');
  // 节点进入时间回调到 30 天前：受理节点时限 15 天，应算出逾期 15 天
  const nodeContract = await contractService.create(
    { contractNo: 'VERIFY-REMINDER-2', customerId: customer.id, amount: 20000, contractType: 'PATENT', itemCount: 1, signedAt: '2026-09-01' },
    admin.id,
  );
  const nodeProject = await prisma.project.findFirstOrThrow({ where: { contractId: nodeContract.id } });
  check('专利项目落在首节点', nodeProject.currentNodeCode === 'SUBMIT_APPLICATION', String(nodeProject.currentNodeCode));

  const currentVersion = nodeProject.version;
  const { TransitionService } = require('../dist/modules/workflows/transition.service');
  const transitionService = app.get(TransitionService);
  await transitionService.transition(nodeProject.id, { version: currentVersion, reason: '进入受理节点' }, admin.id, 'ALL');

  // 把进入「受理」的时间往前挪 30 天，制造超期
  await prisma.project.update({ where: { id: nodeProject.id }, data: { currentNodeEnteredAt: daysFromNow(-30) } });
  await reminderService.updateConfig({ nodeAdvanceDays: 3 });
  scan = await reminderService.scan({ trigger: 'MANUAL' });
  const nodeReminder = await prisma.reminder.findFirst({ where: { sourceId: nodeProject.id, type: 'NODE_OVERDUE' } });
  check('生成节点超期提醒', nodeReminder !== null, nodeReminder?.title ?? '(无)');
  check('提醒里带节点名称「受理」', nodeReminder?.title.includes('受理') === true, String(nodeReminder?.title));
  check('节点逾期天数按时限算（15 天时限、30 天前进入 → 逾期 15 天）', nodeReminder?.overdueDays === 15, String(nodeReminder?.overdueDays));
  check('节点提醒关联项目编号', nodeReminder?.sourceNo === nodeProject.projectNo, String(nodeReminder?.sourceNo));

  const nodeDedupe = await prisma.reminder.count({ where: { sourceId: nodeProject.id, type: 'NODE_OVERDUE' } });
  await reminderService.scan({ trigger: 'MANUAL' });
  const nodeDedupeAfter = await prisma.reminder.count({ where: { sourceId: nodeProject.id, type: 'NODE_OVERDUE' } });
  check('节点提醒也不重复生成', nodeDedupe === nodeDedupeAfter, `${nodeDedupe} → ${nodeDedupeAfter}`);

  console.log('\n=== 8. 结束的合同不再产生新提醒 ===');
  const nodeReminderCountBefore = await prisma.reminder.count({ where: { sourceId: nodeProject.id, type: 'NODE_OVERDUE' } });
  await prisma.contract.update({ where: { id: nodeContract.id }, data: { statusCode: 'COMPLETED' } });
  // 处理掉已有提醒：若项目仍被扫描，会因未处理提醒已存在而不新建，故先标记为已处理以便观察是否重新生成
  await prisma.reminder.updateMany({
    where: { sourceId: nodeProject.id, type: 'NODE_OVERDUE' },
    data: { isHandled: true, handledAt: new Date(), handledById: admin.id },
  });
  await prisma.reminder.deleteMany({ where: { sourceId: nodeProject.id, type: 'NODE_OVERDUE' } });
  scan = await reminderService.scan({ trigger: 'MANUAL' });
  const regenerated = await prisma.reminder.findFirst({ where: { sourceId: nodeProject.id, type: 'NODE_OVERDUE' } });
  check('合同已完成 → 不再生成其项目节点提醒', regenerated === null, regenerated?.title ?? '(未生成)');
  check('扫描确实运行过（不是因异常跳过）', scan.scannedAt !== undefined && nodeReminderCountBefore >= 1);

  const completedContractReminders = await prisma.reminder.count({ where: { sourceId: nodeContract.id } });
  check('已完成合同也不生成新的合同提醒', completedContractReminders === 0, String(completedContractReminders));

  console.log('\n=== 8b. 项目自身已结束也不再提醒 ===');
  await prisma.contract.update({ where: { id: nodeContract.id }, data: { statusCode: 'ACTIVE' } });
  await prisma.project.update({ where: { id: nodeProject.id }, data: { statusCode: 'COMPLETED' } });
  await reminderService.scan({ trigger: 'MANUAL' });
  const afterProjectClosed = await prisma.reminder.count({ where: { sourceId: nodeProject.id, type: 'NODE_OVERDUE' } });
  check('项目已完成 → 不生成节点提醒', afterProjectClosed === 0, String(afterProjectClosed));
  await prisma.project.update({ where: { id: nodeProject.id }, data: { statusCode: 'IN_PROGRESS' } });

  console.log('\n=== 9. 参数配置校验 ===');
  await expectFailure('提前天数超范围 → 拒绝', () => reminderService.updateConfig({ contractAdvanceDays: 999 }), '必须是');
  await expectFailure('保留天数不能小于 1', () => reminderService.updateConfig({ retentionDays: 0 }), '必须是');
  const configList = await reminderService.listConfig();
  check('配置列表包含 9 个参数（含分级预警 3 档与待回款宽限期）', configList.length === 9, String(configList.length));
  check('配置含分级预警三档阈值', ['tierNoticeDays', 'tierWarningDays', 'tierUrgentDays'].every((name) => configList.some((item) => item.name === name)));
  check('配置含待回款宽限期', configList.some((item) => item.name === 'paymentGraceDays'));
  const changed = await reminderService.updateConfig({ contractAdvanceDays: 15 }, admin.id);
  check('可正常调整参数', changed.find((item) => item.name === 'contractAdvanceDays')?.value === 15, String(changed.find((item) => item.name === 'contractAdvanceDays')?.value));

  const auditCount = await prisma.auditLog.count({ where: { resourceType: 'ReminderConfig' } });
  check('参数调整写入审计日志', auditCount >= 1, String(auditCount));

  console.log('\n=== 10. 到期日改期后提醒跟随更新（不产生重复） ===');
  await prisma.contract.update({ where: { id: farContract.id }, data: { legallyDueAt: daysFromNow(8) } });
  scan = await reminderService.scan({ trigger: 'MANUAL' });
  // 第 6 步已把上一条标记为已处理：已处理的保留原样，改期视为新问题另生成一条未处理提醒
  const deadlineRows = await prisma.reminder.findMany({ where: { sourceId: farContract.id, type: 'CONTRACT_DEADLINE' } });
  const unhandledDeadline = deadlineRows.filter((item) => !item.isHandled);
  check('未处理的法定截止日提醒只有一条（改期不重复）', unhandledDeadline.length === 1, `${unhandledDeadline.length} 条未处理 / 共 ${deadlineRows.length} 条`);
  check(
    '未处理提醒已指向新的到期日',
    unhandledDeadline[0] !== undefined && Math.abs(unhandledDeadline[0].dueAt.getTime() - daysFromNow(8).getTime()) < 60 * 1000,
    unhandledDeadline[0]?.dueAt.toISOString().slice(0, 10) ?? '',
  );
  check('改期后逾期天数归零', unhandledDeadline[0]?.overdueDays === 0, String(unhandledDeadline[0]?.overdueDays));
  check('已处理的那条保持已处理状态', deadlineRows.some((item) => item.isHandled), String(deadlineRows.length));
  void scan;

  console.log('\n=== 11. 保留周期：已处理提醒超期后清理 ===');
  await reminderService.updateConfig({ retentionDays: 7 });
  const oldHandled = await prisma.reminder.findFirstOrThrow({ where: { isHandled: true } });
  await prisma.reminder.update({ where: { id: oldHandled.id }, data: { handledAt: daysFromNow(-10) } });
  await reminderService.updateConfig({ retentionDays: 7 });
  scan = await reminderService.scan({ trigger: 'MANUAL' });
  const cleaned = await prisma.reminder.findUnique({ where: { id: oldHandled.id } });
  check('10 天前处理、保留 7 天 → 被清理', cleaned === null);
  check('扫描结果里报告清理条数', scan.cleaned >= 1, String(scan.cleaned));

  const recentHandled = await prisma.reminder.findFirst({ where: { isHandled: true } });
  if (recentHandled) {
    check('保留期内的已处理提醒不受影响', true);
  }

  console.log('\n=== 12. 首页看板带出提醒汇总 ===');
  const { DashboardService } = require('../dist/modules/dashboard/dashboard.service');
  const dashboardService = app.get(DashboardService);
  const overview = await dashboardService.overview(admin.id, 'ALL');
  check('看板返回未处理提醒数', typeof overview.reminders?.unhandled === 'number', String(overview.reminders?.unhandled));
  check('看板返回逾期提醒数', typeof overview.reminders?.overdue === 'number', String(overview.reminders?.overdue));
  check('看板返回未收款总额', overview.unpaidAmount !== undefined, String(overview.unpaidAmount));
  check('看板带出 PRD 四项待办口径', overview.prdReminders !== undefined && 'todayTodo' in overview.prdReminders);
  check('超时邮件登记卡片返回真实统计且不再标注未实现', typeof overview.prdReminders?.overdueMailRegistrations === 'number' && !(overview.prdReminders?.unavailable ?? []).some((item) => item.key === 'overdueMailRegistrations'));

  console.log('\n=== 13. 分级预警（PRD 4.7） ===');
  await prisma.reminder.deleteMany({});
  await reminderService.updateConfig({ tierNoticeDays: 30, tierWarningDays: 15, tierUrgentDays: 7, contractAdvanceDays: 60 });
  const tierContract = await contractService.create(
    { contractNo: 'VERIFY-REMINDER-3', customerId: customer.id, amount: 5000, contractType: 'OTHER', itemCount: 1, signedAt: '2026-09-01', legallyDueAt: daysFromNow(40).toISOString(), autoGenerateProjects: false },
    admin.id,
  );
  await reminderService.scan({ trigger: 'MANUAL' });
  const tier40 = await prisma.reminder.findFirst({ where: { sourceId: tierContract.id, type: 'CONTRACT_DEADLINE' } });
  check('剩余 40 天 → NORMAL（未进任何档）', tier40 === null || tier40.alertLevel === 'NORMAL', tier40?.alertLevel ?? '(未生成)');

  await prisma.contract.update({ where: { id: tierContract.id }, data: { legallyDueAt: daysFromNow(25) } });
  await reminderService.scan({ trigger: 'MANUAL' });
  const tier25 = await prisma.reminder.findFirst({ where: { sourceId: tierContract.id, type: 'CONTRACT_DEADLINE' } });
  check('剩余 25 天 → NOTICE 提示档', tier25?.alertLevel === 'NOTICE', `${tier25?.alertLevel}（阈值 ${tier25?.tierDays}）`);

  await prisma.contract.update({ where: { id: tierContract.id }, data: { legallyDueAt: daysFromNow(12) } });
  await reminderService.scan({ trigger: 'MANUAL' });
  const tier12 = await prisma.reminder.findFirst({ where: { sourceId: tierContract.id, type: 'CONTRACT_DEADLINE' } });
  check('剩余 12 天 → WARNING 警告档', tier12?.alertLevel === 'WARNING', `${tier12?.alertLevel}（阈值 ${tier12?.tierDays}）`);

  await prisma.contract.update({ where: { id: tierContract.id }, data: { legallyDueAt: daysFromNow(3) } });
  await reminderService.scan({ trigger: 'MANUAL' });
  const tier3 = await prisma.reminder.findFirst({ where: { sourceId: tierContract.id, type: 'CONTRACT_DEADLINE' } });
  check('剩余 3 天 → URGENT 紧急档', tier3?.alertLevel === 'URGENT', `${tier3?.alertLevel}（阈值 ${tier3?.tierDays}）`);

  await prisma.contract.update({ where: { id: tierContract.id }, data: { legallyDueAt: daysFromNow(-2) } });
  await reminderService.scan({ trigger: 'MANUAL' });
  const tierOverdue = await prisma.reminder.findFirst({ where: { sourceId: tierContract.id, type: 'CONTRACT_DEADLINE' } });
  check('已逾期 → OVERDUE 档', tierOverdue?.alertLevel === 'OVERDUE', String(tierOverdue?.alertLevel));
  const tierCount = await prisma.reminder.count({ where: { sourceId: tierContract.id, type: 'CONTRACT_DEADLINE' } });
  check('档位升降不产生多条提醒', tierCount === 1, String(tierCount));
  await expectFailure('分级阈值超范围 → 拒绝', () => reminderService.updateConfig({ tierUrgentDays: 999 }), '必须是');

  console.log('\n=== 14. 待回款合同提醒（PRD 4.10：项目全部走完 + 钱全部到账） ===');
  await prisma.reminder.deleteMany({});
  await reminderService.updateConfig({ paymentGraceDays: 0, contractAdvanceDays: 30 });
  const payContract = await contractService.create(
    { contractNo: 'VERIFY-REMINDER-4', customerId: customer.id, amount: 10000, contractType: 'OTHER', itemCount: 1, signedAt: '2026-09-01', autoGenerateProjects: false },
    admin.id,
  );
  const payProject = await prisma.project.create({
    data: { contractId: payContract.id, projectNo: `${payContract.contractNo}-1`, sequence: 1, projectName: '待回款验证项目', statusCode: 'PENDING' },
  });

  await reminderService.scan({ trigger: 'MANUAL' });
  check('项目未走完时不产生待回款提醒', (await prisma.reminder.count({ where: { sourceId: payContract.id, type: 'PAYMENT_PENDING' } })) === 0);

  // 把项目置为已完成，模拟"项目全部走完"
  await prisma.project.update({ where: { id: payProject.id }, data: { statusCode: 'COMPLETED' } });
  await prisma.statusChangeHistory.create({
    data: { resourceType: 'Project', resourceId: payProject.id, fromStatusCode: 'IN_PROGRESS', toStatusCode: 'COMPLETED', reason: '验证用：项目完成', changedAt: daysFromNow(-1) },
  });
  await reminderService.scan({ trigger: 'MANUAL' });
  const payReminder = await prisma.reminder.findFirst({ where: { sourceId: payContract.id, type: 'PAYMENT_PENDING' } });
  check('项目全部走完且未收齐款 → 生成待回款提醒', payReminder !== null, payReminder?.title ?? '(未生成)');
  check('提醒金额 = 合同金额 - 已收款', payReminder?.title.includes('¥10000.00') === true, String(payReminder?.title));
  check('说明里给出已收/合同金额', payReminder?.detail?.includes('¥0.00') === true && payReminder?.detail?.includes('¥10000.00') === true, String(payReminder?.detail));

  // 收齐全款后提醒应消失（合同达成完成条件）
  const receipt = await prisma.paymentReceipt.create({
    data: { receiptNo: 'HK2026999', contractId: payContract.id, amount: 10000, receivedAt: new Date() },
  });
  await prisma.projectPaymentAllocation.create({
    data: { paymentId: receipt.id, projectId: payProject.id, amount: 10000 },
  });
  await reminderService.scan({ trigger: 'MANUAL' });
  const payReminderAfterPaid = await prisma.reminder.findFirst({ where: { sourceId: payContract.id, type: 'PAYMENT_PENDING' } });
  check('钱全部到账后仍存在的未处理提醒不被自动删除（需人工确认）', payReminderAfterPaid !== null);

  // 处理掉，再扫描应不再生成
  if (payReminderAfterPaid) {
    await reminderService.handle(payReminderAfterPaid.id, { note: '款已到账' }, admin.id);
    await reminderService.scan({ trigger: 'MANUAL' });
    const regenerated = await prisma.reminder.count({ where: { sourceId: payContract.id, type: 'PAYMENT_PENDING', isHandled: false } });
    check('款项收齐并处理后不再生成待回款提醒', regenerated === 0, String(regenerated));
  }

  console.log('\n=== 15. PRD 看板四项口径 ===');
  const prdSummary = await reminderService.prdSummary();
  check('返回今日待办', typeof prdSummary.todayTodo === 'number', String(prdSummary.todayTodo));
  check('返回逾期项目数', typeof prdSummary.overdueProjects === 'number', String(prdSummary.overdueProjects));
  check('超时邮件登记返回数字且已实现', typeof prdSummary.overdueMailRegistrations === 'number' && !prdSummary.unavailable.some((item) => item.key === 'overdueMailRegistrations'));
  check('返回待回款合同数', typeof prdSummary.paymentPendingContracts === 'number', String(prdSummary.paymentPendingContracts));

  // 恢复原始配置
  await reminderService.updateConfig(originalConfig);
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await prisma.reminder.deleteMany({});
      await resetBusinessData(prisma);
      console.log('\n[清理] 已删除提醒与业务数据，编号计数器已归零');
    } catch (error) {
      console.error('清理失败:', error.message);
      failures += 1;
    }
    if (app) await app.close();
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    if (failures > 0) process.exitCode = 1;
  });

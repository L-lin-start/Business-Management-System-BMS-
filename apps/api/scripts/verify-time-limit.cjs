/**
 * 阶段 3.2 验证：系统算建议截止日（PRD 4.7「系统算建议截止日，人工复核确认」）。
 *
 * 覆盖：
 *   - 建议法定截止日 = 签约日 + 该业务类型时限天数
 *   - 业务类型未配置时限时退回全局默认值
 *   - 不得晚于合同到期日（超了压缩到到期日，并标注被压缩）
 *   - 建议内部安全日 = 建议法定截止日 - 安全天数（复用提醒中心配置，人工可改 15/7 等）
 *   - 未填签约日时用今天作起算日
 *   - 未选合同类型时拒绝
 *   - 时限天数与安全天数可在系统 B 调整并立即生效
 *   - 只算不写库（调用建议接口不产生合同数据）
 *   - 人工填写的日期优先于建议值
 *
 * 用法：node scripts/verify-time-limit.cjs   （需先 tsc 构建出 dist）
 */
const { PrismaClient } = require('@prisma/client');
const { resetBusinessData, logResetResult, createContractNoFactory, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');
const { TimeLimitService } = require('../dist/modules/contracts/time-limit.service');
const { ReminderService } = require('../dist/modules/reminders/reminder.service');

const prisma = createTestPrismaClient();
const TEST_CUSTOMER_NAME = '时限建议验证客户（临时）';
const DAY = 24 * 60 * 60 * 1000;
let failures = 0;
let app;
const nextContractNo = createContractNoFactory('VERIFY-LIMIT');

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

function dateText(value) {
  return value.slice(0, 10);
}

/** 按本地时区把 Date 格式化为 YYYY-MM-DD（不能用 toISOString，UTC 下会差一天） */
function localDateText(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 本地当天零点，避免用 UTC 解析导致差一天 */
function localDateFromText(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function daysBetween(fromText, toText) {
  return Math.round((localDateFromText(toText).getTime() - localDateFromText(fromText).getTime()) / DAY);
}

async function main() {
  logResetResult('时限建议', await resetBusinessData(prisma));

  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const contractService = app.get(ContractService);
  const timeLimitService = app.get(TimeLimitService);
  const reminderService = app.get(ReminderService);
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true } });
  const customer = await prisma.customer.create({ data: { name: TEST_CUSTOMER_NAME } });

  const originalSafetyMargin = await reminderService.readConfig('safetyMarginDays');
  const originalDefaultTimeLimit = await timeLimitService.readDefaultTimeLimitDays();

  console.log('=== 1. 业务起算日 = 合同录入、项目绑定生成的时刻 ===');
  // 新建合同时不传 contractId，起算日应为"此刻"（即马上要录入的时刻）
  const suggestion = await timeLimitService.suggest({ contractType: 'PATENT' });
  const today = localDateText(new Date());
  check('起算日为今天（业务起算日＝录入时刻）', suggestion.baseDate === today, suggestion.baseDate);
  check('起算日来源标注为业务起算日', suggestion.baseDateSource === 'BUSINESS_START', suggestion.baseDateSource);
  check('返回建议法定截止日', Boolean(suggestion.suggestedLegallyDueAt), suggestion.suggestedLegallyDueAt);
  check('时限来源标注为业务类型配置', suggestion.timeLimitSource === 'CONTRACT_TYPE', suggestion.timeLimitSource);
  check(
    `法定截止日 = 业务起算日 + 专利时限 ${suggestion.timeLimitDays} 天`,
    daysBetween(today, suggestion.suggestedLegallyDueAt) === suggestion.timeLimitDays,
    `${today} → ${suggestion.suggestedLegallyDueAt}（${daysBetween(today, suggestion.suggestedLegallyDueAt)} 天）`,
  );
  check(
    `内部安全日 = 法定截止日 - 安全天数 ${suggestion.safetyMarginDays} 天`,
    daysBetween(suggestion.suggestedInternalSafetyDate, suggestion.suggestedLegallyDueAt) === suggestion.safetyMarginDays,
    `${suggestion.suggestedInternalSafetyDate} → ${suggestion.suggestedLegallyDueAt}`,
  );
  check(
    '给出可读的计算依据（含业务起算日）',
    suggestion.explanation.includes('业务起算日') && suggestion.explanation.includes('人工复核'),
    suggestion.explanation,
  );

  console.log('\n=== 1b. 编辑已有合同时用该合同的录入时间作起算日 ===');
  // 造一份"录入时间在过去"的合同：直接改 createdAt，模拟早就录入的合同
  const backdatedContract = await contractService.create(
    { contractNo: 'VERIFY-TIME-1', customerId: customer.id, contractType: 'PATENT', amount: 10000, itemCount: 1, signedAt: '2026-01-15' },
    admin.id,
  );
  const backdatedStart = localDateFromText('2026-03-01');
  await prisma.contract.update({ where: { id: backdatedContract.id }, data: { createdAt: backdatedStart } });

  const forExisting = await timeLimitService.suggest({ contractType: 'PATENT', contractId: backdatedContract.id });
  check('编辑时起算日取该合同的录入时间', forExisting.baseDate === '2026-03-01', `${forExisting.baseDate}（应为其录入时间）`);
  check(
    '截止日 = 该合同录入时间 + 时限天数',
    daysBetween('2026-03-01', forExisting.suggestedLegallyDueAt) === forExisting.timeLimitDays,
    `${forExisting.baseDate} → ${forExisting.suggestedLegallyDueAt}`,
  );
  check(
    '不受签约日影响（签约日 2026-01-15 但起算日仍是录入日）',
    forExisting.baseDate !== '2026-01-15',
    `起算日 ${forExisting.baseDate}，签约日 2026-01-15`,
  );

  console.log('\n=== 2. 不同业务类型用各自的时限 ===');
  const trademark = await timeLimitService.suggest({ contractType: 'TRADEMARK' });
  const copyright = await timeLimitService.suggest({ contractType: 'COPYRIGHT' });
  check('商标与专利时限不同', trademark.timeLimitDays !== suggestion.timeLimitDays, `商标 ${trademark.timeLimitDays} 天 / 专利 ${suggestion.timeLimitDays} 天`);
  check('软著时限已配置', copyright.timeLimitDays > 0, `${copyright.timeLimitDays} 天`);

  console.log('\n=== 3. 按中文标签也能推算 ===');
  const byLabel = await timeLimitService.suggest({ contractType: '软著' });
  check('传「软著」标签与传编码结果一致', byLabel.suggestedLegallyDueAt === copyright.suggestedLegallyDueAt, byLabel.suggestedLegallyDueAt);

  console.log('\n=== 4. 不得晚于合同到期日 ===');
  const farExpiry = localDateText(new Date(Date.now() + 365 * DAY));
  const notCapped = await timeLimitService.suggest({ contractType: 'PATENT', expiryDate: farExpiry });
  check('到期日很远时不压缩', notCapped.cappedByExpiryDate === false, notCapped.suggestedLegallyDueAt);

  const nearExpiry = localDateText(new Date(Date.now() + 3 * DAY));
  const capped = await timeLimitService.suggest({ contractType: 'PATENT', expiryDate: nearExpiry });
  check('建议值超过到期日时压缩到到期日', capped.suggestedLegallyDueAt === nearExpiry, `${capped.suggestedLegallyDueAt}（到期日 ${nearExpiry}）`);
  check('标注了被到期日压缩', capped.cappedByExpiryDate === true);
  check('说明里写明被压缩的原因', capped.explanation.includes('超过合同到期日'), capped.explanation);
  check('安全日随压缩后的截止日一起前移', capped.suggestedInternalSafetyDate < nearExpiry, `${capped.suggestedInternalSafetyDate} < ${nearExpiry}`);

  console.log('\n=== 5. 业务类型未配置时限时退回全局默认 ===');
  const otherType = await timeLimitService.suggest({ contractType: 'OTHER' });
  const globalDefault = await timeLimitService.readDefaultTimeLimitDays();
  check('未配置时限的类型使用全局默认', otherType.timeLimitDays === globalDefault, `${otherType.timeLimitDays} 天`);
  check('标注时限来源为全局默认', otherType.timeLimitSource === 'GLOBAL_DEFAULT', otherType.timeLimitSource);

  console.log('\n=== 6. 未选合同类型时拒绝 ===');
  await expectFailure('不传合同类型 → 拒绝', () => timeLimitService.suggest({}), '请先选择合同类型');
  await expectFailure('传未配置的类型 → 拒绝', () => timeLimitService.suggest({ contractType: '不存在的类型' }), '不在可选范围内');

  console.log('\n=== 7. 时限与安全天数可调整并立即生效 ===');
  await reminderService.updateConfig({ safetyMarginDays: 15 });
  const with15 = await timeLimitService.suggest({ contractType: 'PATENT' });
  check('安全天数改成 15 后立即生效', with15.safetyMarginDays === 15 && daysBetween(with15.suggestedInternalSafetyDate, with15.suggestedLegallyDueAt) === 15, `${with15.suggestedInternalSafetyDate} → ${with15.suggestedLegallyDueAt}`);

  await reminderService.updateConfig({ safetyMarginDays: 7 });
  const with7 = await timeLimitService.suggest({ contractType: 'PATENT' });
  check('安全天数改成 7 后立即生效', with7.safetyMarginDays === 7 && daysBetween(with7.suggestedInternalSafetyDate, with7.suggestedLegallyDueAt) === 7, `${with7.suggestedInternalSafetyDate} → ${with7.suggestedLegallyDueAt}`);
  check('两档算出的法定截止日相同（只影响安全日）', with15.suggestedLegallyDueAt === with7.suggestedLegallyDueAt);

  const patentOption = await prisma.statusDefinition.findFirstOrThrow({ where: { moduleKey: 'contractType', code: 'PATENT' } });
  await timeLimitService.updateTypeTimeLimit('contractType', patentOption.id, { timeLimitDays: 60, timeLimitNote: '验证用临时调整' });
  const afterChange = await timeLimitService.suggest({ contractType: 'PATENT' });
  check('时限改成 60 天后建议值随之变化', afterChange.timeLimitDays === 60 && daysBetween(today, afterChange.suggestedLegallyDueAt) === 60, afterChange.suggestedLegallyDueAt);

  await timeLimitService.updateTypeTimeLimit('contractType', patentOption.id, { timeLimitDays: null });
  const afterClear = await timeLimitService.suggest({ contractType: 'PATENT' });
  check('清空时限后退回全局默认', afterClear.timeLimitSource === 'GLOBAL_DEFAULT' && afterClear.timeLimitDays === globalDefault, `${afterClear.timeLimitDays} 天`);

  await expectFailure('时限天数超范围 → 拒绝', () => timeLimitService.updateTypeTimeLimit('contractType', patentOption.id, { timeLimitDays: 99999 }), '3650');
  await expectFailure('默认时限超范围 → 拒绝', () => timeLimitService.updateDefaultTimeLimitDays(0), '1-3650');

  console.log('\n=== 8. 只算不写库 ===');
  const contractCountBefore = await prisma.contract.count();
  await timeLimitService.suggest({ contractType: 'PATENT' });
  const contractCountAfter = await prisma.contract.count();
  check('调用建议接口不产生合同数据', contractCountBefore === contractCountAfter, `${contractCountBefore} → ${contractCountAfter}`);

  console.log('\n=== 9. 人工填写的日期优先于建议值 ===');
  // 恢复专利时限，避免前面的临时调整影响后续断言
  await timeLimitService.updateTypeTimeLimit('contractType', patentOption.id, { timeLimitDays: 30, timeLimitNote: '发明专利常规周期，按实际局方时限调整' });
  const manualDue = '2026-12-31';
  const manualSafety = '2026-12-20';
  const created = await contractService.create(
    { contractNo: 'VERIFY-TIME-2', customerId: customer.id, contractType: 'PATENT', amount: 10000, itemCount: 1, signedAt: '2026-09-01', legallyDueAt: manualDue, internalSafetyDate: manualSafety },
    admin.id,
  );
  const detail = await contractService.getById(created.id, admin.id, 'ALL');
  check('保存的是人工填写的法定截止日，而非建议值', localDateText(detail.legallyDueAt) === manualDue, localDateText(detail.legallyDueAt));
  check('保存的是人工填写的内部安全日，而非建议值', localDateText(detail.internalSafetyDate) === manualSafety, localDateText(detail.internalSafetyDate));
  check('合同详情带出业务起算日（录入时间）', Boolean(detail.createdAt), localDateText(detail.createdAt));
  check('业务起算日与签约日相互独立', localDateText(detail.createdAt) !== '2026-09-01', `起算日 ${localDateText(detail.createdAt)} / 签约日 2026-09-01`);

  console.log('\n=== 10. 时限配置接口 ===');
  const limits = await timeLimitService.listTypeTimeLimits();
  check('返回全局默认时限', limits.defaultTimeLimitDays === globalDefault, String(limits.defaultTimeLimitDays));
  check('返回各合同类型的时限', limits.types.length >= 5, String(limits.types.length));
  check('每项含时限与说明字段', limits.types.every((item) => 'timeLimitDays' in item && 'timeLimitNote' in item));

  // 恢复原配置
  await reminderService.updateConfig({ safetyMarginDays: originalSafetyMargin });
  await timeLimitService.updateDefaultTimeLimitDays(originalDefaultTimeLimit);
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



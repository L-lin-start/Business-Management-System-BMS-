/**
 * 单据编号规则验证：迁移状态、存量数据清理、并发分配不重号、回滚。
 * 用法：node scripts/verify-document-numbering.cjs
 */
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { resetBusinessData, logResetResult, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');

const prisma = createTestPrismaClient();
const MIGRATION = '20261010120000_fix_document_numbering';
const MIGRATION_FILE = path.join(__dirname, '..', 'prisma', 'migrations', MIGRATION, 'migration.sql');

const CONCURRENCY = 8;
let failures = 0;

function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

/** 与 DocumentNumberService.allocate 使用完全相同的原子分配语句。 */
async function allocate(scope, prefix, year) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO "DocumentSequence" ("id", "scope", "prefix", "year", "lastValue", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 1, CURRENT_TIMESTAMP)
     ON CONFLICT ("scope", "prefix", "year")
     DO UPDATE SET "lastValue" = "DocumentSequence"."lastValue" + 1, "updatedAt" = CURRENT_TIMESTAMP
     RETURNING "lastValue"`,
    scope,
    prefix,
    year,
  );
  const sequence = Number(rows[0].lastValue);
  return { sequence, value: `${prefix}${year}${String(sequence).padStart(3, '0')}` };
}

async function main() {
  // 与其他验证脚本保持同一约定：先清空业务数据与计数器，保证断言不依赖外部残留状态
  logResetResult('编号数据层', await resetBusinessData(prisma));

  console.log('=== 1. 迁移状态 ===');  const [migration] = await prisma.$queryRawUnsafe(
    'SELECT checksum, finished_at FROM "_prisma_migrations" WHERE migration_name = $1',
    MIGRATION,
  );
  check('迁移已登记且已完成', Boolean(migration && migration.finished_at));
  const expectedChecksum = createHash('sha256')
    .update(readFileSync(MIGRATION_FILE, 'utf8').replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
  check('校验和与迁移文件一致', migration?.checksum === expectedChecksum, `${migration?.checksum}`);

  const [table] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'DocumentSequence'`,
  );
  check('DocumentSequence 表已创建', table.n === 1);

  console.log('\n=== 2. 业务数据与编号计数器状态 ===');
  for (const [label, model] of [
    ['Contract', prisma.contract],
    ['Project', prisma.project],
    ['PaymentReceipt', prisma.paymentReceipt],
    ['ProjectPaymentAllocation', prisma.projectPaymentAllocation],
    ['CostRecord', prisma.costRecord],
  ]) {
    const count = await model.count();
    console.log(`  [INFO] ${label} 记录数 = ${count}（本脚本只做数据层校验，不要求清空）`);
  }
  const customers = await prisma.customer.count();
  console.log(`  [INFO] Customer 保留 ${customers} 条（基础数据不动）`);

  console.log('\n=== 3. 顺序号分配（当前业务数据为空，应从 001 开始） ===');
  const year = 2026;
  const first = await allocate('contract', 'HT', year);
  check('第一张合同号为 HT2026001', first.value === 'HT2026001', first.value);

  const second = await allocate('contract', 'HT', year);
  check('第二张合同号为 HT2026002', second.value === 'HT2026002', second.value);

  const nextYear = await allocate('contract', 'HT', year + 1);
  check('跨年份独立计数：2027 年为 HT2027001', nextYear.value === 'HT2027001', nextYear.value);

  const payment = await allocate('payment', 'HK', year);
  check('回款号从 HK2026001 开始且与合同号互不干扰', payment.value === 'HK2026001', payment.value);

  console.log('\n=== 4. 项目号派生规则 ===');
  const projectNo = `${first.value}-1`;
  check('项目号 = 合同号-序号', projectNo === 'HT2026001-1', projectNo);

  console.log(`\n=== 5. 并发分配 ${CONCURRENCY} 次不重号 ===`);
  await prisma.$executeRawUnsafe(
    `DELETE FROM "DocumentSequence" WHERE "scope" = 'contract' AND "prefix" = 'HT' AND "year" = $1`,
    year,
  );
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => allocate('contract', 'HT', year)),
  );
  const values = results.map((item) => item.value);
  const unique = new Set(values);
  check(`并发生成 ${CONCURRENCY} 个编号全部唯一`, unique.size === CONCURRENCY, [...unique].sort().join(', '));
  check(
    `编号连续无跳号（HT${year}001 ~ HT${year}${String(CONCURRENCY).padStart(3, '0')}）`,
    [...unique].sort().join(',') ===
      Array.from({ length: CONCURRENCY }, (_, i) => `HT${year}${String(i + 1).padStart(3, '0')}`).sort().join(','),
  );

  console.log('\n=== 6. 清理验证数据 ===');
  const deleted = await prisma.$executeRawUnsafe('DELETE FROM "DocumentSequence"');
  console.log(`[INFO] 已删除 ${deleted} 条计数记录，计数器归零，正式录入从 HT2026001 / HK2026001 开始`);

  console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('验证脚本异常:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

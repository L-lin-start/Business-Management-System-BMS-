/**
 * 初始化测试库：把 prisma/migrations 下的全部迁移按顺序应用到 TEST_DATABASE_URL，
 * 然后跑一遍种子，得到一个与开发库结构一致的干净测试库。
 *
 * 用法：node scripts/setup-test-db.cjs
 * 说明：验证脚本已改为默认连测试库（见 test-utils.cjs），本脚本负责把测试库准备好。
 *       可重复执行：已应用过的迁移会跳过。
 */
const { createHash, randomUUID } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { createTestPrismaClient, resolveTestDatabaseUrl } = require('./test-utils.cjs');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'prisma', 'migrations');
const prisma = createTestPrismaClient();

/** 与 apply-migration.cjs 保持一致的语句切分逻辑 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag = null;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      current += char;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') { inBlockComment = false; current += '*/'; i += 1; continue; }
      current += char;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { current += dollarTag; i += dollarTag.length - 1; dollarTag = null; continue; }
      current += char;
      continue;
    }
    if (inSingle) {
      if (char === "'" && next === "'") { current += "''"; i += 1; continue; }
      if (char === "'") inSingle = false;
      current += char;
      continue;
    }
    if (inDouble) {
      if (char === '"') inDouble = false;
      current += char;
      continue;
    }

    if (char === '-' && next === '-') { inLineComment = true; current += '--'; i += 1; continue; }
    if (char === '/' && next === '*') { inBlockComment = true; current += '/*'; i += 1; continue; }
    if (char === "'") { inSingle = true; current += char; continue; }
    if (char === '"') { inDouble = true; current += char; continue; }
    if (char === '$') {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (match) { dollarTag = match[0]; current += dollarTag; i += dollarTag.length - 1; continue; }
    }
    if (char === ';') { statements.push(current.trim()); current = ''; continue; }
    current += char;
  }
  const tail = current.trim();
  if (tail) statements.push(`${tail};`);
  return statements;
}

function prismaChecksum(source) {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

async function main() {
  const { url } = resolveTestDatabaseUrl();
  console.log(`目标测试库：${url.replace(/^[^:]+:[^@]+@/, '***@')}\n`);

  // 全新库还没有迁移记录表，先按 Prisma 的结构建出来
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )
  `);

  const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  console.log(`共 ${migrations.length} 个迁移。\n`);

  let applied = 0;
  // 迁移的 started_at 必须严格递增：Postgres 的 now() 在同一事务/同微秒内可能返回相同值，
  // 一旦并列，按 started_at 排序就会得到不确定的顺序（曾因此把权限基线迁移排到后面导致失败）。
  // 这里按目录名（时间戳前缀）顺序显式指定递增的 started_at。
  const BASE_TIME = Date.parse('2026-01-01T00:00:00Z');

  for (const [index, name] of migrations.entries()) {
    const existing = await prisma.$queryRawUnsafe(
      'SELECT finished_at FROM "_prisma_migrations" WHERE migration_name = $1',
      name,
    );
    if (existing.length > 0 && existing[0].finished_at) {
      console.log(`  跳过（已应用）：${name}`);
      continue;
    }

    const sql = readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
    const statements = splitStatements(sql);
    for (const statement of statements) {
      if (!statement.replace(/--[^\n]*/g, '').trim()) continue;
      await prisma.$executeRawUnsafe(statement);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations"
         ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
       VALUES ($1, $2, $3::timestamptz, $4, NULL, NULL, $5::timestamptz, 1)`,
      randomUUID(),
      prismaChecksum(sql),
      new Date(BASE_TIME + (index + 1) * 1000).toISOString(),
      name,
      new Date(BASE_TIME + index * 1000).toISOString(),
    );
    applied += 1;
    console.log(`  ✅ 已应用：${name}（${statements.length} 条语句）`);
  }

  const tables = await prisma.$queryRawUnsafe(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
  );
  console.log(`\n测试库现有 ${tables[0].n} 张表。`);
  console.log(applied > 0 ? `本次应用了 ${applied} 个迁移。` : '所有迁移均已应用，无需变更。');
  console.log('\n接下来请执行种子以准备角色/权限/流程模板：');
  console.log('  $env:DATABASE_URL=$env:TEST_DATABASE_URL; node prisma/seed.ts');
}

main()
  .catch((error) => {
    console.error('\n初始化测试库失败：', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

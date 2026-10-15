/**
 * 在 Prisma CLI 无法运行的环境下应用迁移：
 * 1. 校验并执行迁移 SQL 中的各个语句（支持 PL/pgSQL $$ 块）；
 * 2. 按 Prisma 的算法（文件内容 SHA-256，行尾归一化为 LF）计算校验和；
 * 3. 写入 _prisma_migrations，使 `prisma migrate status` 认账。
 *
 * 用法：node scripts/apply-migration.cjs prisma/migrations/<name>/migration.sql
 */
const { createHash, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const migrationFile = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('用法: node scripts/apply-migration.cjs <migration.sql 路径>');
  process.exit(1);
}

const migrationName = path.basename(path.dirname(migrationFile));
const sql = readFileSync(migrationFile, 'utf8');

/**
 * 按分号切分语句：跳过注释行，忽略字符串与 $$ 代码块内部的分号。
 */
function splitStatements(source) {
  const statements = [];
  let current = '';
  let dollarTag = null;
  let inSingleQuote = false;
  let inLineComment = false;
  let atLineStart = true;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        atLineStart = true;
        current += char;
      }
      continue;
    }

    if (atLineStart && !dollarTag && !inSingleQuote && (char === '-' && source[index + 1] === '-')) {
      inLineComment = true;
      continue;
    }
    if (char !== ' ' && char !== '\t') atLineStart = false;

    if (dollarTag) {
      if (char === '$' && source.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
        continue;
      }
      current += char;
      continue;
    }

    if (inSingleQuote) {
      current += char;
      if (char === "'") inSingleQuote = false;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      current += char;
      continue;
    }

    if (char === '$') {
      const match = /^\$[A-Za-z_0-9]*\$/.exec(source.slice(index));
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        index += dollarTag.length - 1;
        continue;
      }
    }

    if (char === ';') {
      const statement = current.trim();
      if (statement) statements.push(`${statement};`);
      current = '';
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) statements.push(`${tail};`);
  return statements;
}

function prismaChecksum(source) {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

const prisma = new PrismaClient();

async function main() {
  const [existing] = await prisma.$queryRawUnsafe(
    'SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" WHERE migration_name = $1',
    migrationName,
  );
  if (existing && existing.finished_at) {
    console.log(`迁移 ${migrationName} 已应用，跳过。`);
    return;
  }

  const statements = splitStatements(sql);
  console.log(`开始应用迁移 ${migrationName}，共 ${statements.length} 条语句。`);
  for (const statement of statements) {
    const preview = statement.replace(/\s+/g, ' ').slice(0, 70);
    await prisma.$executeRawUnsafe(statement);
    console.log(`  ok: ${preview}${preview.length >= 70 ? '…' : ''}`);
  }

  const checksum = prismaChecksum(sql);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "_prisma_migrations"
       ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
     VALUES ($1, $2, CURRENT_TIMESTAMP, $3, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
    randomUUID(),
    checksum,
    migrationName,
  );
  console.log(`迁移 ${migrationName} 已记录，checksum=${checksum}`);
}

main()
  .catch((error) => {
    console.error('迁移失败:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

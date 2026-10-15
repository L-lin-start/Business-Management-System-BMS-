#!/usr/bin/env node
/**
 * 数据备份脚本（数据库 + 附件文件）。
 *
 * ## 为什么必须两个都备
 *
 * 附件文件（官文扫描件、合同附件等）**不在数据库里**，数据库只存它们的路径与元信息。
 * 只备份数据库的话，恢复之后所有附件都会变成"文件不存在" —— 备份等于白做。
 *
 * ## 用法
 *
 *   node scripts/backup.cjs                    # 备份开发库
 *   node scripts/backup.cjs --db=test          # 备份测试库
 *   node scripts/backup.cjs --keep=30          # 保留最近 30 份（默认 7）
 *   node scripts/backup.cjs --out=E:\备份      # 输出目录（默认 <仓库>/backups）
 *   node scripts/backup.cjs --verify-only=备份目录   # 只校验已有备份，不新建
 *
 * ## 产物
 *
 *   backups/2026-10-14_0930/
 *     ├── database.sql          完整 SQL 转储（含建表 + 全部数据）
 *     ├── uploads/              附件目录完整副本
 *     └── manifest.json         校验清单：条数、文件数、校验和
 *
 * ## 重要提醒
 *
 * **备份不要和数据库放在同一块物理磁盘上。** 本脚本默认输出到仓库下的 `backups/`，
 * 用 `--out` 指到移动硬盘、网络盘或另一台机器才具备真正的容灾能力。
 */
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const API_DIR = join(ROOT, 'apps', 'api');

/** pg_dump / psql 常见安装位置：PATH 里通常没有，需要按顺序探测 */
const PG_CANDIDATES = [
  'D:\\PostgreSQL\\14\\bin',
  'C:\\Program Files\\PostgreSQL\\14\\bin',
  'C:\\Program Files\\PostgreSQL\\15\\bin',
  'C:\\Program Files\\PostgreSQL\\16\\bin',
  '/usr/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
];

function parseArgs(argv) {
  const args = { db: 'dev', keep: 7, out: join(ROOT, 'backups'), verifyOnly: null };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--db=')) args.db = raw.slice(5);
    else if (raw.startsWith('--keep=')) args.keep = Number(raw.slice(7));
    else if (raw.startsWith('--out=')) args.out = raw.slice(6);
    else if (raw.startsWith('--verify-only=')) args.verifyOnly = raw.slice(14);
  }
  return args;
}

/** 从 apps/api/.env 读取连接串（不依赖 dotenv，减少对运行环境的假设） */
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const result = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const matched = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (matched) result[matched[1]] = matched[2].replace(/^["']|["']$/g, '');
  }
  return result;
}

/** 从连接串解析出 pg_dump 需要的参数 */
function parseDatabaseUrl(url) {
  const matched = /^postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/.exec(url);
  if (!matched) throw new Error(`无法解析数据库连接串：${url.slice(0, 24)}…`);
  const [, user, password, host, port, database] = matched;
  return { user, password, host, port, database };
}

function findPgTool(name) {
  // 1) 环境变量显式指定
  const explicit = process.env.PG_BIN;
  if (explicit) {
    const candidate = join(explicit, process.platform === 'win32' ? `${name}.exe` : name);
    if (existsSync(candidate)) return candidate;
  }
  // 2) PATH
  try {
    const which = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim().split(/\r?\n/)[0];
    if (which && existsSync(which)) return which;
  } catch {
    /* PATH 里没有，继续探测 */
  }
  // 3) 常见安装目录
  for (const dir of PG_CANDIDATES) {
    const candidate = join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `找不到 ${name}。请安装 PostgreSQL 客户端工具，或用环境变量指定目录，例如：\n` +
      `  $env:PG_BIN='D:\\PostgreSQL\\14\\bin'`,
  );
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function dirStats(dir) {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/**
 * 校验一份备份是否可用。
 *
 * 只检查"文件存在且长得像 SQL 转储"这一层 —— 目的是抓出**空转储**这类最常见的静默失败
 * （pg_dump 连接失败时也可能留下 0 字节文件，不校验就会以为备份成功了）。
 * 更彻底的校验必须靠恢复演练：把备份恢复到一台临时库上，确认表数量与关键数据一致。
 */
function verifyBackup(dir) {
  const problems = [];
  const detail = {};

  const sqlPath = join(dir, 'database.sql');
  if (!existsSync(sqlPath)) {
    problems.push('缺少 database.sql');
  } else {
    const size = statSync(sqlPath).size;
    detail.sqlBytes = size;
    if (size < 1024) problems.push(`database.sql 只有 ${size} 字节，疑似空转储`);
    const head = readFileSync(sqlPath, 'utf8').slice(0, 4000);
    if (!head.includes('PostgreSQL database dump')) problems.push('database.sql 开头不像 pg_dump 产物');
    // 至少要能看到业务表，否则可能连错了库（比如连到空库）
    for (const table of ['Customer', 'Contract', 'Project']) {
      if (!head.includes(table) && !readFileSync(sqlPath, 'utf8').includes(`TABLE "${table}"`)) {
        problems.push(`database.sql 里找不到表 ${table}，可能连错了数据库`);
      }
    }
  }

  const uploadsDir = join(dir, 'uploads');
  if (!existsSync(uploadsDir)) {
    detail.uploadsFiles = 0;
    detail.uploadsBytes = 0;
  } else {
    const stats = dirStats(uploadsDir);
    detail.uploadsFiles = stats.files;
    detail.uploadsBytes = stats.bytes;
  }

  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) problems.push('缺少 manifest.json');
  else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    detail.manifest = manifest;
    // 转储文件的校验和必须与清单一致，否则说明文件在备份后被改动过
    if (detail.sqlBytes !== undefined && manifest.sqlBytes !== detail.sqlBytes) {
      problems.push(`database.sql 大小(${detail.sqlBytes})与清单(${manifest.sqlBytes})不一致`);
    }
    if (manifest.sqlSha256 && existsSync(sqlPath) && sha256(sqlPath) !== manifest.sqlSha256) {
      problems.push('database.sql 校验和与清单不一致（文件可能已损坏）');
    }
  }

  return { ok: problems.length === 0, problems, detail };
}

/** 按名称排序，保留最近 keep 份，删掉更早的 */
function pruneOldBackups(outDir, keep, currentName) {
  if (!existsSync(outDir)) return [];
  const dirs = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const removed = [];
  for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    if (name === currentName) continue; // 永不删除刚生成的这份
    rmSync(join(outDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function timestampName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

function runBackup(args) {
  const envFile = readEnvFile(join(API_DIR, '.env'));
  const key = args.db === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  const url = process.env[key] ?? envFile[key];
  if (!url) throw new Error(`没找到 ${key}（检查 apps/api/.env）`);
  const target = parseDatabaseUrl(url);

  const pgDump = findPgTool('pg_dump');
  const stamp = timestampName();
  const backupDir = join(resolve(args.out), stamp);
  if (existsSync(backupDir)) {
    console.log(`  ⚠ 同名备份已存在，覆盖：${backupDir}`);
    rmSync(backupDir, { recursive: true, force: true });
  }
  mkdirSync(backupDir, { recursive: true });

  console.log(`数据库：${target.user}@${target.host}:${target.port}/${target.database}`);
  console.log(`输出到：${backupDir}`);
  console.log(`pg_dump：${pgDump}\n`);

  // 1) 数据库转储。用 --format=plain 便于人工查看与按需恢复单个表。
  const sqlPath = join(backupDir, 'database.sql');
  console.log('  [1/3] 导出数据库…');
  execFileSync(
    pgDump,
    [
      '--host', target.host,
      '--port', target.port,
      '--username', target.user,
      '--dbname', target.database,
      '--format=plain',
      '--no-owner',
      '--no-privileges',
      '--file', sqlPath,
    ],
    { env: { ...process.env, PGPASSWORD: target.password }, stdio: 'inherit' },
  );

  // 2) 附件目录整体复制
  console.log('  [2/3] 复制附件目录…');
  const uploadsSource = resolve(API_DIR, envFile.FILE_STORAGE_PATH ?? '../../storage/uploads');
  const uploadsTarget = join(backupDir, 'uploads');
  const uploadStats = dirStats(uploadsSource);
  if (existsSync(uploadsSource)) {
    const copy = (from, to) => {
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const src = join(from, entry.name);
        const dst = join(to, entry.name);
        if (entry.isDirectory()) copy(src, dst);
        else if (entry.isFile()) copyFileSync(src, dst);
      }
    };
    copy(uploadsSource, uploadsTarget);
    console.log(`        附件 ${uploadStats.files} 个文件，${(uploadStats.bytes / 1024).toFixed(1)} KB`);
  } else {
    mkdirSync(uploadsTarget, { recursive: true });
    console.log('        附件目录不存在，已创建空目录（尚未上传过附件时属正常）');
  }

  // 3) 清单 + 校验
  console.log('  [3/3] 生成校验清单…');
  const manifest = {
    createdAt: new Date().toISOString(),
    source: { host: target.host, port: target.port, database: target.database, user: target.user },
    pgDumpVersion: execFileSync(pgDump, ['--version'], { encoding: 'utf8' }).trim(),
    sqlBytes: statSync(sqlPath).size,
    sqlSha256: sha256(sqlPath),
    uploadsFiles: uploadStats.files,
    uploadsBytes: uploadStats.bytes,
  };
  writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const verified = verifyBackup(backupDir);
  if (!verified.ok) {
    console.log('');
    for (const problem of verified.problems) console.log(`  ❌ ${problem}`);
    throw new Error('备份校验未通过 —— 这份备份不可用，请检查上面的问题');
  }

  const removed = pruneOldBackups(resolve(args.out), args.keep, stamp);

  console.log('');
  console.log('  ✅ 备份完成并通过校验');
  console.log(`     数据库转储：${(manifest.sqlBytes / 1024).toFixed(1)} KB`);
  console.log(`     附件：${manifest.uploadsFiles} 个文件`);
  console.log(`     校验和：${manifest.sqlSha256.slice(0, 16)}…`);
  if (removed.length) console.log(`     已按保留策略清理旧备份：${removed.join('、')}`);
  const resolvedOut = resolve(args.out);
  if (resolvedOut.startsWith(ROOT)) {
    console.log('');
    console.log('  ⚠ 备份默认放在仓库目录下，和数据库在同一块磁盘 ——');
    console.log('     这在"硬盘坏了"或"误删整个目录"时救不了你。');
    console.log('     请用 --out 指到移动硬盘 / 网络盘 / 另一台机器。');
  }
  return backupDir;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node scripts/backup.cjs [--db=dev|test] [--keep=7] [--out=目录] [--verify-only=目录]');
    return 0;
  }

  console.log('=== 数据备份 ===\n');

  if (args.verifyOnly) {
    const dir = resolve(args.verifyOnly);
    console.log(`校验已有备份：${dir}\n`);
    const result = verifyBackup(dir);
    if (result.ok) {
      console.log('  ✅ 校验通过');
      console.log(`     转储 ${(result.detail.sqlBytes / 1024).toFixed(1)} KB，附件 ${result.detail.uploadsFiles} 个文件`);
      return 0;
    }
    for (const problem of result.problems) console.log(`  ❌ ${problem}`);
    return 1;
  }

  runBackup(args);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`\n备份失败：${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

module.exports = { verifyBackup, parseDatabaseUrl, timestampName, dirStats, pruneOldBackups };

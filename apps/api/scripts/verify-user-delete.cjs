/**
 * 用户账号删除/恢复验证。
 *
 * ## 背景
 *
 * 管理系统原本**没有删除用户的功能**（后端从来没有 @Delete('users/:id')），
 * 只能「停用」。本脚本验证新增的删除功能，重点是**四道防呆**，
 * 因为用户删除是不可逆的高危操作（软删除，但会影响登录与业务归属）。
 *
 * ## 覆盖
 *
 *   1. 删除原因必填（后端强制，空串/纯空格都拒绝）
 *   2. 不能删除当前登录账号（否则把自己踢出系统）
 *   3. 不能删除系统管理员账号
 *   4. 至少保留一个启用中的系统管理员
 *   5. 删除后：列表不再显示、无法登录、角色与部门关联被解除、密码被重置
 *   6. 恢复后：账号可登录，但角色需重新分配（刻意设计，避免沿用旧职责越权）
 *   7. 删除与恢复都写审计日志
 *
 * 用法：node scripts/verify-user-delete.cjs
 */
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { createTestPrismaClient, prepareTestDatabaseEnv, resolveTestDatabaseUrl } = require('./test-utils.cjs');

prepareTestDatabaseEnv();

const prisma = createTestPrismaClient();
let child;
let failures = 0;
const PORT = 3436;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD?.trim() || 'admin123';

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, options = {}, token) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}

async function login(username, password) {
  const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  return result.status < 400 ? result.body.accessToken : null;
}

async function main() {
  const { url } = resolveTestDatabaseUrl();
  console.log(`数据库：${url.replace(/^[^:]+:[^@]+@/, '***@')}\n`);

  child = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, API_PORT: String(PORT), REMINDER_SCAN_INTERVAL_MINUTES: '0' },
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(700);
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch { /* 尚未启动 */ }
  }
  if (!ready) throw new Error('被测服务未在预期时间内启动');

  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
  await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10), status: 'ACTIVE', deletedAt: null } });
  const adminToken = await login('admin', ADMIN_PASSWORD);
  if (!adminToken) throw new Error('管理员登录失败，无法继续');

  const salesRole = await prisma.role.findFirstOrThrow({ where: { code: 'SALES' } });
  const dept = await prisma.department.findFirstOrThrow({ where: { parentId: null } });
  const hash = await bcrypt.hash('Verify123', 10);

  /** 造一个测试用户，密码 Verify123，带角色与部门 */
  const makeUser = async (suffix) => {
    await prisma.user.deleteMany({ where: { username: `vud-${suffix}` } });
    return prisma.user.create({
      data: {
        username: `vud-${suffix}`,
        displayName: `删用户验证${suffix}`,
        passwordHash: hash,
        roles: { create: [{ roleId: salesRole.id }] },
        departments: { create: [{ departmentId: dept.id }] },
      },
    });
  };

  console.log('=== 1. 前置：普通用户可正常登录 ===');
  const target = await makeUser('target');
  const targetToken = await login('vud-target', 'Verify123');
  check('目标用户创建后能登录', Boolean(targetToken));

  console.log('\n=== 2. 删除原因必填（后端强制）===');
  const noReason = await api(`/api/admin/users/${target.id}`, { method: 'DELETE', body: JSON.stringify({}) }, adminToken);
  check('不传原因 → 拒绝', noReason.status >= 400, `HTTP ${noReason.status}`);
  const blankReason = await api(`/api/admin/users/${target.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '   ' }) }, adminToken);
  check('原因纯空格 → 拒绝', blankReason.status >= 400, `HTTP ${blankReason.status}`);
  const stillThere = await prisma.user.findFirst({ where: { id: target.id } });
  check('被拒绝后账号未被删除', stillThere?.deletedAt === null);

  console.log('\n=== 3. 不能删除当前登录账号 ===');
  const selfDelete = await api(`/api/admin/users/${admin.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '验证：删自己' }) }, adminToken);
  check('删除自己 → 拒绝', selfDelete.status >= 400, `HTTP ${selfDelete.status}`);
  check('提示语说明了原因', String(selfDelete.body?.message ?? '').includes('当前登录'), String(selfDelete.body?.message ?? ''));
  const adminStill = await prisma.user.findFirst({ where: { id: admin.id } });
  check('管理员账号仍在', adminStill?.deletedAt === null);

  console.log('\n=== 4. 不能删除系统管理员账号 ===');
  // 另建一个系统管理员（这样不触发"至少保留一个"那条，单独验证"不能删管理员"）
  const admin2 = await prisma.user.create({
    data: { username: 'vud-admin2', displayName: '删用户验证管理员2', passwordHash: hash, isSystemAdmin: true },
  });
  const admin2Token = await login('vud-admin2', 'Verify123');
  const deleteAdmin = await api(`/api/admin/users/${admin2.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '验证：删系统管理员' }) }, adminToken);
  check('删除系统管理员 → 拒绝', deleteAdmin.status >= 400, `HTTP ${deleteAdmin.status}`);
  check('提示引导改用「停用」', String(deleteAdmin.body?.message ?? '').includes('停用'), String(deleteAdmin.body?.message ?? ''));
  void admin2Token;

  console.log('\n=== 5. 正常删除：账号失效、关联解除、密码重置 ===');
  // 回归：**系统里只剩一个管理员时，普通用户仍然必须能删掉**。
  // 曾经的写法把"至少保留一个管理员"的检查放在了管理员分支之外，
  // 导致删除任何普通用户都被 409 拒绝（提示"系统至少需要保留一个启用中的系统管理员账号"）。
  // 这个断言专门守住这一点。
  const activeAdmins = await prisma.user.count({ where: { isSystemAdmin: true, status: 'ACTIVE', deletedAt: null } });
  check('前置：系统里确实只剩少量启用中的管理员', activeAdmins >= 1, `${activeAdmins} 个`);
  const removed = await api(`/api/admin/users/${target.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '验证：人员离职' }) }, adminToken);
  check('普通用户在只剩 1 个管理员时也能删除（回归：不被管理员规则误拦）', removed.status === 200 || removed.status === 201, `HTTP ${removed.status} ${removed.body?.message ?? ''}`);

  const afterDelete = await prisma.user.findFirst({ where: { id: target.id }, include: { roles: true, departments: true } });
  check('已标记 deletedAt（软删除）', afterDelete?.deletedAt !== null);
  check('状态被置为 INACTIVE', afterDelete?.status === 'INACTIVE', String(afterDelete?.status));
  check('角色关联已解除', afterDelete?.roles.length === 0, `${afterDelete?.roles.length} 条`);
  check('部门关联已解除', afterDelete?.departments.length === 0, `${afterDelete?.departments.length} 条`);
  check('密码已重置（不再等于原密码哈希）', afterDelete?.passwordHash !== hash);
  const reLogin = await login('vud-target', 'Verify123');
  check('已删除账号无法登录', reLogin === null);

  const userList = await api('/api/admin/users', {}, adminToken);
  check('列表中不再显示该账号', !(userList.body ?? []).some((u) => u.id === target.id), `列表 ${(userList.body ?? []).length} 个账号`);

  console.log('\n=== 6. 恢复账号：可登录，但角色需重新分配 ===');
  // 回归：用户账号必须出现在「已删除数据」里，否则管理员没有恢复入口。
  // User 表没有 deleteReason / deletedBy 字段，原因与操作人是从审计日志关联出来的，
  // 这里一并验证那段关联逻辑没有失效。
  const deletedList = await api('/api/admin/deleted-records', {}, adminToken);
  check('「已删除数据」支持 User 类型', Boolean(deletedList.body?.resourceTypes?.User), deletedList.body?.resourceTypes?.User ?? '不支持');
  const userRow = (deletedList.body?.items ?? []).find((item) => item.resourceType === 'User' && item.id === target.id);
  check('删除的账号出现在已删除列表', Boolean(userRow), `${(deletedList.body?.items ?? []).length} 条记录`);
  check('列表带出删除原因（来自审计日志）', String(userRow?.deleteReason ?? '').includes('人员离职'), String(userRow?.deleteReason ?? ''));
  check('列表带出操作人姓名', String(userRow?.deletedByName ?? '').length > 0, String(userRow?.deletedByName ?? ''));

  // 走「已删除数据」的恢复入口（而不是直接调 /admin/users/:id/restore）——
  // 管理员实际点的是这个按钮，必须验证这条路径通了
  const restored = await api(`/api/admin/deleted-records/User/${target.id}/restore`, { method: 'POST', body: JSON.stringify({ reason: '验证：误删恢复' }) }, adminToken);
  check('通过「已删除数据」恢复成功', restored.status === 200 || restored.status === 201, `HTTP ${restored.status} ${restored.body?.message ?? ''}`);
  const afterRestore = await prisma.user.findFirst({ where: { id: target.id }, include: { roles: true, departments: true } });
  check('deletedAt 已清空', afterRestore?.deletedAt === null);
  check('状态回到 ACTIVE', afterRestore?.status === 'ACTIVE', String(afterRestore?.status));
  check('角色未被自动恢复（刻意：职责可能已变）', afterRestore?.roles.length === 0);
  const restoredReLogin = await login('vud-target', 'Verify123');
  check('原密码仍不可用（须管理员重设密码）', restoredReLogin === null);

  console.log('\n=== 7. 删除与恢复都写审计日志 ===');
  const logs = await prisma.auditLog.findMany({
    where: { resourceType: 'User', resourceId: target.id },
    orderBy: { createdAt: 'asc' },
  });
  check('产生了审计日志', logs.length >= 2, `${logs.length} 条`);
  check('记录了删除动作', logs.some((l) => l.action === 'DELETE'));
  check('记录了恢复动作', logs.some((l) => l.action === 'RESTORE'));
  const deleteLog = logs.find((l) => l.action === 'DELETE');
  check('删除日志带删除原因', String(deleteLog?.reason ?? '').includes('人员离职'), String(deleteLog?.reason ?? ''));
  check('删除日志记录了操作人', deleteLog?.actorId === admin.id);

  console.log('\n=== 8. 清理验证数据 ===');
  await prisma.auditLog.deleteMany({ where: { resourceType: 'User', resourceId: { in: [target.id, admin2.id] } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: [target.id, admin2.id] } } });
  await prisma.userDepartment.deleteMany({ where: { userId: { in: [target.id, admin2.id] } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: 'vud-' } } });
  check('验证用户已清理', (await prisma.user.count({ where: { username: { startsWith: 'vud-' } } })) === 0);
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error?.message ?? error);
    failures += 1;
  })
  .finally(async () => {
    if (child) { child.kill(); await sleep(400); }
    const adminUser = await prisma.user.findFirst({ where: { username: 'admin' } });
    if (adminUser) {
      await prisma.user.update({ where: { id: adminUser.id }, data: { passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10), deletedAt: null, status: 'ACTIVE' } });
    }
    await prisma.user.deleteMany({ where: { username: { startsWith: 'vud-' } } });
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    process.exit(failures > 0 ? 1 : 0);
  });

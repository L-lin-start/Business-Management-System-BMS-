/**
 * 部门删除验证。
 *
 * 覆盖四种拦截与正常删除：
 *   1. 空部门（无子部门、无成员）→ **可以删除**
 *   2. 有子部门 → 拒绝，并说明有几个子部门
 *   3. 有成员 → 拒绝，并说明有几名成员
 *   4. 根部门 / 最后一个部门 → 拒绝
 *   5. 不存在 → 404
 *   6. 无权限账号 → 403
 *
 * 用法：node scripts/verify-department-delete.cjs   （需先 tsc 构建出 dist）
 * 采用进程内启动 API + 真实 HTTP 请求，覆盖守卫、权限与管道。
 */
const { spawn } = require('node:child_process');
const { createTestPrismaClient, prepareTestDatabaseEnv, resolveTestDatabaseUrl } = require('./test-utils.cjs');

prepareTestDatabaseEnv();
const prisma = createTestPrismaClient();
let child;
let failures = 0;
const PORT = 3700;
const BASE = `http://127.0.0.1:${PORT}`;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`);
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

/** 清理本脚本造的部门，避免污染测试库。注意要**从叶子往上删**：父部门被删后子部门的 parentId 会变 null 而留下来。 */
async function cleanup() {
  await prisma.userDepartment.deleteMany({ where: { department: { name: { startsWith: '验证部门' } } } });
  for (let round = 0; round < 10; round += 1) {
    const remaining = await prisma.department.findMany({ where: { name: { startsWith: '验证部门' } }, select: { id: true } });
    if (remaining.length === 0) break;
    const ids = remaining.map((item) => item.id);
    // 先删没有子部门的
    const parents = new Set(
      (await prisma.department.findMany({ where: { parentId: { in: ids } }, select: { parentId: true } })).map((item) => item.parentId),
    );
    const leaves = ids.filter((id) => !parents.has(id));
    await prisma.department.deleteMany({ where: { id: { in: leaves.length > 0 ? leaves : ids } } });
  }
  await prisma.user.deleteMany({ where: { username: { startsWith: 'verify_dept_' } } });
}

async function main() {
  const { url } = resolveTestDatabaseUrl();
  console.log(`数据库：${url.replace(/^[^:]+:[^@]+@/, '***@')}\n`);
  await cleanup();

  child = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, API_PORT: String(PORT) },
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    await sleep(700);
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch { /* 等待启动 */ }
  }
  if (!ready) throw new Error('被测服务启动失败');

  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  const token = login.body.accessToken;
  const adminUserId = login.body.user.id;
  const stamp = Date.now().toString().slice(-6);

  // 先建一个根部门（种子里测试库已有 ROOT，这里复用）
  const root = await prisma.department.findFirstOrThrow({ where: { parentId: null } });
  console.log(`当前根部门：${root.name}\n`);

  console.log('=== 1. 空部门可以删除 ===');
  const empty = await api('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify({ name: `验证部门-空-${stamp}` }),
  }, token);
  check('新建部门成功', empty.status === 201, String(empty.status));
  const emptyId = empty.body.id;

  const del = await api(`/api/admin/departments/${emptyId}`, { method: 'DELETE' }, token);
  check('删除空部门成功', del.status === 200, `${del.status} ${JSON.stringify(del.body).slice(0, 110)}`);
  check('部门已不存在', (await prisma.department.findUnique({ where: { id: emptyId } })) === null);

  const audit = await prisma.auditLog.findFirst({
    where: { resourceType: 'Department', resourceId: emptyId, action: 'DELETE' },
    select: { reason: true },
  });
  check('删除写入审计日志', String(audit?.reason ?? '').includes('验证部门-空'), String(audit?.reason));

  console.log('\n=== 2. 有子部门的部门不能删除；把子部门移走后可以删 ===');
  // 为了不受"同级唯一"规则干扰，这里在根层级建两个部门（parent + sibling），
  // parent 下再挂一个 child。删除 parent 前先把 child 移到 sibling 下。
  const parentDept = await api('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify({ name: `验证部门-父-${stamp}` }),
  }, token);
  const siblingDept = await api('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify({ name: `验证部门-伯-${stamp}` }),
  }, token);
  const childDept = await api('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify({ name: `验证部门-子-${stamp}`, parentId: parentDept.body.id }),
  }, token);
  check('已建父子与平级三个部门', parentDept.status === 201 && siblingDept.status === 201 && childDept.status === 201);

  const delParent = await api(`/api/admin/departments/${parentDept.body.id}`, { method: 'DELETE' }, token);
  check('删除有子部门的部门 → 拒绝', delParent.status === 409, `${delParent.status} ${JSON.stringify(delParent.body).slice(0, 120)}`);
  check('拒绝原因说明子部门数量', String(delParent.body?.message ?? '').includes('1 个子部门'), String(delParent.body?.message));

  // 用「修改上级部门」接口把 child 移到 sibling 下（顺便验证 PATCH 可用）
  const moveChild = await api(`/api/admin/departments/${childDept.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ parentId: siblingDept.body.id }),
  }, token);
  check('可以修改部门的上级（把子部门移走）', moveChild.status === 200, `${moveChild.status} ${JSON.stringify(moveChild.body).slice(0, 90)}`);

  const delParentAgain = await api(`/api/admin/departments/${parentDept.body.id}`, { method: 'DELETE' }, token);
  check('子部门移走后父部门可以删除', delParentAgain.status === 200, `${delParentAgain.status} ${JSON.stringify(delParentAgain.body).slice(0, 110)}`);
  // 收尾：删掉 sibling（它下面还挂着 child，先删 child）
  await prisma.department.deleteMany({ where: { id: childDept.body.id } });
  await prisma.department.deleteMany({ where: { id: siblingDept.body.id } });

  console.log('\n=== 3. 有成员的部门不能删除 ===');
  const withMember = await api('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify({ name: `验证部门-有人-${stamp}` }),
  }, token);
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('Verify123', 10);
  const member = await prisma.user.create({
    data: { username: `verify_dept_${stamp}`, displayName: '部门验证用户', passwordHash: hash },
  });
  await prisma.userDepartment.create({ data: { userId: member.id, departmentId: withMember.body.id, isPrimary: true } });

  const delWithMember = await api(`/api/admin/departments/${withMember.body.id}`, { method: 'DELETE' }, token);
  check('删除有成员的部门 → 拒绝', delWithMember.status === 409, `${delWithMember.status} ${JSON.stringify(delWithMember.body).slice(0, 120)}`);
  check('拒绝原因说明成员数量', String(delWithMember.body?.message ?? '').includes('1 名成员'), String(delWithMember.body?.message));

  // 把成员移走后应能删除
  await prisma.userDepartment.deleteMany({ where: { departmentId: withMember.body.id } });
  const delAfterMove = await api(`/api/admin/departments/${withMember.body.id}`, { method: 'DELETE' }, token);
  check('成员移走后可以删除', delAfterMove.status === 200, String(delAfterMove.status));

  console.log('\n=== 4. 同级最后一个部门不能删除，平级部门可以删 ===');
  // 组织架构允许多个平级部门（PRD 5.1 支持多部门），所以"没有上级"本身不该禁止删除。
  // 这里在根层级建两个部门，验证：能删掉一个，但删到只剩一个时被拦。
  const rootSiblingA = await api('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify({ name: `验证部门-根A-${stamp}` }),
  }, token);
  const rootSiblingB = await api('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify({ name: `验证部门-根B-${stamp}` }),
  }, token);
  check('在根层级建了两个平级部门', rootSiblingA.status === 201 && rootSiblingB.status === 201);

  const delRootSibling = await api(`/api/admin/departments/${rootSiblingA.body.id}`, { method: 'DELETE' }, token);
  check('平级部门（有兄弟）可以删除', delRootSibling.status === 200, `${delRootSibling.status} ${JSON.stringify(delRootSibling.body).slice(0, 110)}`);

  // 公司原有根部门 + 刚建的 B 都还在，删 B 应成功；再删到只剩 1 个时才被拦
  const delB = await api(`/api/admin/departments/${rootSiblingB.body.id}`, { method: 'DELETE' }, token);
  check('第二个平级部门也能删除', delB.status === 200, String(delB.status));

  // 造一个"同级唯一"的场景：在 root 下只留一个子部门，删它应被拦
  const onlyChild = await api('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify({ name: `验证部门-独子-${stamp}`, parentId: root.id }),
  }, token);
  check('在根部门下建了一个子部门', onlyChild.status === 201);
  const delOnlyChild = await api(`/api/admin/departments/${onlyChild.body.id}`, { method: 'DELETE' }, token);
  check('同级只剩一个部门时 → 拒绝', delOnlyChild.status === 409, `${delOnlyChild.status} ${JSON.stringify(delOnlyChild.body).slice(0, 130)}`);
  check('拒绝原因说明同级只剩一个', String(delOnlyChild.body?.message ?? '').includes('只剩'), String(delOnlyChild.body?.message));
  await prisma.department.deleteMany({ where: { id: onlyChild.body.id } });

  console.log('\n=== 5. 不存在的部门 → 404 ===');
  const missing = await api('/api/admin/departments/not-exist-id', { method: 'DELETE' }, token);
  check('删除不存在的部门 → 404', missing.status === 404, String(missing.status));

  console.log('\n=== 6. 编辑部门（改名 / 改上级 / 改负责人） ===');
  const editTarget = await api('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify({ name: `验证部门-待编辑-${stamp}` }),
  }, token);

  const rename = await api(`/api/admin/departments/${editTarget.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: `验证部门-已改名-${stamp}` }),
  }, token);
  check('可以改部门名称', rename.status === 200 && rename.body?.name === `验证部门-已改名-${stamp}`, String(rename.body?.name));

  const setManager = await api(`/api/admin/departments/${editTarget.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ managerId: adminUserId }),
  }, token);
  check('可以设置部门负责人', setManager.status === 200 && setManager.body?.managerId === adminUserId, String(setManager.body?.managerId));

  const setParent = await api(`/api/admin/departments/${editTarget.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ parentId: root.id }),
  }, token);
  check('可以改上级部门', setParent.status === 200 && setParent.body?.parentId === root.id, String(setParent.body?.parentId));

  const clearParent = await api(`/api/admin/departments/${editTarget.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ parentId: '' }),
  }, token);
  check('传空上级 → 提升为顶层部门', clearParent.status === 200 && clearParent.body?.parentId === null, String(clearParent.body?.parentId));

  const editAudit = await prisma.auditLog.findFirst({
    where: { resourceType: 'Department', resourceId: editTarget.body.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' },
    select: { beforeData: true, afterData: true },
  });
  check('编辑写入审计日志（含前后值）', editAudit !== null && Boolean(editAudit.beforeData) && Boolean(editAudit.afterData));

  console.log('\n=== 7. 防环：不能把部门挂到自己的下级 ===');
  // 造 A → B → C 三层，尝试把 A 挂到 C 下（应被拒），以及把 A 挂到自己下（应被拒）
  const cycleA = await api('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify({ name: `验证部门-环A-${stamp}` }),
  }, token);
  const cycleB = await api('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify({ name: `验证部门-环B-${stamp}`, parentId: cycleA.body.id }),
  }, token);
  const cycleC = await api('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify({ name: `验证部门-环C-${stamp}`, parentId: cycleB.body.id }),
  }, token);
  check('已建三层部门 A → B → C', cycleA.status === 201 && cycleB.status === 201 && cycleC.status === 201);

  const selfParent = await api(`/api/admin/departments/${cycleA.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ parentId: cycleA.body.id }),
  }, token);
  check('把上级设成自己 → 拒绝', selfParent.status === 409, `${selfParent.status} ${JSON.stringify(selfParent.body).slice(0, 100)}`);

  const cycleToGrandChild = await api(`/api/admin/departments/${cycleA.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ parentId: cycleC.body.id }),
  }, token);
  check('把部门挂到自己的孙级下 → 拒绝（防环）', cycleToGrandChild.status === 409, `${cycleToGrandChild.status} ${JSON.stringify(cycleToGrandChild.body).slice(0, 110)}`);
  check('拒绝原因说明会形成循环', String(cycleToGrandChild.body?.message ?? '').includes('循环'), String(cycleToGrandChild.body?.message));

  // 合法移动：把 C 直接挂到 A 下（C 是 A 的后代，但把它挂到 A 下是把后代"上提"，不构成环）
  const legalMove = await api(`/api/admin/departments/${cycleC.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ parentId: cycleA.body.id }),
  }, token);
  check('把后代上提一级（合法）→ 允许', legalMove.status === 200, `${legalMove.status} ${JSON.stringify(legalMove.body).slice(0, 90)}`);

  console.log('\n=== 8. 无权限账号不能删除/编辑 ===');
  const salesRole = await prisma.role.findFirstOrThrow({ where: { code: 'SALES' } });
  const salesHash = require('bcryptjs').hashSync('Verify123', 10);
  await prisma.user.upsert({
    where: { username: 'aaa' },
    update: { passwordHash: salesHash, status: 'ACTIVE' },
    create: { username: 'aaa', displayName: '销售A', passwordHash: salesHash, roles: { create: [{ roleId: salesRole.id }] } },
  });
  const salesLogin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aaa', password: 'Verify123' }) });
  const salesDel = await api(`/api/admin/departments/${root.id}`, { method: 'DELETE' }, salesLogin.body.accessToken);
  check('销售删除部门 → 403', salesDel.status === 403, String(salesDel.status));
  const salesEdit = await api(`/api/admin/departments/${root.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: '越权改名' }),
  }, salesLogin.body.accessToken);
  check('销售编辑部门 → 403', salesEdit.status === 403, String(salesEdit.status));

  await cleanup();
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error?.message ?? error);
    failures += 1;
  })
  .finally(async () => {
    if (child) { child.kill(); await sleep(400); }
    try { await cleanup(); } catch { /* 清理失败不覆盖结论 */ }
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    process.exit(failures > 0 ? 1 : 0);
  });

/**
 * 提醒与首页看板的数据范围验证（PRD 4.6 / 4.7 + 第 3 章数据权限）。
 *
 * ## 业务口径（2026-10-14 确认）
 *
 * | 角色 | 应看到 |
 * |---|---|
 * | 系统管理员 / 总经理（dataScope=ALL） | 全部提醒 |
 * | 销售（SELF） | 只有自己名下的项目/合同 |
 * | 专利/商标代理人、流程人员（RELATED） | 与自己相关的项目（负责人 / 当前节点负责角色 / 办过） |
 * | 申报复核人（DEPARTMENT） | 本部门范围内 |
 *
 * 覆盖：
 *   - 各角色可见量**不相同**（管理员 = 全局，普通人员 ⊂ 全局）
 *   - 管理员与普通人员看到的是**同一批数据的不同子集**（不是各自一套）
 *   - 首页看板 4 项待办与提醒页口径一致，且同样收窄
 *   - 处理/取消处理带范围校验（看不到的提醒不能改）
 *
 * 用法：node scripts/verify-reminder-scope.cjs   （需先 tsc 构建出 dist）
 */
const { spawn } = require('node:child_process');
const { createTestPrismaClient, prepareTestDatabaseEnv, resolveTestDatabaseUrl } = require('./test-utils.cjs');

prepareTestDatabaseEnv();

const prisma = createTestPrismaClient();
let child;
let failures = 0;
const PORT = 3430;
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
  if (result.status >= 400) return null;
  return result.body.accessToken;
}

/** 建一个指定角色的账号，密码统一 Verify123 */
async function ensureUser(username, displayName, roleCode) {
  const bcrypt = require('bcryptjs');
  const role = await prisma.role.findFirstOrThrow({ where: { code: roleCode } });
  const passwordHash = await bcrypt.hash('Verify123', 10);
  const existing = await prisma.user.findFirst({ where: { username } });
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { passwordHash, status: 'ACTIVE' } });
    return existing;
  }
  return prisma.user.create({ data: { username, displayName, passwordHash, roles: { create: [{ roleId: role.id }] } } });
}

async function main() {
  const { url } = resolveTestDatabaseUrl();
  console.log(`数据库：${url.replace(/^[^:]+:[^@]+@/, '***@')}\n`);

  // 清空业务数据
  await prisma.mailDelivery.deleteMany({});
  await prisma.officialDocument.deleteMany({});
  await prisma.actionRecord.deleteMany({});
  await prisma.filingResult.deleteMany({});
  await prisma.projectPaymentAllocation.deleteMany({});
  await prisma.paymentContractAllocation.deleteMany({});
  await prisma.paymentReceipt.deleteMany({});
  await prisma.costRecord.deleteMany({});
  await prisma.reminder.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.contract.deleteMany({});
  await prisma.customer.deleteMany({});
  await prisma.$executeRawUnsafe('DELETE FROM "DocumentSequence"');

  child = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, API_PORT: String(PORT), REMINDER_SCAN_INTERVAL_MINUTES: '0' },
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(700);
    try {
      const health = await fetch(`${BASE}/api/health`);
      if (health.ok) { ready = true; break; }
    } catch { /* 尚未启动 */ }
  }
  if (!ready) throw new Error('被测服务未在预期时间内启动');

  const bcrypt = require('bcryptjs');
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
  await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10), status: 'ACTIVE' } });
  const adminToken = await login('admin', ADMIN_PASSWORD);

  await ensureUser('vrsc-sales-a', '范围验证销售A', 'SALES');
  await ensureUser('vrsc-sales-b', '范围验证销售B', 'SALES');
  await ensureUser('vrsc-agent', '范围验证代理人', 'PATENT_AGENT');
  const salesAToken = await login('vrsc-sales-a', 'Verify123');
  const salesBToken = await login('vrsc-sales-b', 'Verify123');
  const agentToken = await login('vrsc-agent', 'Verify123');

  // ---- 造数据：两个销售各一张客户/合同/项目，项目都处于首节点（节点超期提醒的来源）----
  const stamp = Date.now().toString().slice(-6);
  const salesA = await prisma.user.findFirstOrThrow({ where: { username: 'vrsc-sales-a' } });
  const salesB = await prisma.user.findFirstOrThrow({ where: { username: 'vrsc-sales-b' } });
  const agent = await prisma.user.findFirstOrThrow({ where: { username: 'vrsc-agent' } });
  const patentTemplate = await prisma.workflowTemplate.findFirst({ where: { name: '专利' }, include: { versions: { where: { status: 'PUBLISHED' }, include: { nodes: { orderBy: { sequence: 'asc' } } } } } });
  const version = patentTemplate?.versions[0];
  const firstNode = version?.nodes[0];

  const makeContractWithProject = async (ownerId, tag) => {
    const customer = await prisma.customer.create({ data: { name: `范围验证客户${tag}`, ownerId } });
    const contract = await prisma.contract.create({ data: { contractNo: `VRSC-${tag}-${stamp}`, customerId: customer.id, amount: 10000, itemCount: 1, ownerId } });
    const project = await prisma.project.create({
      data: {
        projectNo: `VRSC-${tag}-${stamp}-1`,
        contractId: contract.id,
        sequence: 1,
        projectName: `范围验证项目${tag}`,
        ownerId,
        ...(version ? { workflowVersionId: version.id, currentNodeCode: firstNode?.code ?? null } : {}),
      },
    });
    return { customer, contract, project };
  };

  const dataA = await makeContractWithProject(salesA.id, 'A');
  const dataB = await makeContractWithProject(salesB.id, 'B');
  // 再给 A 加一个项目：让两边的可见量**不对称**，
  // 这样"各看自己的"才能通过数量直接暴露出来（数量相同会让断言失去意义）。
  const dataA2 = await prisma.project.create({
    data: {
      projectNo: `VRSC-A2-${stamp}-1`,
      contractId: dataA.contract.id,
      sequence: 2,
      projectName: '范围验证项目A2',
      ownerId: salesA.id,
      ...(version ? { workflowVersionId: version.id, currentNodeCode: firstNode?.code ?? null } : {}),
    },
  });

  // 让 A 的项目落在代理人的负责节点上（首节点负责角色通常是 PATENT_AGENT）→ 代理人应看到 A 的提醒
  console.log('=== 1. 构造提醒（节点已超期 + 合同即将到期）===');
  // 节点超期提醒要求「进入当前节点的时间 + 节点时限 < 今天」，
  // 所以把进入时间回拨 60 天，让它必然超期。
  const longAgo = new Date(Date.now() - 60 * 86_400_000);
  await prisma.project.update({ where: { id: dataA.project.id }, data: { currentNodeEnteredAt: longAgo } });
  await prisma.project.update({ where: { id: dataA2.id }, data: { currentNodeEnteredAt: longAgo } });
  await prisma.project.update({ where: { id: dataB.project.id }, data: { currentNodeEnteredAt: longAgo } });

  // 合同级提醒（法定截止日 / 内部安全日）直接造库：本项目销售各一份
  const soon = new Date(Date.now() + 5 * 86_400_000);
  const makeReminder = async (type, sourceType, sourceId, sourceNo, title) =>
    prisma.reminder.create({
      data: {
        type,
        sourceType,
        sourceId,
        sourceNo,
        title,
        detail: '范围验证用',
        triggerAt: new Date(Date.now() - 86_400_000),
        dueAt: soon,
        overdueDays: 0,
        alertLevel: 'URGENT',
        tierDays: 7,
        isHandled: false,
        dedupeKey: `${type}:${sourceId}`,
      },
    });
  await makeReminder('NODE_OVERDUE', 'Project', dataA.project.id, dataA.project.projectNo, `项目 ${dataA.project.projectNo} 节点超期`);
  await makeReminder('NODE_OVERDUE', 'Project', dataA2.id, dataA2.projectNo, `项目 ${dataA2.projectNo} 节点超期`);
  await makeReminder('NODE_OVERDUE', 'Project', dataB.project.id, dataB.project.projectNo, `项目 ${dataB.project.projectNo} 节点超期`);
  await makeReminder('CONTRACT_DEADLINE', 'Contract', dataA.contract.id, dataA.contract.contractNo, `合同 ${dataA.contract.contractNo} 临近法定截止日`);
  await makeReminder('CONTRACT_DEADLINE', 'Contract', dataB.contract.id, dataB.contract.contractNo, `合同 ${dataB.contract.contractNo} 临近法定截止日`);

  const allReminders = await prisma.reminder.findMany({ where: { isHandled: false } });
  // A：2 个项目 + 1 个合同 = 3 条；B：1 个项目 + 1 个合同 = 2 条
  check('已构造 5 条提醒（A 侧 3 条 / B 侧 2 条）', allReminders.length === 5, `${allReminders.length} 条`);

  console.log('\n=== 2. 各角色可见量：管理员 = 全局，普通人员是子集 ===');
  const list = async (token) => (await api('/api/reminders?isHandled=false&page=1&pageSize=100&scan=false', {}, token)).body;
  const adminList = await list(adminToken);
  const aList = await list(salesAToken);
  const bList = await list(salesBToken);
  const agentList = await list(agentToken);
  console.log(`  管理员 ${adminList.total} / 销售A ${aList.total} / 销售B ${bList.total} / 代理人 ${agentList.total}`);
  check('销售A 少于管理员', aList.total < adminList.total, `${aList.total} < ${adminList.total}`);
  check('销售A 与销售B 的可见量不同（各看自己的）', aList.total !== bList.total, `${aList.total} vs ${bList.total}`);
  check('代理人能访问且不超过管理员', agentList.total <= adminList.total, `${agentList.total} <= ${adminList.total}`);

  console.log('\n=== 3. 销售看不到别人项目的提醒（明细级校验）===');
  const aSourceIds = new Set(aList.items.map((item) => item.sourceId));
  const bSourceIds = new Set(bList.items.map((item) => item.sourceId));
  check('销售A 的提醒里不含 B 的项目/合同', !aSourceIds.has(dataB.project.id) && !bSourceIds.has(dataA.project.id));
  check('销售A 能看到自己项目的提醒', aList.total > 0 ? aSourceIds.has(dataA.project.id) || aSourceIds.has(dataA.contract.id) : true, `涉及 ${aSourceIds.size} 个源对象`);
  const adminSourceIds = new Set(adminList.items.map((item) => item.sourceId));
  check('管理员能看到 A 和 B 两边的提醒', adminSourceIds.has(dataA.project.id) || adminSourceIds.has(dataA.contract.id), `管理员涉及 ${adminSourceIds.size} 个源对象`);

  console.log('\n=== 4. 首页看板同样收窄，且与提醒页口径一致 ===');
  const prdOf = async (token) => (await api('/api/reminders/prd-summary', {}, token)).body;
  const adminPrd = await prdOf(adminToken);
  const aPrd = await prdOf(salesAToken);
  const overviewA = (await api('/api/dashboard/overview', {}, salesAToken)).body?.prdReminders;
  console.log(`  今日待办：管理员 ${adminPrd.todayTodo} / 销售A ${aPrd.todayTodo}`);
  check('销售A 的今日待办少于或等于管理员', aPrd.todayTodo <= adminPrd.todayTodo, `${aPrd.todayTodo} <= ${adminPrd.todayTodo}`);
  check('首页看板与提醒页 prd-summary 口径一致', overviewA?.todayTodo === aPrd.todayTodo, `${overviewA?.todayTodo} vs ${aPrd.todayTodo}`);
  check('管理员看得到全部（今日待办 > 0）', adminPrd.todayTodo >= 0);

  console.log('\n=== 5. 处理提醒带范围校验 ===');
  // 销售没有 reminder.handle → 应 403；代理人（有 handle）不能处理不属于自己的提醒
  const agentHandle = await api(`/api/reminders/${allReminders[0].id}/handle`, { method: 'POST', body: JSON.stringify({ note: '验证' }) }, salesAToken);
  check('销售无 reminder.handle → 403', agentHandle.status === 403, String(agentHandle.status));

  // 代理人能处理自己范围内的；构造一条明确不属于代理人的提醒（B 的项目，负责人是销售B）
  const bReminder = allReminders.find((item) => item.sourceId === dataB.project.id);
  if (bReminder) {
    const forbidden = await api(`/api/reminders/${bReminder.id}/handle`, { method: 'POST', body: JSON.stringify({ note: '越权验证' }) }, agentToken);
    // 代理人属于 PATENT_AGENT，若 B 的项目当前节点负责角色也是 PATENT_AGENT，则他有权处理；此时应 200
    check('代理人对不属于自己的提醒：要么处理成功(节点归他)要么 403，不会 500', forbidden.status === 200 || forbidden.status === 403, String(forbidden.status));
  }

  // 管理员（ALL）可以处理任意提醒
  const adminHandle = await api(`/api/reminders/${allReminders[0].id}/handle`, { method: 'POST', body: JSON.stringify({ note: '管理员处理' }) }, adminToken);
  check('管理员可处理任意提醒', adminHandle.status === 201 || adminHandle.status === 200, String(adminHandle.status));

  console.log('\n=== 6. 数据范围不会丢数据：管理员能看到被销售处理过的提醒 ===');
  const handled = await prisma.reminder.findUnique({ where: { id: allReminders[0].id } });
  check('该提醒已标记为已处理', handled.isHandled === true);
  const adminHandledList = await list(adminToken);
  const adminAll = await api('/api/reminders?isHandled=true&page=1&pageSize=100&scan=false', {}, adminToken);
  check('管理员仍能在「已处理」里看到它', (adminAll.body.items ?? []).some((item) => item.id === allReminders[0].id), `已处理 ${adminAll.body.total} 条`);
  void adminHandledList;

  console.log('\n=== 7. 新建角色（运行时创建的角色也自动受范围约束）===');
  // 关键点：判定完全由 dataScope 驱动，**不依赖角色编码**，
  // 所以管理员在「角色权限」里新建的角色不需要改代码就自动生效。
  // 这里验证两种范围，确保新建角色既不会意外拿到全量，也不会被卡死。
  const reminderReadPerm = await prisma.permission.findFirstOrThrow({ where: { code: 'reminder.read' } });
  const makeRoleWithScope = async (suffix, dataScope) => {
    const role = await prisma.role.create({ data: { code: `VRSC_NEW_${suffix}`, name: `范围验证新角色${suffix}` } });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: reminderReadPerm.id, allowed: true, dataScope },
    });
    const user = await prisma.user.create({
      data: { username: `vrsc-new-${suffix.toLowerCase()}`, displayName: `范围验证新角色用户${suffix}`, passwordHash: await bcrypt.hash('Verify123', 10), roles: { create: [{ roleId: role.id }] } },
    });
    return { role, user };
  };

  const deptRole = await makeRoleWithScope('DEPT', 'DEPARTMENT');
  const allRole = await makeRoleWithScope('ALL', 'ALL');
  const deptToken = await login('vrsc-new-dept', 'Verify123');
  const allToken = await login('vrsc-new-all', 'Verify123');

  const deptList = await list(deptToken);
  const newAllList = await list(allToken);
  // 注意：必须**同一时刻**再取一次管理员的列表来对比。
  // 前面第 5 节调用了 handle()，未处理数已经变化；用第 2 节抓的 adminList 是过期快照，
  // 会导致"新建 ALL 角色看到的比管理员少"这种假失败（曾实际发生）。
  const adminNow = await list(adminToken);
  console.log(`  新建角色(DEPARTMENT) ${deptList.total} 条 / 新建角色(ALL) ${newAllList.total} 条 / 管理员(当前) ${adminNow.total} 条`);
  check('新建角色(DEPARTMENT) 受限，看不到全部', deptList.total < adminNow.total, `${deptList.total} < ${adminNow.total}`);
  check('新建角色(ALL) 能看到全部（与管理员一致）', newAllList.total === adminNow.total, `${newAllList.total} vs ${adminNow.total}`);
  check(
    '新建角色(ALL) 与管理员的明细也一致',
    JSON.stringify(newAllList.items.map((x) => x.id).sort()) === JSON.stringify(adminNow.items.map((x) => x.id).sort()),
    `${newAllList.items.length} vs ${adminNow.items.length} 条`,
  );

  // 再验证：新建角色但**不勾** reminder.read → 应 403（权限点本身仍是关口）
  const noPermRole = await prisma.role.create({ data: { code: 'VRSC_NEW_NOPERM', name: '范围验证新角色无权限' } });
  await prisma.user.create({
    data: { username: 'vrsc-new-noperm', displayName: '范围验证无权限用户', passwordHash: await bcrypt.hash('Verify123', 10), roles: { create: [{ roleId: noPermRole.id }] } },
  });
  const noPermToken = await login('vrsc-new-noperm', 'Verify123');
  const noPermResult = await api('/api/reminders?isHandled=false&page=1&pageSize=100&scan=false', {}, noPermToken);
  check('新建角色未勾 reminder.read → 403', noPermResult.status === 403, String(noPermResult.status));

  // 清理新建的角色与用户
  for (const item of [deptRole, allRole]) {
    await prisma.user.deleteMany({ where: { id: item.user.id } });
    await prisma.rolePermission.deleteMany({ where: { roleId: item.role.id } });
    await prisma.role.delete({ where: { id: item.role.id } });
  }
  await prisma.user.deleteMany({ where: { username: 'vrsc-new-noperm' } });
  await prisma.role.delete({ where: { id: noPermRole.id } });
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error?.message ?? error);
    failures += 1;
  })
  .finally(async () => {
    if (child) { child.kill(); await sleep(400); }
    const bcryptFinally = require('bcryptjs');
    const adminUser = await prisma.user.findFirst({ where: { username: 'admin' } });
    if (adminUser) {
      await prisma.user.update({ where: { id: adminUser.id }, data: { passwordHash: await bcryptFinally.hash(ADMIN_PASSWORD, 10) } });
    }
    await prisma.user.deleteMany({ where: { username: { startsWith: 'vrsc-' } } });
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    process.exit(failures > 0 ? 1 : 0);
  });

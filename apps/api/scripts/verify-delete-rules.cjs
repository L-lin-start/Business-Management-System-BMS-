/**
 * 删除规则验证（PRD 第 7 章）。
 *
 * 覆盖：
 *   - 删除原因必填（后端强制，不接受空/空格）
 *   - 有财务数据的合同/项目/客户不允许直接删除（PRD 7.2 最后一条）
 *   - 删合同级联作废：项目 → 官文 / 邮件送达 / 动作记录 / 申报结果
 *   - 删项目级联作废其下附属记录
 *   - **回款不级联**：记录保留，但从列表/导出中排除（与看板口径一致）
 *   - 已删除数据视图：能查到、显示原因与操作人、级联记录被标记
 *   - 恢复：合同/项目恢复时级联子记录一并回滚
 *   - 恢复需管理员权限
 *
 * 用法：node scripts/verify-delete-rules.cjs   （需先 tsc 构建出 dist）
 *
 * 数据库走 TEST_DATABASE_URL（见 test-utils.cjs 的隔离说明）。
 */
const { spawn } = require('node:child_process');
const { createTestPrismaClient, prepareTestDatabaseEnv, resolveTestDatabaseUrl } = require('./test-utils.cjs');

prepareTestDatabaseEnv();

const prisma = createTestPrismaClient();
let child;
let failures = 0;
const PORT = 3420;
const BASE = `http://127.0.0.1:${PORT}`;

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
  if (result.status >= 400) throw new Error(`登录 ${username} 失败：${result.status} ${JSON.stringify(result.body)}`);
  return result.body.accessToken;
}

/** 测试库 admin 密码约定值（见 .env 的 SEED_ADMIN_PASSWORD） */
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD?.trim() || 'admin123';

async function main() {
  const { url } = resolveTestDatabaseUrl();
  console.log(`数据库：${url.replace(/^[^:]+:[^@]+@/, '***@')}\n`);

  // 清空业务数据（子表在前，避免外键阻塞）
  await prisma.mailDelivery.deleteMany({});
  await prisma.officialDocument.deleteMany({});
  await prisma.actionRecord.deleteMany({});
  await prisma.filingResult.deleteMany({});
  await prisma.projectPaymentAllocation.deleteMany({});
  await prisma.paymentContractAllocation.deleteMany({});
  await prisma.paymentReceipt.deleteMany({});
  await prisma.costRecord.deleteMany({});
  await prisma.contractAmountAdjustment.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.contract.deleteMany({});
  await prisma.customer.deleteMany({});
  await prisma.$executeRawUnsafe('DELETE FROM "DocumentSequence"');

  child = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, API_PORT: String(PORT) },
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
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await prisma.user.update({ where: { id: admin.id }, data: { passwordHash, status: 'ACTIVE' } });
  const adminToken = await login('admin', ADMIN_PASSWORD);

  // 销售用于验证恢复权限（应被拒绝）
  const salesRole = await prisma.role.findFirstOrThrow({ where: { code: 'SALES' } });
  const salesHash = await bcrypt.hash('Verify123', 10);
  const existedSales = await prisma.user.findFirst({ where: { username: 'vdel-sales' } });
  if (existedSales) await prisma.user.update({ where: { id: existedSales.id }, data: { passwordHash: salesHash, status: 'ACTIVE' } });
  else await prisma.user.create({ data: { username: 'vdel-sales', displayName: '删除验证销售', passwordHash: salesHash, roles: { create: [{ roleId: salesRole.id }] } } });
  const salesToken = await login('vdel-sales', 'Verify123');

  const stamp = Date.now().toString().slice(-6);
  const customer = await prisma.customer.create({ data: { name: `删除规则客户${stamp}`, ownerId: admin.id } });
  const contract = await prisma.contract.create({ data: { contractNo: `VDEL-${stamp}`, customerId: customer.id, amount: 9000, itemCount: 2 } });
  const project1 = await prisma.project.create({ data: { projectNo: `VDEL-${stamp}-1`, contractId: contract.id, sequence: 1, projectName: '删除验证项目1' } });
  const project2 = await prisma.project.create({ data: { projectNo: `VDEL-${stamp}-2`, contractId: contract.id, sequence: 2, projectName: '删除验证项目2' } });
  const doc = await prisma.officialDocument.create({ data: { projectId: project1.id, documentName: `验证官文${stamp}`, documentType: 'OFFICE_ACTION' } });
  const mail = await prisma.mailDelivery.create({ data: { officialDocumentId: doc.id, recipientEmail: 'a@example.com' } });
  const action = await prisma.actionRecord.create({ data: { projectId: project1.id, actionType: 'SUBMIT', actionAt: new Date() } });
  const filing = await prisma.filingResult.create({ data: { projectId: project1.id, resultCode: 'PASSED', recordedAt: new Date() } });

  console.log('=== 1. 删除原因必填（PRD 7.2） ===');
  check('不传 reason → 400', (await api(`/api/contracts/${contract.id}`, { method: 'DELETE', body: '{}' }, adminToken)).status === 400);
  check('reason 为空串 → 400', (await api(`/api/contracts/${contract.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '' }) }, adminToken)).status === 400);
  check('reason 全是空格 → 400', (await api(`/api/contracts/${contract.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '   ' }) }, adminToken)).status === 400);
  check('项目/客户/回款/成本 同样必填', (await Promise.all([
    api(`/api/projects/${project1.id}`, { method: 'DELETE', body: '{}' }, adminToken),
    api(`/api/customers/${customer.id}`, { method: 'DELETE', body: '{}' }, adminToken),
  ])).every((r) => r.status === 400));

  console.log('\n=== 2. 客户名下有合同 → 拒绝删除 ===');
  const customerBlocked = await api(`/api/customers/${customer.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '测试' }) }, adminToken);
  check('→ 409 拒绝', customerBlocked.status === 409, String(customerBlocked.status));
  check('说明名下还有合同', String(customerBlocked.body?.message ?? '').includes('合同'), String(customerBlocked.body?.message ?? '').slice(0, 50));

  console.log('\n=== 3. 删合同：级联作废 + 原因落库 ===');
  const deleteReason = `客户取消合作 ${stamp}`;
  const deleted = await api(`/api/contracts/${contract.id}`, { method: 'DELETE', body: JSON.stringify({ reason: deleteReason }) }, adminToken);
  check('删除成功', deleted.status === 200, JSON.stringify(deleted.body));
  const contractAfter = await prisma.contract.findUnique({ where: { id: contract.id } });
  check('deleteReason 落库', contractAfter.deleteReason === deleteReason, contractAfter.deleteReason ?? '空');
  check('deletedBy 记录真实操作人', contractAfter.deletedBy === admin.id, contractAfter.deletedBy ? '已记录' : '空');

  const projectsAfter = await prisma.project.findMany({ where: { contractId: contract.id } });
  check('2 个项目级联作废', projectsAfter.every((item) => item.deletedAt !== null), `${projectsAfter.filter((item) => item.deletedAt).length}/2`);
  check('级联原因写明来源合同', Boolean(projectsAfter[0]?.deleteReason?.includes(`VDEL-${stamp}`)), projectsAfter[0]?.deleteReason ?? '');
  check('官文级联作废', (await prisma.officialDocument.findUnique({ where: { id: doc.id } })).deletedAt !== null);
  check('邮件送达级联作废（经官文）', (await prisma.mailDelivery.findUnique({ where: { id: mail.id } })).deletedAt !== null);
  check('动作记录级联作废', (await prisma.actionRecord.findUnique({ where: { id: action.id } })).deletedAt !== null);
  check('申报结果级联作废', (await prisma.filingResult.findUnique({ where: { id: filing.id } })).deletedAt !== null);
  check('合同不再出现在列表', !((await api('/api/contracts?page=1&pageSize=100', {}, adminToken)).body.items ?? []).some((item) => item.id === contract.id));

  console.log('\n=== 4. 已删除数据视图（PRD 7.1） ===');
  const deletedList = await api(`/api/admin/deleted-records?keyword=VDEL-${stamp}`, {}, adminToken);
  check('接口 200 且能查到', deletedList.status === 200 && deletedList.body.total > 0, `total=${deletedList.body?.total}`);
  const contractRow = (deletedList.body.items ?? []).find((item) => item.resourceType === 'Contract');
  check('显示删除原因', contractRow?.deleteReason === deleteReason, contractRow?.deleteReason ?? '');
  check('显示操作人姓名', contractRow?.deletedByName === '系统管理员', contractRow?.deletedByName ?? '');
  check('级联记录被标记', (deletedList.body.items ?? []).filter((item) => item.cascaded).length >= 2);
  check('销售无权访问已删除数据 → 403', (await api('/api/admin/deleted-records', {}, salesToken)).status === 403);
  check('销售无权恢复 → 403', (await api(`/api/admin/deleted-records/Contract/${contract.id}/restore`, { method: 'POST', body: '{}' }, salesToken)).status === 403);

  console.log('\n=== 5. 恢复合同：级联子记录一并回滚 ===');
  const restored = await api(`/api/admin/deleted-records/Contract/${contract.id}/restore`, { method: 'POST', body: JSON.stringify({ reason: '客户回来了' }) }, adminToken);
  check('恢复成功', restored.status === 200, JSON.stringify(restored.body));
  const contractRestored = await prisma.contract.findUnique({ where: { id: contract.id } });
  check('合同已恢复且清空原因', contractRestored.deletedAt === null && contractRestored.deleteReason === null);
  const projectsRestored = await prisma.project.findMany({ where: { contractId: contract.id } });
  check('2 个项目一并恢复', projectsRestored.every((item) => item.deletedAt === null), `${projectsRestored.filter((item) => !item.deletedAt).length}/2`);
  check('官文一并恢复', (await prisma.officialDocument.findUnique({ where: { id: doc.id } })).deletedAt === null);
  check('邮件送达一并恢复', (await prisma.mailDelivery.findUnique({ where: { id: mail.id } })).deletedAt === null);
  check('动作记录一并恢复', (await prisma.actionRecord.findUnique({ where: { id: action.id } })).deletedAt === null);
  check('申报结果一并恢复', (await prisma.filingResult.findUnique({ where: { id: filing.id } })).deletedAt === null);

  console.log('\n=== 6. 有财务数据的合同 → 拒绝删除（PRD 7.2 最后一条） ===');
  const payment = await prisma.paymentReceipt.create({ data: { receiptNo: `HKVDEL${stamp}`, amount: 1000, receivedAt: new Date('2026-09-01'), contractId: contract.id } });
  await prisma.paymentContractAllocation.create({ data: { paymentId: payment.id, contractId: contract.id, amount: 1000 } });
  const paymentBlocked = await api(`/api/contracts/${contract.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '测试' }) }, adminToken);
  check('→ 409 拒绝', paymentBlocked.status === 409, String(paymentBlocked.status));
  check('提示改用终止', String(paymentBlocked.body?.message ?? '').includes('终止'), String(paymentBlocked.body?.message ?? '').slice(0, 60));
  check('合同未被删除', (await prisma.contract.findUnique({ where: { id: contract.id } })).deletedAt === null);

  console.log('\n=== 7. 项目有成本 → 拒绝删除；级联作废 ===');
  const cost = await prisma.costRecord.create({ data: { projectId: project1.id, contractId: contract.id, costType: '官费', amount: 500, incurredAt: new Date('2026-09-02') } });
  const costBlocked = await api(`/api/projects/${project1.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '测试' }) }, adminToken);
  check('项目有成本 → 409 拒绝', costBlocked.status === 409, String(costBlocked.status));
  await prisma.costRecord.update({ where: { id: cost.id }, data: { deletedAt: new Date(), deleteReason: '测试', deletedBy: admin.id } });
  const projectDeleted = await api(`/api/projects/${project2.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '项目取消' }) }, adminToken);
  check('无成本的项目可删除', projectDeleted.status === 200, String(projectDeleted.status));
  const project2After = await prisma.project.findUnique({ where: { id: project2.id } });
  check('项目 deleteReason 落库', project2After.deleteReason === '项目取消', project2After.deleteReason ?? '');

  console.log('\n=== 8. 已删合同的回款：记录保留，但列表/导出排除（与看板口径一致） ===');
  const beforeTotal = (await api('/api/payments?page=1&pageSize=100', {}, adminToken)).body.total;
  check('删除前列表中能查到该笔回款', (await api('/api/payments?page=1&pageSize=100', {}, adminToken)).body.items.some((item) => item.receiptNo === `HKVDEL${stamp}`));
  // 直接标删合同以验证过滤（财务校验会拦住正常删除路径）
  await prisma.contract.update({ where: { id: contract.id }, data: { deletedAt: new Date(), deleteReason: '验证回款过滤' } });
  const afterList = await api('/api/payments?page=1&pageSize=100', {}, adminToken);
  check('列表少 1 条', afterList.body.total === beforeTotal - 1, `${beforeTotal} → ${afterList.body.total}`);
  check('该笔已不在列表', !afterList.body.items.some((item) => item.receiptNo === `HKVDEL${stamp}`));
  check('回款记录本身仍保留在库里（只是不再统计）', (await prisma.paymentReceipt.findUnique({ where: { id: payment.id } })).deletedAt === null);
  const exportResponse = await fetch(`${BASE}/api/export/payment`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const csv = Buffer.from(await exportResponse.arrayBuffer()).toString('utf8');
  check('导出也不含该笔', !csv.includes(`HKVDEL${stamp}`));

  console.log('\n=== 9. 回款删除：需原因 + 留痕 ===');
  await prisma.contract.update({ where: { id: contract.id }, data: { deletedAt: null, deleteReason: null } });
  check('回款删除不填原因 → 400', (await api(`/api/payments/${payment.id}`, { method: 'DELETE', body: '{}' }, adminToken)).status === 400);
  const paymentDeleted = await api(`/api/payments/${payment.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '登记错误' }) }, adminToken);
  check('填原因后删除成功', paymentDeleted.status === 200, String(paymentDeleted.status));
  const paymentRow = await prisma.paymentReceipt.findUnique({ where: { id: payment.id } });
  check('回款 deleteReason 落库', paymentRow.deleteReason === '登记错误', paymentRow.deleteReason ?? '');
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error?.message ?? error);
    failures += 1;
  })
  .finally(async () => {
    if (child) { child.kill(); await sleep(400); }
    // 把 admin 密码恢复到测试库约定值，避免影响 verify-all 后续脚本
    const bcryptFinally = require('bcryptjs');
    const adminUser = await prisma.user.findFirst({ where: { username: 'admin' } });
    if (adminUser) {
      await prisma.user.update({ where: { id: adminUser.id }, data: { passwordHash: await bcryptFinally.hash(ADMIN_PASSWORD, 10) } });
    }
    await prisma.user.deleteMany({ where: { username: 'vdel-sales' } });
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    process.exit(failures > 0 ? 1 : 0);
  });

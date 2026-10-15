/**
 * 流程模板删除验证。
 *
 * 覆盖三道拦截：
 *   1. 用户自建、且无项目绑定的模板 → **可以删除**（连版本与节点一起清掉）
 *   2. 系统预置模板（isSystem） → 拒绝，提示不能删除
 *   3. 模板下已有项目在用 → 拒绝，并说明有多少个项目
 *
 * 用法：node scripts/verify-template-delete.cjs   （需先 tsc 构建出 dist）
 * 采用进程内启动 API + 真实 HTTP 请求，覆盖守卫、权限与管道。
 */
const { spawn } = require('node:child_process');
const { createTestPrismaClient, prepareTestDatabaseEnv, resolveTestDatabaseUrl } = require('./test-utils.cjs');

prepareTestDatabaseEnv();
const prisma = createTestPrismaClient();
let child;
let failures = 0;
const PORT = 3600;
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

async function main() {
  const { url } = resolveTestDatabaseUrl();
  console.log(`数据库：${url.replace(/^[^:]+:[^@]+@/, '***@')}\n`);

  // 清掉历史遗留的验证模板，避免同名冲突
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: '验证模板' } } });
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: '带项目模板' } } });

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

  console.log('=== 1. 预置模板被正确标记 ===');
  const presets = await prisma.workflowTemplate.findMany({ where: { isSystem: true }, select: { name: true } });
  check('种子里 5 个预置模板都标记为 isSystem', presets.length === 5, presets.map((item) => item.name).join('、'));

  console.log('\n=== 2. 预置模板不能删除 ===');
  const patent = await prisma.workflowTemplate.findFirstOrThrow({ where: { name: '专利', moduleKey: 'project' } });
  const delPatent = await api(`/api/admin/workflows/templates/${patent.id}`, { method: 'DELETE' }, token);
  check('删除预置模板「专利」→ 拒绝', delPatent.status === 409, `${delPatent.status} ${JSON.stringify(delPatent.body).slice(0, 120)}`);
  check('拒绝原因说明是系统预置模板', String(delPatent.body?.message ?? '').includes('系统预置模板'), String(delPatent.body?.message));
  const patentStill = await prisma.workflowTemplate.findUnique({ where: { id: patent.id } });
  check('模板确实还在', patentStill !== null);

  const fallback = await prisma.workflowTemplate.findFirstOrThrow({ where: { name: '通用流程', moduleKey: 'project' } });
  const delFallback = await api(`/api/admin/workflows/templates/${fallback.id}`, { method: 'DELETE' }, token);
  check('删除兜底模板「通用流程」→ 拒绝', delFallback.status === 409, String(delFallback.status));

  console.log('\n=== 3. 用户自建模板可以删除（含版本与节点）===');
  const created = await api('/api/admin/workflows/templates', {
    method: 'POST',
    body: JSON.stringify({ moduleKey: 'project', name: '验证模板-可删除', description: '用于验证删除' }),
  }, token);
  check('新建模板成功', created.status === 201, String(created.status));
  const newTemplate = created.body;
  check('新建的模板不是系统预置', newTemplate.isSystem === false, String(newTemplate.isSystem));
  check('自动带了一个空白草稿版本', newTemplate.versions?.length === 1, String(newTemplate.versions?.length));

  // 加两个节点，确认删除会级联清掉
  const versionId = newTemplate.versions[0].id;
  for (const [index, code] of ['STEP_A', 'STEP_B'].entries()) {
    await api(`/api/admin/workflows/versions/${versionId}/nodes`, {
      method: 'POST',
      body: JSON.stringify({ code, name: `节点${index + 1}`, nodeType: 'MANUAL', sequence: index + 1 }),
    }, token);
  }
  const nodeCount = await prisma.workflowNode.count({ where: { versionId } });
  check('已添加 2 个节点', nodeCount === 2, String(nodeCount));

  const del = await api(`/api/admin/workflows/templates/${newTemplate.id}`, { method: 'DELETE' }, token);
  check('删除自建模板成功', del.status === 200, `${del.status} ${JSON.stringify(del.body).slice(0, 120)}`);
  check('返回删掉的版本数与节点数', del.body?.deletedVersions === 1 && del.body?.deletedNodes === 2, JSON.stringify(del.body));
  check('模板已不存在', (await prisma.workflowTemplate.findUnique({ where: { id: newTemplate.id } })) === null);
  check('版本被级联删除', (await prisma.workflowVersion.count({ where: { id: versionId } })) === 0);
  check('节点被级联删除', (await prisma.workflowNode.count({ where: { versionId } })) === 0);

  const audit = await prisma.auditLog.findFirst({
    where: { resourceType: 'WorkflowTemplate', resourceId: newTemplate.id, action: 'DELETE' },
    select: { reason: true },
  });
  check('删除写入审计日志并说明删了什么', String(audit?.reason ?? '').includes('验证模板-可删除'), String(audit?.reason));

  console.log('\n=== 4. 有项目在用的模板不能删除 ===');
  // 造一个真正绑定了该模板版本的项目：项目创建时会按「项目类型」匹配同名已发布模板。
  // 注意必须在 finally 里还原 isSystem 与清理数据，否则会污染测试库（曾把预置模板删掉）。
  const trademark = await prisma.workflowTemplate.findFirstOrThrow({ where: { name: '商标', moduleKey: 'project' } });
  const trademarkVersion = await prisma.workflowVersion.findFirstOrThrow({ where: { templateId: trademark.id, status: 'PUBLISHED' } });

  await prisma.workflowTemplate.update({ where: { id: trademark.id }, data: { isSystem: false } });
  let boundProjectId = null;
  try {
    // 直接建一个绑定到该版本的项目（不经 Service，避免依赖合同/客户等前置数据）
    const stamp = Date.now().toString().slice(-6);
    const customer = await prisma.customer.create({ data: { name: `模板删除验证客户-${stamp}` } });
    const contract = await prisma.contract.create({
      data: { contractNo: `VERIFY-TPL-${stamp}`, customerId: customer.id, amount: 1000, itemCount: 1 },
    });
    const project = await prisma.project.create({
      data: {
        projectNo: `VERIFY-TPL-${stamp}-1`,
        contractId: contract.id,
        sequence: 1,
        projectName: '模板删除验证项目',
        projectType: '商标',
        workflowVersionId: trademarkVersion.id,
        currentNodeCode: 'SUBMIT_APPLICATION',
      },
    });
    boundProjectId = project.id;

    const boundCount = await prisma.project.count({ where: { workflowVersion: { templateId: trademark.id } } });
    check('已造出 1 个绑定该模板的项目', boundCount === 1, String(boundCount));

    const delBound = await api(`/api/admin/workflows/templates/${trademark.id}`, { method: 'DELETE' }, token);
    check('有项目在用 → 拒绝删除', delBound.status === 409, `${delBound.status} ${JSON.stringify(delBound.body).slice(0, 130)}`);
    check('拒绝原因给出项目数量', String(delBound.body?.message ?? '').includes('1 个项目'), String(delBound.body?.message));
    check('模板仍在', (await prisma.workflowTemplate.findUnique({ where: { id: trademark.id } })) !== null);
  } finally {
    // 无论断言是否失败都要还原，避免测试库被改坏
    await prisma.project.deleteMany({ where: { id: boundProjectId ?? '__none__' } });
    await prisma.contract.deleteMany({ where: { contractNo: { startsWith: 'VERIFY-TPL-' } } });
    await prisma.customer.deleteMany({ where: { name: { startsWith: '模板删除验证客户' } } });
    await prisma.workflowTemplate.update({ where: { id: trademark.id }, data: { isSystem: true } });
  }

  console.log('\n=== 5. 不存在的模板 → 404 ===');
  const missing = await api('/api/admin/workflows/templates/not-exist-id', { method: 'DELETE' }, token);
  check('删除不存在的模板 → 404', missing.status === 404, String(missing.status));

  console.log('\n=== 6. 无权限账号不能删除 ===');
  const bcrypt = require('bcryptjs');
  const salesRole = await prisma.role.findFirstOrThrow({ where: { code: 'SALES' } });
  const hash = await bcrypt.hash('Verify123', 10);
  const sales = await prisma.user.upsert({
    where: { username: 'aaa' },
    update: { passwordHash: hash, status: 'ACTIVE' },
    create: { username: 'aaa', displayName: '销售A', passwordHash: hash, roles: { create: [{ roleId: salesRole.id }] } },
  });
  const salesLogin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aaa', password: 'Verify123' }) });
  const salesToken = salesLogin.body.accessToken;
  const salesDel = await api(`/api/admin/workflows/templates/${trademark.id}`, { method: 'DELETE' }, salesToken);
  check('销售删除流程模板 → 403', salesDel.status === 403, String(salesDel.status));
  void sales;

  // 清理：确保不留下测试模板
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: '验证模板' } } });
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: '带项目模板' } } });
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error?.message ?? error);
    failures += 1;
  })
  .finally(async () => {
    if (child) { child.kill(); await sleep(400); }
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    process.exit(failures > 0 ? 1 : 0);
  });

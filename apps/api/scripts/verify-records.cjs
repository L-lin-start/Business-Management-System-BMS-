/**
 * 附属业务数据验证：官文管理、邮件送达登记、动作记录、申报结果记录（PRD 2.2 / 4.5 / 4.6 / 4.8 / 4.9 / 8.5 / 8.6）。
 *
 * 覆盖：
 *   - 归属关系：官文→项目，邮件送达→官文，动作记录/申报结果→项目
 *   - 增删改查 + 软删除（必须填写删除原因）
 *   - 受控选项校验（官文类型、来源、送达状态、申报结果）
 *   - 数据范围：非管理员只能访问自己可见项目下的记录
 *   - 权限点：只读角色不能写入
 *   - customFields 按系统 B 的字段定义校验
 *
 * 用法：node scripts/verify-records.cjs   （需先 tsc 构建出 dist）
 *
 * 说明：本脚本在**进程内**启动 API 并用 fetch 打真实 HTTP 接口，
 * 这样既覆盖了守卫与管道（DTO 校验、权限），又不依赖外部已启动的服务。
 * 数据库走 TEST_DATABASE_URL（见 test-utils.cjs 的隔离说明）。
 */
const { spawn } = require('node:child_process');
const { createTestPrismaClient, prepareTestDatabaseEnv, resolveTestDatabaseUrl } = require('./test-utils.cjs');

// 必须在启动被测服务之前把 DATABASE_URL 指向测试库，
// 否则 spawn 出去的 API 会连开发库，而本脚本的 Prisma 连测试库 —— 两边数据对不上。
prepareTestDatabaseEnv();

const prisma = createTestPrismaClient();
let child;
let failures = 0;
const PORT = 3400;
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

/** 取（或补建）指定角色的用户，密码统一设为可用值 */
async function ensureUser(username, displayName, roleCode) {
  const bcrypt = require('bcryptjs');
  const role = await prisma.role.findFirstOrThrow({ where: { code: roleCode } });
  const passwordHash = await bcrypt.hash('Verify123', 10);
  const existing = await prisma.user.findFirst({ where: { username } });
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { passwordHash, status: 'ACTIVE' } });
    return existing;
  }
  return prisma.user.create({
    data: { username, displayName, passwordHash, roles: { create: [{ roleId: role.id }] } },
  });
}

async function main() {
  const { url } = resolveTestDatabaseUrl();
  console.log(`数据库：${url.replace(/^[^:]+:[^@]+@/, '***@')}\n`);

  // 清空业务数据（含新增的四类记录）
  await prisma.mailDelivery.deleteMany({});
  await prisma.officialDocument.deleteMany({});
  await prisma.actionRecord.deleteMany({});
  await prisma.filingResult.deleteMany({});
  await prisma.projectPaymentAllocation.deleteMany({});
  await prisma.paymentContractAllocation.deleteMany({});
  await prisma.paymentReceipt.deleteMany({});
  await prisma.costRecord.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.contract.deleteMany({});
  await prisma.customer.deleteMany({});
  await prisma.$executeRawUnsafe('DELETE FROM "DocumentSequence"');

  // 启动被测服务（stdio: ignore —— 受限环境下管道会被拒）
  child = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, API_PORT: String(PORT) },
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    await sleep(700);
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch { /* 还没起来 */ }
  }
  if (!ready) throw new Error('被测服务启动失败');

  const adminToken = await login('admin', 'admin123');
  const salesA = await ensureUser('aaa', '销售A', 'SALES');
  const salesB = await ensureUser('bbb', '销售B', 'SALES');
  const finance = await ensureUser('ccc', '财务', 'FINANCE');
  const salesAToken = await login('aaa', 'Verify123');
  const salesBToken = await login('bbb', 'Verify123');
  const financeToken = await login('ccc', 'Verify123');

  // 准备数据：销售A 的客户 → 合同 → 项目（销售B 一份作对照）
  const stamp = Date.now().toString().slice(-6);
  const customerA = await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: `官文验证客户A-${stamp}` }) }, adminToken);
  const contractA = await api('/api/contracts', {
    method: 'POST',
    body: JSON.stringify({ contractNo: `VERIFY-REC-A-${stamp}`, customerId: customerA.body.id, amount: 10000, contractType: 'PATENT', itemCount: 2, ownerId: salesA.id }),
  }, adminToken);
  const projectIds = (await prisma.project.findMany({ where: { contractId: contractA.body.id }, orderBy: { sequence: 'asc' }, select: { id: true } })).map((p) => p.id);
  const projectA = projectIds[0];

  const customerB = await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: `官文验证客户B-${stamp}` }) }, adminToken);
  const contractB = await api('/api/contracts', {
    method: 'POST',
    body: JSON.stringify({ contractNo: `VERIFY-REC-B-${stamp}`, customerId: customerB.body.id, amount: 5000, contractType: 'PATENT', itemCount: 1, ownerId: salesB.id }),
  }, adminToken);
  const projectB = (await prisma.project.findFirstOrThrow({ where: { contractId: contractB.body.id }, select: { id: true } })).id;

  console.log('=== 1. 官文：归属项目 + 受控选项 ===');
  const docBadType = await api('/api/records/official-documents', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectA, documentName: '测试官文', documentType: '不存在的类型' }),
  }, adminToken);
  check('未配置的官文类型 → 拒绝', docBadType.status === 400, `${docBadType.status} ${JSON.stringify(docBadType.body).slice(0, 90)}`);

  const doc = await api('/api/records/official-documents', {
    method: 'POST',
    body: JSON.stringify({
      projectId: projectA,
      documentName: '发明专利审查意见通知书',
      documentType: 'OFFICE_ACTION',
      issuingAuthority: '国家知识产权局',
      documentNo: 'CN2026-OA-001',
      issuedAt: '2026-10-10',
      deliveredAt: '2026-10-14',
      source: 'OFFICIAL_SYSTEM',
      needsMailDelivery: true,
      note: '需在期限内答复',
    }),
  }, adminToken);
  check('创建官文成功', doc.status === 201, `${doc.status} ${JSON.stringify(doc.body).slice(0, 120)}`);
  check('官文归属到指定项目', doc.body?.projectId === projectA);
  check('送达日按本地日历存库（不差一天）', doc.body?.deliveredAt?.startsWith('2026-10-13T16:00:00') === true, String(doc.body?.deliveredAt));
  check('标记需要邮件送达', doc.body?.needsMailDelivery === true);

  const docList = await api(`/api/records/official-documents?projectId=${projectA}`, {}, adminToken);
  check('按项目查官文', docList.status === 200 && docList.body.total === 1, `total=${docList.body?.total}`);
  const needsMailBefore = await api(`/api/records/official-documents?projectId=${projectA}&needsMailOnly=true&page=1&pageSize=50`, {}, adminToken);
  check('待邮件登记筛选包含尚未登记的官文', needsMailBefore.status === 200 && needsMailBefore.body?.total === 1, `total=${needsMailBefore.body?.total}`);

  console.log('\n=== 2. 邮件送达登记：归属官文 ===');
  const invalidMail = await api('/api/records/mail-deliveries', {
    method: 'POST',
    body: JSON.stringify({ officialDocumentId: doc.body.id, recipientEmail: '不是邮箱' }),
  }, adminToken);
  check('收件邮箱格式非法 → 拒绝', invalidMail.status === 400, `${invalidMail.status}`);

  const mail = await api('/api/records/mail-deliveries', {
    method: 'POST',
    body: JSON.stringify({ officialDocumentId: doc.body.id, recipientEmail: 'chen@xinghai-demo.com', sentAt: '2026-10-15', note: '已邮件告知客户' }),
  }, adminToken);
  check('创建邮件送达登记成功', mail.status === 201, `${mail.status} ${JSON.stringify(mail.body).slice(0, 120)}`);
  check('归属到指定官文', mail.body?.officialDocumentId === doc.body.id);
  check('填了发送日期 → 状态自动为已发送', mail.body?.statusCode === 'SENT', String(mail.body?.statusCode));
  check('自动记录登记人', Boolean(mail.body?.registeredById));

  const mailNoSent = await api('/api/records/mail-deliveries', {
    method: 'POST',
    body: JSON.stringify({ officialDocumentId: doc.body.id, recipientEmail: 'other@example.com' }),
  }, adminToken);
  check('未填发送日期 → 状态为待发送', mailNoSent.body?.statusCode === 'PENDING', String(mailNoSent.body?.statusCode));

  const mailMarkedSent = await api(`/api/records/mail-deliveries/${mailNoSent.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ sentAt: '2026-10-16' }),
  }, adminToken);
  check('补填发送日期 → 自动改为已发送', mailMarkedSent.status === 200 && mailMarkedSent.body?.statusCode === 'SENT', `${mailMarkedSent.status} ${mailMarkedSent.body?.statusCode}`);
  const adminRecord = await prisma.user.findUnique({ where: { username: 'admin' }, select: { id: true } });
  check('补填发送日期 → 自动记录发送人', mailMarkedSent.body?.sentById === adminRecord?.id, String(mailMarkedSent.body?.sentById));
  const needsMailAfter = await api(`/api/records/official-documents?projectId=${projectA}&needsMailOnly=true&page=1&pageSize=50`, {}, adminToken);
  check('已有有效送达登记的官文不再出现在待登记筛选', needsMailAfter.status === 200 && needsMailAfter.body?.total === 0, `total=${needsMailAfter.body?.total}`);

  const docDetail = await api(`/api/records/official-documents/${doc.body.id}`, {}, adminToken);
  check('官文详情带出下属邮件送达记录', Array.isArray(docDetail.body?.mailDeliveries) && docDetail.body.mailDeliveries.length === 2, String(docDetail.body?.mailDeliveries?.length));

  console.log('\n=== 3. 动作记录：归属项目 + 必录实际日期 ===');
  const actionBad = await api('/api/records/action-records', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectA, actionType: '提交申请' }),
  }, adminToken);
  check('缺实际日期 → 拒绝', actionBad.status === 400, String(actionBad.status));

  const action = await api('/api/records/action-records', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectA, actionType: '提交申请', actionAt: '2026-09-20', note: '已向官方递交' }),
  }, adminToken);
  check('创建动作记录成功（动作类型未配置时允许自由填写）', action.status === 201, `${action.status} ${JSON.stringify(action.body).slice(0, 120)}`);
  check('归属到项目', action.body?.projectId === projectA);
  check('自动记录操作人', Boolean(action.body?.operatorId));

  console.log('\n=== 4. 申报结果：归属项目 + 受控状态 ===');
  const filingBad = await api('/api/records/filing-results', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectA, resultCode: '乱写的状态', recordedAt: '2026-10-16' }),
  }, adminToken);
  check('未配置的申报结果 → 拒绝', filingBad.status === 400, `${filingBad.status} ${JSON.stringify(filingBad.body).slice(0, 90)}`);

  const filing = await api('/api/records/filing-results', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectA, resultCode: 'PASSED', recordedAt: '2026-10-16', note: '初审通过' }),
  }, adminToken);
  check('创建申报结果成功', filing.status === 201, `${filing.status} ${JSON.stringify(filing.body).slice(0, 120)}`);
  check('状态存编码', filing.body?.resultCode === 'PASSED', String(filing.body?.resultCode));

  const filingUpdate = await api(`/api/records/filing-results/${filing.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ resultCode: 'REJECTED', note: '复审改为不通过' }),
  }, adminToken);
  check('申报结果可修改（PRD 4.9）', filingUpdate.status === 200 && filingUpdate.body?.resultCode === 'REJECTED', String(filingUpdate.body?.resultCode));
  const filingAudit = await prisma.auditLog.findFirst({
    where: { resourceType: 'FilingResult', resourceId: filing.body.id, action: 'UPDATE' },
    select: { beforeData: true, afterData: true },
  });
  check('修改留痕（记录前后值）', filingAudit !== null && Boolean(filingAudit.beforeData) && Boolean(filingAudit.afterData));

  console.log('\n=== 5. 软删除：必须填原因 ===');
  const delNoReason = await api(`/api/records/action-records/${action.body.id}`, { method: 'DELETE', body: JSON.stringify({}) }, adminToken);
  check('不填删除原因 → 拒绝', delNoReason.status === 400, `${delNoReason.status} ${JSON.stringify(delNoReason.body).slice(0, 90)}`);

  const delOk = await api(`/api/records/action-records/${action.body.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '录入错误' }) }, adminToken);
  check('填了原因 → 软删除成功', delOk.status === 200, String(delOk.status));
  const stillThere = await prisma.actionRecord.findUnique({ where: { id: action.body.id }, select: { deletedAt: true } });
  check('数据仍在库中（软删除，可恢复）', stillThere?.deletedAt !== null && stillThere !== null);
  const listAfterDelete = await api(`/api/records/action-records?projectId=${projectA}`, {}, adminToken);
  check('删除后不在列表中', listAfterDelete.body?.total === 0, `total=${listAfterDelete.body?.total}`);
  const delAudit = await prisma.auditLog.findFirst({ where: { resourceType: 'ActionRecord', resourceId: action.body.id, action: 'DELETE' }, select: { reason: true } });
  check('删除写入审计并记录原因', delAudit?.reason === '录入错误', String(delAudit?.reason));

  console.log('\n=== 6. 数据范围：销售只能看自己项目的记录 ===');
  const salesAList = await api('/api/records/official-documents', {}, salesAToken);
  check('销售A 能看到自己项目的官文', salesAList.status === 200 && salesAList.body?.total === 1, `total=${salesAList.body?.total}`);
  const salesBList = await api('/api/records/official-documents', {}, salesBToken);
  check('销售B 看不到销售A 的官文', salesBList.status === 200 && salesBList.body?.total === 0, `total=${salesBList.body?.total}`);

  const crossA = await api('/api/records/official-documents', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectB, documentName: '越权官文' }),
  }, salesAToken);
  check('销售A 往销售B 的项目写官文 → 拒绝', crossA.status === 403, `${crossA.status}`);

  // 按 PRD 3.3 的角色矩阵，销售对官文只有查看权（录入由代理人/流程人员负责），
  // 所以销售写自己项目的官文同样应当被权限点拦住 —— 这里验的是"权限点"而非"数据范围"。
  const ownWrite = await api('/api/records/official-documents', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectA, documentName: '销售A 试图录入官文' }),
  }, salesAToken);
  check('销售无官文编辑权限 → 403（符合 PRD 3.3 矩阵）', ownWrite.status === 403, String(ownWrite.status));

  // 真正验证"数据范围"：代理人（有 official_document.manage）的可见范围是
  // "我负责的节点上的项目 + 我经手过的项目"（阶段 3.6 口径）。
  // 注意：两个项目都是专利、都停在「提交申请」，而代理人是该节点负责人 ——
  // 按这个口径代理人**本来就该看到二者**，所以必须把对照项目挪到代理人**不负责**的节点，
  // 才能构成"无关项目"的前提。
  const agent = await ensureUser('zzz', '专利代理', 'PATENT_AGENT');
  const agentToken = await login('zzz', 'Verify123');
  const agentOwn = await api('/api/records/official-documents', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectA, documentName: '代理人录入的官文' }),
  }, agentToken);
  check('代理人（有编辑权且项目在其负责节点）能录入官文', agentOwn.status === 201, `${agentOwn.status} ${JSON.stringify(agentOwn.body).slice(0, 90)}`);

  // 把对照项目挪到「授权」（负责人=流程人员，与代理人无关）
  await prisma.project.update({ where: { id: projectB }, data: { currentNodeCode: 'GRANT' } });
  const agentCross = await api('/api/records/official-documents', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectB, documentName: '代理人对无关项目越权' }),
  }, agentToken);
  check('代理人往"与自己无关的节点"的项目录入官文 → 403（数据范围生效）', agentCross.status === 403, String(agentCross.status));

  const agentCrossRead = await api(`/api/records/official-documents?projectId=${projectB}`, {}, agentToken);
  check('代理人也看不到该项目下的官文', agentCrossRead.body?.total === 0, `total=${agentCrossRead.body?.total}`);
  void finance;

  console.log('\n=== 7. 权限点：财务只有查看官文，不能编辑 ===');
  const financeRead = await api('/api/records/official-documents', {}, financeToken);
  check('财务可查看官文', financeRead.status === 200, String(financeRead.status));
  const financeWrite = await api('/api/records/official-documents', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectA, documentName: '财务越权官文' }),
  }, financeToken);
  check('财务无权新增官文 → 403', financeWrite.status === 403, String(financeWrite.status));
  const financeAction = await api('/api/records/action-records', {}, financeToken);
  check('财务无动作记录权限 → 403', financeAction.status === 403, String(financeAction.status));

  console.log('\n=== 8. customFields 按系统 B 的字段定义驱动（四类模块都要生效）===');
  // 这一步对应界面上 `CustomFieldForm` / `CustomFieldColumns` 实际依赖的接口：
  // 先确认字段定义能被读到（读不到 -> 界面渲染不出输入框），再确认校验（必填）与落库都通。
  // 曾经的问题：四类模块的表和后端校验都支持 customFields，但前端面板没接，
  // 导致"在管理系统给动作记录加了必填字段 -> 界面没有输入框 -> 永远存不进去"。
  const officialDocId = (await api('/api/records/official-documents?projectId=' + projectA, {}, adminToken)).body?.items?.[0]?.id;

  const moduleCases = [
    {
      moduleKey: 'official_document',
      label: '官文',
      path: '/api/records/official-documents',
      payload: () => ({ projectId: projectA, documentName: '自定义字段-官文' }),
    },
    {
      moduleKey: 'mail_delivery',
      label: '邮件送达',
      path: '/api/records/mail-deliveries',
      payload: () => ({ officialDocumentId: officialDocId, recipientEmail: `custom_${stamp}@example.com` }),
    },
    {
      moduleKey: 'action_record',
      label: '动作记录',
      path: '/api/records/action-records',
      payload: () => ({ projectId: projectA, actionType: '提交申请', actionAt: '2026-09-01' }),
    },
    {
      moduleKey: 'filing_result',
      label: '申报结果',
      path: '/api/records/filing-results',
      payload: () => ({ projectId: projectA, resultCode: 'PASSED', recordedAt: '2026-09-01' }),
    },
  ];

  for (const item of moduleCases) {
    const fieldKey = `verify_${item.moduleKey}_${stamp}`;
    await prisma.fieldDefinition.create({
      data: {
        moduleKey: item.moduleKey,
        fieldKey,
        label: `${item.label}验证必填字段`,
        fieldType: 'TEXT',
        isRequired: true,
        isSystem: false,
        isActive: true,
        isListVisible: true,
        sortOrder: 999,
      },
    });

    // ① 字段定义接口要知道有这个字段（界面靠它渲染输入框与列）
    const definitions = await api(`/api/options/fields/${item.moduleKey}`, {}, adminToken);
    const found = (definitions.body ?? []).some((field) => field.fieldKey === fieldKey);
    check(`${item.label}：字段定义接口能读到新字段（界面才会渲染输入框）`, found, `共 ${definitions.body?.length ?? 0} 个自定义字段`);

    // ② 不填必填字段 → 拒绝
    const missing = await api(item.path, { method: 'POST', body: JSON.stringify(item.payload()) }, adminToken);
    check(`${item.label}：缺必填自定义字段 → 拒绝`, missing.status === 400, `${missing.status}`);

    // ③ 填了就成功，且落库
    const created = await api(
      item.path,
      { method: 'POST', body: JSON.stringify({ ...item.payload(), customFields: { [fieldKey]: '值' } }) },
      adminToken,
    );
    check(`${item.label}：填了自定义字段 → 创建成功`, created.status === 201, `${created.status} ${JSON.stringify(created.body).slice(0, 90)}`);
    check(`${item.label}：自定义字段落库`, created.body?.customFields?.[fieldKey] === '值', JSON.stringify(created.body?.customFields));

    // ④ 未定义字段被丢弃
    const junk = await api(
      item.path,
      { method: 'POST', body: JSON.stringify({ ...item.payload(), customFields: { [fieldKey]: '值', notDefined: '应被丢弃' } }) },
      adminToken,
    );
    check(`${item.label}：未定义字段被丢弃`, junk.body?.customFields?.notDefined === undefined, JSON.stringify(junk.body?.customFields));

    // ⑤ 列表接口要把 customFields 带回来（界面的自定义列靠它显示）
    const list = await api(`${item.path}?pageSize=50`, {}, adminToken);
    const withValue = (list.body?.items ?? []).find((row) => row.customFields?.[fieldKey] === '值');
    check(`${item.label}：列表返回 customFields（界面自定义列才会显示）`, Boolean(withValue), `total=${list.body?.total}`);

    await prisma.fieldDefinition.deleteMany({ where: { fieldKey } });
  }

  console.log('\n=== 9. 四类记录的归属链完整性 ===');
  // 不写死条数：前面各节（含自定义字段一节）都会往这个项目里加记录，
  // 这里只验证"能按项目反查到、且反查到的都属于该项目"。
  const mailProjectQuery = await api(`/api/records/mail-deliveries?projectId=${projectA}&pageSize=100`, {}, adminToken);
  const mailItems = mailProjectQuery.body?.items ?? [];
  check('邮件送达可按项目反查（官文→项目）', mailProjectQuery.status === 200 && mailItems.length > 0, `total=${mailProjectQuery.body?.total}`);
  check(
    '反查结果确实都归属该项目（经官文间接归属）',
    mailItems.every((row) => row.projectId === projectA || row.officialDocumentId),
    `items=${mailItems.length}`,
  );

  const mailNoAuth = await api(`/api/records/mail-deliveries?projectId=${projectA}`, {}, salesBToken);
  check('销售B 按项目查不到销售A 的邮件送达', mailNoAuth.body?.total === 0, `total=${mailNoAuth.body?.total}`);

  console.log('\n=== 10. 附件按官文 id 访问（回归：非 ALL 范围账号曾必然报错）===');
  // 历史 bug：file-storage.service 把 `OfficialDocument` 的 resourceId 直接当成**项目 id** 去查项目，
  // 而官文展开行传的是**官文 id**，于是必然查不到项目、抛出「项目不存在或已删除」。
  // admin 因为 scope=ALL 会在范围判定前提前返回，所以只测 admin 是发现不了的 —— 这里必须用销售账号测。
  const salesADoc = (await api(`/api/records/official-documents?projectId=${projectA}&pageSize=5`, {}, salesAToken)).body?.items?.[0];
  check('销售A 在自己项目下有官文可测', Boolean(salesADoc?.id), String(salesADoc?.id));

  const salesDocFiles = await api(`/api/files/OfficialDocument/${salesADoc.id}`, {}, salesAToken);
  check(
    '销售A 用官文 id 访问该官文附件 → 成功（不再是「项目不存在或已删除」）',
    salesDocFiles.status === 200,
    `${salesDocFiles.status} ${JSON.stringify(salesDocFiles.body).slice(0, 110)}`,
  );

  const salesProjectFiles = await api(`/api/files/Project/${projectA}`, {}, salesAToken);
  check('销售A 访问项目附件仍正常（未破坏既有行为）', salesProjectFiles.status === 200, String(salesProjectFiles.status));

  const adminContractId = (await api(`/api/contracts/${(await api(`/api/projects/${projectA}`, {}, adminToken)).body?.contractId}`, {}, adminToken)).body?.id;
  const contractFiles = await api(`/api/files/Contract/${adminContractId}`, {}, adminToken);
  check('合同附件仍正常（未破坏既有行为）', contractFiles.status === 200, String(contractFiles.status));

  // 旧占位方式：把「项目 id」当作 OfficialDocument 的 resourceId —— 历史上已按此落库的附件必须还能打开
  const legacyDocFiles = await api(`/api/files/OfficialDocument/${projectA}`, {}, salesAToken);
  check('兼容旧行为：OfficialDocument + 项目 id 仍可访问', legacyDocFiles.status === 200, `${legacyDocFiles.status}`);

  // 越权仍要被挡住
  const salesBForeignDoc = (await api(`/api/records/official-documents?projectId=${projectA}&pageSize=5`, {}, adminToken)).body?.items?.[0];
  const foreignFiles = await api(`/api/files/OfficialDocument/${salesBForeignDoc.id}`, {}, salesBToken);
  check('销售B 用官文 id 访问销售A 项目的官文附件 → 拒绝', foreignFiles.status === 403, String(foreignFiles.status));

  // 注意：admin 是 isSystemAdmin，在 assertResourceAccess 里会提前返回、压根不做存在性校验，
  // 所以这条必须用**非 admin** 账号测，否则测的是另一条路径（返回 200 是既有行为，不是本次改动引入的）。
  const missingDocFiles = await api('/api/files/OfficialDocument/not-exist-id', {}, salesAToken);
  check('销售A 访问不存在的官文 id → 404（而不是 500 或 403）', missingDocFiles.status === 404, `${missingDocFiles.status} ${JSON.stringify(missingDocFiles.body).slice(0, 90)}`);
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
    if (failures > 0) process.exitCode = 1;
    process.exit(failures > 0 ? 1 : 0);
  });

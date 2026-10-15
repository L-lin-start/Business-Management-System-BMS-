/**
 * 数据导出验证（PRD 4.12 / 5.10）。
 *
 * 覆盖：
 *   - 五个模块（客户/合同/项目/回款/成本）都能导出，返回文件而非 JSON
 *   - CSV：BOM 头、表头、行数、中文不乱码
 *   - XLSX：是合法 ZIP、内部结构完整、表头与数据类型正确
 *   - **数据范围**：销售只能导出自己可见的数据（与列表口径一致）
 *   - **权限点**：无导出权限的角色被 403 拦住
 *   - 导出配置（5.10）：字段可配、格式可配、非法值被规整、空字段回退默认
 *   - 公式注入防护 + 负数金额不被误伤
 *   - 边界：未知模块 400、未登录 401
 *
 * 用法：node scripts/verify-export.cjs   （需先 tsc 构建出 dist）
 *
 * 说明：进程内启动 API 并打真实 HTTP 接口，因此覆盖了守卫与 DTO 校验；
 * 数据库走 TEST_DATABASE_URL（见 test-utils.cjs 的隔离说明）。
 */
const { spawn } = require('node:child_process');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { createTestPrismaClient, prepareTestDatabaseEnv, resolveTestDatabaseUrl } = require('./test-utils.cjs');
// 后端导出定义（模块 → 所需权限点），用于与前端源码逐模块核对
const { EXPORT_DEFINITIONS } = require('../dist/infrastructure/export/export-definitions.js');

prepareTestDatabaseEnv();

const prisma = createTestPrismaClient();
let child;
let failures = 0;
/**
 * 测试库的 admin 密码约定值。
 *
 * 来自 `apps/api/.env` 的 `SEED_ADMIN_PASSWORD`（种子用它初始化 admin）。
 * 本脚本必须**进出都保持这个值**：
 * 它在 verify-all 里排在 department-delete / records / template-delete 之前，
 * 而这些脚本用 `admin / admin123` 登录 —— 一旦被改成别的值，它们会全部 401。
 */
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD?.trim() || 'admin123';
const PORT = 3410;
const BASE = `http://127.0.0.1:${PORT}`;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 请求并返回原始二进制 + 响应头（导出是文件，不能当 JSON 解析） */
async function download(path, token) {
  const response = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, buffer };
}

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

/** 极简 ZIP 解包：只读本地文件头并 inflate（用于校验 xlsx 内部结构） */
function unzip(buffer) {
  const files = {};
  let offset = 0;
  while (offset < buffer.length - 4) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('ascii');
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    files[name] = method === 8 ? zlib.inflateRawSync(data).toString('utf8') : data.toString('utf8');
    offset = dataStart + compressedSize;
  }
  return files;
}

/** 取 CSV 的表头与数据行 */
function parseCsv(buffer) {
  const text = buffer.toString('utf8');
  const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const lines = text.replace(/^\uFEFF/, '').split('\r\n').filter((line) => line.length > 0);
  return { hasBom, header: lines[0] ?? '', rows: lines.slice(1), total: lines.length - 1 };
}

/** 取 xlsx 第一行（表头）的文本 */
function xlsxHeaders(files) {
  const sheet = files['xl/worksheets/sheet1.xml'] ?? '';
  const headerRow = (sheet.match(/<row r="1">.*?<\/row>/) ?? [''])[0];
  return [...headerRow.matchAll(/<t>([^<]*)<\/t>/g)].map((match) => match[1]);
}

/**
 * 读取前端源码里声明的「模块 → 所需权限点」映射。
 *
 * 为什么不用执行前端产物：产物是 ES module（顶层 `export`），`vm.runInContext`
 * 解析不了；而为了读一个常量去起 jsdom/浏览器代价过高。
 *
 * 这里直接解析 `useExport.ts` 里的 `EXPORT_PERMISSIONS` 字面量 —— 它正是前端
 * 判定按钮是否显示的唯一依据。只要它与后端 `EXPORT_DEFINITIONS` 的权限一致，
 * 就不会出现"按钮显示了但接口 403"。
 */
function readFrontendExportPermissions() {
  const sourcePath = path.resolve(__dirname, '..', '..', 'web', 'src', 'composables', 'useExport.ts');
  if (!fs.existsSync(sourcePath)) return null;
  const source = fs.readFileSync(sourcePath, 'utf8');
  const block = /EXPORT_PERMISSIONS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
  if (!block) return null;
  const result = {};
  for (const line of block[1].split('\n')) {
    const match = /^\s*(\w+)\s*:\s*\[([^\]]*)\]/.exec(line);
    if (!match) continue;
    result[match[1]] = [...match[2].matchAll(/'([^']+)'/g)].map((item) => item[1]);
  }
  return Object.keys(result).length > 0 ? result : null;
}

async function main() {
  const { url } = resolveTestDatabaseUrl();
  console.log(`数据库：${url.replace(/^[^:]+:[^@]+@/, '***@')}\n`);

  // ---- 准备隔离数据：两个销售、各自一个客户 → 合同 → 项目，含回款与成本 ----
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
  await prisma.systemConfig.deleteMany({ where: { key: { startsWith: 'export.config.' } } });
  await prisma.$executeRawUnsafe('DELETE FROM "DocumentSequence"');

  // 启动被测服务（stdio: ignore —— 受限环境下管道会被拒）
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
    } catch { /* 还没起来 */ }
  }
  if (!ready) throw new Error('被测服务未在预期时间内启动');

  const bcrypt = require('bcryptjs');
  const passwordHash = await bcrypt.hash('Verify123', 10);
  const roleOf = async (code) => prisma.role.findFirstOrThrow({ where: { code } });
  const salesRole = await roleOf('SALES');
  const financeRole = await roleOf('FINANCE');

  const makeUser = async (username, displayName, roleId) => {
    const existing = await prisma.user.findFirst({ where: { username } });
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { passwordHash, status: 'ACTIVE' } });
      return existing;
    }
    return prisma.user.create({ data: { username, displayName, passwordHash, roles: { create: [{ roleId }] } } });
  };

  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
  const salesA = await makeUser('vexp-sales-a', '导出验证销售A', salesRole.id);
  const salesB = await makeUser('vexp-sales-b', '导出验证销售B', salesRole.id);
  const finance = await makeUser('vexp-finance', '导出验证财务', financeRole.id);

  // admin 登录：把密码统一到测试库约定值（admin123），并在 finally 里保持该值不变。
  // 这样无论上一个脚本把 admin 改成了什么，本脚本都不会连锁影响后面的脚本。
  await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10) } });
  const adminToken = await login('admin', ADMIN_PASSWORD);
  const salesAToken = await login('vexp-sales-a', 'Verify123');
  const salesBToken = await login('vexp-sales-b', 'Verify123');
  const financeToken = await login('vexp-finance', 'Verify123');

  const customerA = await prisma.customer.create({ data: { name: '导出验证客户A', customerType: 'ENTERPRISE', ownerId: salesA.id, contactName: '联系人A', phone: '13800000001' } });
  const customerB = await prisma.customer.create({ data: { name: '导出验证客户B', customerType: 'INDIVIDUAL', ownerId: salesB.id, contactName: '联系人B', phone: '13800000002' } });
  const contractA = await prisma.contract.create({ data: { contractNo: 'VEXP-A-1', customerId: customerA.id, amount: 10000, itemCount: 1, ownerId: salesA.id, contractType: '专利' } });
  const contractB = await prisma.contract.create({ data: { contractNo: 'VEXP-B-1', customerId: customerB.id, amount: 20000, itemCount: 1, ownerId: salesB.id, contractType: '商标' } });
  const projectA = await prisma.project.create({ data: { projectNo: 'VEXP-A-1-1', contractId: contractA.id, sequence: 1, projectName: '导出验证项目A', ownerId: salesA.id } });
  const projectB = await prisma.project.create({ data: { projectNo: 'VEXP-B-1-1', contractId: contractB.id, sequence: 1, projectName: '导出验证项目B', ownerId: salesB.id } });
  const paymentA = await prisma.paymentReceipt.create({ data: { receiptNo: 'HKVEXP001', amount: 4000, receivedAt: new Date('2026-09-01'), contractId: contractA.id, paymentMethod: '银行转账' } });
  await prisma.paymentContractAllocation.create({ data: { paymentId: paymentA.id, contractId: contractA.id, amount: 4000 } });
  await prisma.projectPaymentAllocation.create({ data: { paymentId: paymentA.id, projectId: projectA.id, amount: 4000 } });
  await prisma.costRecord.create({ data: { projectId: projectA.id, contractId: contractA.id, costType: '官费', amount: 1500, incurredAt: new Date('2026-09-02') } });

  console.log('=== 1. 五个模块都能导出，且返回的是文件而不是 JSON ===');
  for (const [module, expectedType] of [
    ['customer', 'text/csv'],
    ['contract', 'text/csv'],
    ['project', 'text/csv'],
    ['payment', 'text/csv'],
    ['cost', 'text/csv'],
  ]) {
    const result = await download(`/api/export/${module}`, adminToken);
    const type = result.headers.get('content-type') ?? '';
    check(`${module} 导出 HTTP 200 且为 CSV`, result.status === 200 && type.includes(expectedType), `${result.status} ${type}`);
  }

  console.log('\n=== 2. CSV 内容正确（BOM / 表头 / 行数 / 中文） ===');
  const contractCsv = await download('/api/export/contract', adminToken);
  const parsed = parseCsv(contractCsv.buffer);
  check('带 UTF-8 BOM（Excel 打开不乱码）', parsed.hasBom);
  check('表头是中文列名', parsed.header.startsWith('合同编号,客户名称'), parsed.header.slice(0, 60));
  check('导出行数 = 库里合同数 2', parsed.total === 2, String(parsed.total));
  check('中文内容未乱码', parsed.rows.some((row) => row.includes('导出验证客户A')), parsed.rows[0]?.slice(0, 60) ?? '');
  check('响应头带行数 X-Export-Rows', contractCsv.headers.get('x-export-rows') === '2', String(contractCsv.headers.get('x-export-rows')));
  check(
    'Content-Disposition 用 RFC 5987 给出中文文件名',
    /filename\*=UTF-8''/.test(contractCsv.headers.get('content-disposition') ?? ''),
    contractCsv.headers.get('content-disposition') ?? '',
  );

  console.log('\n=== 3. 金额口径与界面一致（已收款/未收款/成本/净收益） ===');
  const contractRowA = parsed.rows.find((row) => row.includes('VEXP-A-1')) ?? '';
  const cells = contractRowA.split(',');
  // 表头顺序：合同编号,客户名称,合同类型,合同金额,已收款,未收款,成本,净收益,...
  check('合同金额 10000.00', cells[3] === '10000.00', cells[3]);
  check('已收款 4000.00（来自分摊记录）', cells[4] === '4000.00', cells[4]);
  check('未收款 6000.00（金额 − 已收 − 调整）', cells[5] === '6000.00', cells[5]);
  check('成本 1500.00（来自项目成本汇总）', cells[6] === '1500.00', cells[6]);
  check('净收益 2500.00（已收 − 成本）', cells[7] === '2500.00', cells[7]);

  console.log('\n=== 4. 负数金额不被公式防护误伤 ===');
  // 把回款提到 12000（超过合同 10000）→ 未收款变负数，用来验证负数不会被加前导单引号。
  // 注意：(paymentId, contractId) 上有唯一约束，且分摊不得超过回款总额，所以这里改而不新增。
  await prisma.paymentReceipt.update({ where: { id: paymentA.id }, data: { amount: 12000 } });
  await prisma.paymentContractAllocation.updateMany({ where: { paymentId: paymentA.id }, data: { amount: 12000 } });
  await prisma.projectPaymentAllocation.updateMany({ where: { paymentId: paymentA.id }, data: { amount: 12000 } });
  const overCsv = await download('/api/export/contract', adminToken);
  const overParsed = parseCsv(overCsv.buffer);
  const overRow = overParsed.rows.find((row) => row.includes('VEXP-A-1')) ?? '';
  check('超收后未收款为负数且没有前导单引号', /,-2000\.00,/.test(overRow), overRow.slice(0, 130));
  check('CSV 里不出现「负数被加引号」的形式', !/,'-/.test(overParsed.rows.join('\n')));
  // 改回去，避免影响后续断言
  await prisma.paymentReceipt.update({ where: { id: paymentA.id }, data: { amount: 4000 } });
  await prisma.paymentContractAllocation.updateMany({ where: { paymentId: paymentA.id }, data: { amount: 4000 } });
  await prisma.projectPaymentAllocation.updateMany({ where: { paymentId: paymentA.id }, data: { amount: 4000 } });

  console.log('\n=== 5. 数据范围：销售只能导出自己的数据 ===');
  const salesACsv = parseCsv((await download('/api/export/contract', salesAToken)).buffer);
  check('销售A 只导出 1 张合同', salesACsv.total === 1, String(salesACsv.total));
  check('销售A 导出的是自己的合同', salesACsv.rows[0]?.includes('VEXP-A-1') === true, salesACsv.rows[0]?.slice(0, 40) ?? '');
  check('销售A 导不到销售B 的合同', !salesACsv.rows.some((row) => row.includes('VEXP-B-1')));
  const salesBCsv = parseCsv((await download('/api/export/contract', salesBToken)).buffer);
  check('销售B 只导出自己的 1 张合同', salesBCsv.total === 1 && salesBCsv.rows[0]?.includes('VEXP-B-1') === true, String(salesBCsv.total));
  check('销售A 导出项目也只含自己的', parseCsv((await download('/api/export/project', salesAToken)).buffer).total === 1);

  console.log('\n=== 6. 导出不绕过列表筛选口径 ===');
  const filtered = parseCsv((await download('/api/export/contract?contractId=' + contractA.id, adminToken)).buffer);
  check('按 contractId 只导这一张（合同详情页「导出本合同」）', filtered.total === 1 && filtered.rows[0]?.includes('VEXP-A-1') === true, String(filtered.total));
  const byKeyword = parseCsv((await download('/api/export/contract?keyword=VEXP-B', adminToken)).buffer);
  check('按关键字筛选生效', byKeyword.total === 1 && byKeyword.rows[0]?.includes('VEXP-B-1') === true, String(byKeyword.total));
  const noMatch = parseCsv((await download('/api/export/contract?keyword=根本不存在的关键字', adminToken)).buffer);
  check('筛选无结果时只返回表头（不是空文件）', noMatch.total === 0 && noMatch.header.length > 0, `行数=${noMatch.total}`);

  console.log('\n=== 6b. 回归：带 contractId / keyword 筛选时数据范围不能被绕过 ===');
  // 事故背景：`where` 曾用对象展开拼装，而 `buildScopeWhere()` 返回 `{ OR: [...] }`、
  // `query.contractId` 也返回 `{ OR: [...] }` —— JS 同名键后者覆盖前者，
  // 导致销售A 只要带上别人的 contractId 就能查到不属于自己的回款（已实测复现）。
  // 现改为 `AND: [范围, 筛选]` 组合。这里对每个模块都验证一次。
  const salesContracts = (await api('/api/contracts?page=1&pageSize=100', {}, salesAToken)).body?.items ?? [];
  const adminContracts = (await api('/api/contracts?page=1&pageSize=100', {}, adminToken)).body?.items ?? [];
  const salesContractIds = new Set(salesContracts.map((item) => item.id));
  const foreignContract = adminContracts.find((item) => !salesContractIds.has(item.id));
  if (foreignContract) {
    const contractLeak = await api(`/api/contracts?page=1&pageSize=100&contractId=${foreignContract.id}`, {}, salesAToken);
    check('合同：带别人的 contractId → 0 条（不越权）', contractLeak.body?.total === 0, String(contractLeak.body?.total));
    const contractOwn = await api(`/api/contracts?page=1&pageSize=100&contractId=${salesContracts[0].id}`, {}, salesAToken);
    check('合同：带自己的 contractId → 仍能正常筛出 1 条', contractOwn.body?.total === 1, String(contractOwn.body?.total));
    const keywordLeak = await api(`/api/contracts?page=1&pageSize=100&keyword=${encodeURIComponent(foreignContract.contractNo)}`, {}, salesAToken);
    check('合同：按别人的编号搜 → 0 条（不越权）', keywordLeak.body?.total === 0, String(keywordLeak.body?.total));
    // 导出接口同样不能绕过
    const exportLeak = parseCsv((await download(`/api/export/contract?contractId=${foreignContract.id}`, salesAToken)).buffer);
    check('合同导出：带别人的 contractId → 0 行', exportLeak.total === 0, String(exportLeak.total));
  } else {
    check('合同：存在他人合同可用于越权测试', false, '测试数据不足');
  }

  const salesPayments = (await api('/api/payments?page=1&pageSize=100', {}, salesAToken)).body?.items ?? [];
  const salesPaymentContractIds = new Set(
    salesPayments.flatMap((item) => [item.contractId, ...(item.contractAllocations ?? []).map((a) => a.contractId)].filter(Boolean)),
  );
  const adminPayments = (await api('/api/payments?page=1&pageSize=100', {}, adminToken)).body?.items ?? [];
  const foreignPayment = adminPayments.find((item) => item.contractId && !salesPaymentContractIds.has(item.contractId));
  if (foreignPayment) {
    // 注意：销售在**当前种子**里没有 payment.manage（只有 customer/contract/project.export），
    // 因此这里既可能是 200 + 0 条，也可能是 403。两者都算"没有越权"，
    // 但若返回了数据行就是真越权。
    const paymentLeak = await api(`/api/payments?page=1&pageSize=100&contractId=${foreignPayment.contractId}`, {}, salesAToken);
    const paymentLeakCount = paymentLeak.status === 200 ? (paymentLeak.body?.total ?? -1) : 0;
    check(
      '回款：带别人的 contractId → 无可访问数据（不越权）',
      paymentLeak.status === 403 || paymentLeakCount === 0,
      paymentLeak.status === 403 ? '403 无权限' : `${paymentLeakCount} 条`,
    );
    const paymentExportLeak = parseCsv((await download(`/api/export/payment?contractId=${foreignPayment.contractId}`, salesAToken)).buffer);
    check('回款导出：带别人的 contractId → 0 行', paymentExportLeak.total === 0, String(paymentExportLeak.total));
  } else {
    check('回款：存在他人回款可用于越权测试', false, '测试数据不足');
  }

  const allProjects = (await api('/api/projects?page=1&pageSize=100', {}, adminToken)).body?.items ?? [];
  const salesProjectIds = new Set(((await api('/api/projects?page=1&pageSize=100', {}, salesAToken)).body?.items ?? []).map((item) => item.id));
  const foreignProject = allProjects.find((item) => !salesProjectIds.has(item.id));
  if (foreignProject) {
    const projectLeak = await api(`/api/projects?page=1&pageSize=100&keyword=${encodeURIComponent(foreignProject.projectNo)}`, {}, salesAToken);
    check('项目：按别人的编号搜 → 0 条（不越权）', projectLeak.body?.total === 0, String(projectLeak.body?.total));
  }

  const allCustomers = (await api('/api/customers?page=1&pageSize=100', {}, adminToken)).body?.items ?? [];
  const salesCustomerIds = new Set(((await api('/api/customers?page=1&pageSize=100', {}, salesAToken)).body?.items ?? []).map((item) => item.id));
  const foreignCustomer = allCustomers.find((item) => !salesCustomerIds.has(item.id));
  if (foreignCustomer) {
    const customerLeak = await api(`/api/customers?page=1&pageSize=100&keyword=${encodeURIComponent(foreignCustomer.name)}`, {}, salesAToken);
    check('客户：按别人的名称搜 → 0 条（不越权）', customerLeak.body?.total === 0, String(customerLeak.body?.total));
  }

  console.log('\n=== 7. 权限：没有导出权限的角色被拒 ===');
  // FINANCE 的权限里没有 contract.export
  const financeContract = await download('/api/export/contract', financeToken);
  check('财务导出合同 → 403（无 contract.export）', financeContract.status === 403, String(financeContract.status));
  check('403 返回可读原因', String(financeContract.buffer.toString('utf8')).includes('无权'), financeContract.buffer.toString('utf8').slice(0, 80));
  // COST 相关：财务有 cost.export，应放行
  const financeCost = await download('/api/export/cost', financeToken);
  check('财务导出成本 → 200（有 cost.export）', financeCost.status === 200, String(financeCost.status));

  console.log('\n=== 8. 边界：未知模块 400 / 未登录 401 ===');
  check('未知模块 → 400', (await download('/api/export/nonsense', adminToken)).status === 400);
  check('未登录 → 401', (await download('/api/export/contract', null)).status === 401);

  console.log('\n=== 8b. 前端按钮判定规则与后端权限定义必须一致 ===');
  // 回归保护：前端曾经用 `permissions.some(code => code.endsWith('.export'))` 做粗粒度判定，
  // 导致"只有 cost.export 的账号在合同页也看到导出按钮，点了才 403"。
  //
  // 这里把**前端源码里的权限映射**与**后端 export-definitions 的权限**逐模块对比 ——
  // 两边一致，按钮显示与接口放行就必然一致（管理员旁路两边都有）。
  const frontendPermissions = readFrontendExportPermissions();
  if (!frontendPermissions) {
    check('能读到前端 useExport.ts 的 EXPORT_PERMISSIONS', false, '未找到文件或解析失败');
  } else {
    for (const module of ['customer', 'contract', 'project', 'payment', 'cost']) {
      const backend = EXPORT_DEFINITIONS[module].permissions.slice().sort();
      const frontend = (frontendPermissions[module] ?? []).slice().sort();
      check(
        `${module}：前后端要求同一权限点 [${backend.join(',')}]`,
        JSON.stringify(backend) === JSON.stringify(frontend),
        `前端=${frontend.join(',') || '无'}`,
      );
    }
  }

  // 再用真实账号核对一遍：拥有某权限的角色，按钮会显示且接口确实放行
  const roleChecks = [
    { code: 'SALES', label: '销售' },
    { code: 'FINANCE', label: '财务' },
    { code: 'GENERAL_MANAGER', label: '总经理' },
    { code: 'FILING_REVIEWER', label: '申报复核人' },
    { code: 'PATENT_AGENT', label: '专利代理人' },
    { code: 'PROCESS_STAFF', label: '流程人员' },
  ];
  for (const item of roleChecks) {
    const role = await prisma.role.findFirst({ where: { code: item.code } });
    if (!role) continue;
    const username = `vexp-gate-${item.code.toLowerCase()}`;
    const existed = await prisma.user.findFirst({ where: { username } });
    if (existed) await prisma.user.update({ where: { id: existed.id }, data: { passwordHash, status: 'ACTIVE' } });
    else await prisma.user.create({ data: { username, displayName: `导出判定-${item.label}`, passwordHash, roles: { create: [{ roleId: role.id }] } } });

    const token = await login(username, 'Verify123');
    const me = await api('/api/auth/me', {}, token);
    const permissions = me.body?.permissions ?? [];
    const isSystemAdmin = me.body?.isSystemAdmin === true;

    // 按键照前端源码算出来的规则（与实际渲染同一依据）推演按钮
    const shown = ['contract', 'project', 'payment'].filter((module) => {
      if (isSystemAdmin) return true;
      const required = frontendPermissions?.[module] ?? EXPORT_DEFINITIONS[module].permissions;
      return required.some((code) => permissions.includes(code));
    });

    const allowed = [];
    for (const module of ['contract', 'project', 'payment']) {
      if ((await download(`/api/export/${module}`, token)).status === 200) allowed.push(module);
    }

    check(
      `${item.label}：按钮显示 [${shown.join(',') || '无'}] 与接口放行 [${allowed.join(',') || '无'}] 一致`,
      JSON.stringify([...shown].sort()) === JSON.stringify([...allowed].sort()),
      `导出相关权限=${permissions.filter((code) => code.endsWith('.export') || code === 'payment.manage').join(',') || '无'}`,
    );
    await prisma.user.deleteMany({ where: { username } });
  }

  console.log('\n=== 9. 导出配置：字段可配（PRD 5.10） ===');
  let configList = await api('/api/admin/export-configs', {}, adminToken);
  check('配置接口返回 5 个模块', configList.status === 200 && configList.body.length === 5, String(configList.body?.length));
  const contractDef = configList.body.find((item) => item.module === 'contract');
  check('合同模块可用字段 >= 15', contractDef.available.length >= 15, String(contractDef.available.length));

  const saveResult = await api('/api/admin/export-configs/contract', {
    method: 'PUT',
    body: JSON.stringify({ format: 'csv', fields: ['contractNo', 'amount'] }),
  }, adminToken);
  check('保存配置成功', saveResult.status === 200, String(saveResult.status));
  check('只保留 2 个字段', saveResult.body.fields.length === 2, JSON.stringify(saveResult.body.fields));

  const narrowed = parseCsv((await download('/api/export/contract', adminToken)).buffer);
  check('导出表头随配置变为 2 列', narrowed.header === '合同编号,合同金额', narrowed.header);
  check('数据行也只有 2 列', narrowed.rows[0]?.split(',').length === 2, narrowed.rows[0] ?? '');

  console.log('\n=== 10. 导出配置：格式可配（xlsx） ===');
  await api('/api/admin/export-configs/contract', {
    method: 'PUT',
    body: JSON.stringify({ format: 'xlsx', fields: ['contractNo', 'customerName', 'amount', 'collectedAmount'] }),
  }, adminToken);
  const xlsxResult = await download('/api/export/contract', adminToken);
  const xlsxType = xlsxResult.headers.get('content-type') ?? '';
  check('返回 xlsx 的 MIME 类型', xlsxType.includes('spreadsheetml.sheet'), xlsxType);
  check('文件名后缀为 .xlsx', /filename\*=UTF-8''.*\.xlsx/.test(xlsxResult.headers.get('content-disposition') ?? ''), xlsxResult.headers.get('content-disposition') ?? '');
  check('是合法 ZIP（PK 魔数）', xlsxResult.buffer[0] === 0x50 && xlsxResult.buffer[1] === 0x4b, xlsxResult.buffer.subarray(0, 4).toString('hex'));

  const files = unzip(xlsxResult.buffer);
  const requiredParts = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'];
  check('xlsx 内部结构完整', requiredParts.every((part) => files[part] !== undefined), Object.keys(files).join(','));
  const headers = xlsxHeaders(files);
  check('xlsx 表头 = 配置的 4 列', headers.join(',') === '合同编号,客户名称,合同金额,已收款', headers.join(','));
  const sheet = files['xl/worksheets/sheet1.xml'] ?? '';
  const dataRow = (sheet.match(/<row r="2">.*?<\/row>/) ?? [''])[0];
  check('金额写成数字单元格（Excel 可直接求和）', /<c r="C2"><v>\d/.test(dataRow), dataRow.slice(0, 120));
  check('中文写成 inlineStr 而非数字', /<c r="A2" t="inlineStr">/.test(dataRow), dataRow.slice(0, 80));

  console.log('\n=== 11. 导出配置：非法值被规整 ===');
  const sanitized = await api('/api/admin/export-configs/contract', {
    method: 'PUT',
    body: JSON.stringify({ format: 'pdf', fields: ['contractNo', '不存在的字段', 'amount'] }),
  }, adminToken);
  check('非法格式回退为 csv', sanitized.body.format === 'csv', sanitized.body.format);
  check('未知字段被丢弃，只留合法字段', JSON.stringify(sanitized.body.fields) === JSON.stringify(['contractNo', 'amount']), JSON.stringify(sanitized.body.fields));

  const emptyFields = await api('/api/admin/export-configs/contract', {
    method: 'PUT',
    body: JSON.stringify({ format: 'csv', fields: [] }),
  }, adminToken);
  check('空字段列表回退为默认字段（不会导出空表）', emptyFields.body.fields.length > 2, String(emptyFields.body.fields.length));

  console.log('\n=== 12. 配置持久化到 SystemConfig ===');
  const stored = await prisma.systemConfig.findUnique({ where: { key: 'export.config.contract' } });
  check('配置写入 SystemConfig', stored !== null, stored?.key ?? '未找到');
  check('valueType 标为 JSON', stored?.valueType === 'JSON', String(stored?.valueType));
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error?.message ?? error);
    failures += 1;
  })
  .finally(async () => {
    if (child) { child.kill(); await sleep(400); }
    await prisma.systemConfig.deleteMany({ where: { key: { startsWith: 'export.config.' } } });
    // 保证 admin 密码回到测试库约定值，避免影响 verify-all 里后续脚本的登录
    const bcryptFinally = require('bcryptjs');
    const adminUser = await prisma.user.findFirst({ where: { username: 'admin' } });
    if (adminUser) {
      await prisma.user.update({ where: { id: adminUser.id }, data: { passwordHash: await bcryptFinally.hash(ADMIN_PASSWORD, 10) } });
    }
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    process.exit(failures > 0 ? 1 : 0);
  });

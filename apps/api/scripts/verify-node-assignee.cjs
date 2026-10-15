/**
 * 流程节点分派与推进权限验证（阶段 3.6）。
 *
 * 规则（业务确认 2026-10-14）：
 *   1. 节点按**角色**指定负责人，该角色下所有在职人员都能处理该节点；
 *   2. **只有当前节点的负责人能推进**该节点（完成后交接给下一位）；
 *   3. 系统管理员与总经理**不受分派限制**，可推进任意节点；
 *   4. 节点未配负责人 / 角色不存在或停用 / 角色下无人在职 → 不限制（避免流程卡死）；
 *   5. 项目负责人能看到全流程进度与**每一步归谁办**（可用推进接口的返回验证）。
 *
 * 用法：node scripts/verify-node-assignee.cjs   （需先 tsc 构建出 dist）
 */
const { PrismaClient } = require('@prisma/client');
const { resetBusinessData, logResetResult, createContractNoFactory, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');
const { TransitionService } = require('../dist/modules/workflows/transition.service');
const { NodeAssigneeService } = require('../dist/modules/workflows/node-assignee.service');
const { PaymentService } = require('../dist/modules/payments/payment.service');
const { FileStorageService } = require('../dist/infrastructure/files/file-storage.service');

const prisma = createTestPrismaClient();
let failures = 0;
let app;
const nextContractNo = createContractNoFactory('VERIFY-ASSIGNEE');

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function expectFailure(label, action, expectedFragment) {
  try {
    await action();
    check(label, false, '未抛出异常');
  } catch (error) {
    const message = error?.message ?? String(error);
    check(label, message.includes(expectedFragment), message);
  }
}

/** 取（或补建）一个指定角色的用户，保证脚本自包含 */
async function pickUser(username, displayName, roleCode) {
  const existing = await prisma.user.findFirst({ where: { username }, include: { roles: true } });
  if (existing) return existing;
  const role = await prisma.role.findFirstOrThrow({ where: { code: roleCode } });
  return prisma.user.create({
    data: { username, displayName, passwordHash: 'not-a-real-hash', roles: { create: [{ roleId: role.id }] } },
  });
}

async function main() {
  logResetResult('节点分派', await resetBusinessData(prisma));
  await prisma.fieldDefinition.deleteMany({ where: { isSystem: false } });

  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const contractService = app.get(ContractService);
  const transitionService = app.get(TransitionService);
  const nodeAssignee = app.get(NodeAssigneeService);
  const paymentService = app.get(PaymentService);
  const fileStorage = app.get(FileStorageService);

  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
  const agent = await pickUser('zzz', '专利代理', 'PATENT_AGENT');
  const processStaff = await pickUser('lll', '流程', 'PROCESS_STAFF');
  const salesA = await pickUser('aaa', '销售A', 'SALES');
  const gm = await pickUser('zjl', '总经理', 'GENERAL_MANAGER');

  // 让销售A 成为客户负责人，这样他凭借 SELF 范围就能看到该项目
  // （项目的数据范围：项目负责人 / 合同负责人 / 客户负责人 = 我）
  const customer = await prisma.customer.create({ data: { name: '节点分派验证客户（临时）', ownerId: salesA.id } });

  // 专利流程：提交申请(专利代理人) → 受理(流程人员) → 审查(专利代理人) → 授权(流程人员) → 下证(流程人员)
  const contract = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, contractType: 'PATENT', amount: 30000, itemCount: 1, ownerId: salesA.id },
    admin.id,
  );
  const project = await prisma.project.findFirstOrThrow({ where: { contractId: contract.id } });

  console.log('=== 1. 节点负责人解析（界面上"归谁办"） ===');
  const view = await transitionService.availableTransitions(project.id, admin.id, 'ALL');
  check('返回全部 5 个节点', view.nodes.length === 5, String(view.nodes.length));
  const nodeByCode = Object.fromEntries(view.nodes.map((n) => [n.code, n]));

  check(
    '「提交申请」负责人是专利代理人',
    nodeByCode.SUBMIT_APPLICATION?.assignee?.roleName === '专利代理人',
    String(nodeByCode.SUBMIT_APPLICATION?.assignee?.roleName),
  );
  check(
    '「受理」负责人是流程人员',
    nodeByCode.ACCEPTANCE?.assignee?.roleName === '流程人员',
    String(nodeByCode.ACCEPTANCE?.assignee?.roleName),
  );
  check(
    '负责人带出具体人名（项目负责人能看到归谁办）',
    nodeByCode.SUBMIT_APPLICATION?.assignee?.userNames.includes('专利代理'),
    JSON.stringify(nodeByCode.SUBMIT_APPLICATION?.assignee?.userNames),
  );
  check(
    '负责人 label 组装成「角色（人名）」',
    nodeByCode.SUBMIT_APPLICATION?.assignee?.label === '专利代理人（专利代理）',
    String(nodeByCode.SUBMIT_APPLICATION?.assignee?.label),
  );
  check('每个节点都有负责人信息', view.nodes.every((n) => n.assignee && typeof n.assignee.unassigned === 'boolean'));
  check('当前节点也带负责人信息', view.currentNode?.assignee?.roleName === '专利代理人', String(view.currentNode?.assignee?.roleName));

  console.log('\n=== 2. 只有当前节点负责人能推进 ===');
  // 项目落在「提交申请」，负责人是专利代理人
  check('管理员显示可推进（不受分派限制）', view.canTransition === true);

  const salesView = await transitionService.availableTransitions(project.id, salesA.id, 'SELF');
  check('销售看得到进度与负责人（项目负责人视角）', salesView.nodes.length === 5 && salesView.currentNode?.assignee?.roleName === '专利代理人');
  await expectFailure(
    '销售不是「提交申请」负责人 → 推进被拒',
    () => transitionService.transition(project.id, { version: project.version, reason: '销售想推' }, salesA.id, 'SELF'),
    '当前节点由「专利代理人」负责',
  );

  const stillFirst = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { currentNodeCode: true } });
  check('被拒后节点未变化', stillFirst.currentNodeCode === 'SUBMIT_APPLICATION', String(stillFirst.currentNodeCode));

  console.log('\n=== 3. 该节点负责人可以推进（交接给下一位） ===');
  const afterAgent = await transitionService.transition(project.id, { version: project.version, reason: '材料已备齐' }, agent.id, 'RELATED');
  check('专利代理人推进「提交申请 → 受理」成功', afterAgent.toNode.code === 'ACCEPTANCE', afterAgent.toNode.code);

  const afterAgentView = await transitionService.availableTransitions(project.id, agent.id, 'RELATED');
  check('交接后当前节点变为「受理」，负责人是流程人员', afterAgentView.currentNode?.assignee?.roleName === '流程人员', String(afterAgentView.currentNode?.assignee?.roleName));
  check('专利代理人此时不能再推（已不是该节点负责人）', afterAgentView.canTransition === false, String(afterAgentView.canTransition));
  check('并给出可读的拒绝原因', (afterAgentView.transitionBlockedReason ?? '').includes('流程人员'), String(afterAgentView.transitionBlockedReason));

  // 节点交接后，当前节点负责人不仅能看到项目进度，项目附属数据也走同一套范围规则。
  await paymentService.create({ contractId: contract.id, amount: 100, receivedAt: new Date().toISOString(), note: '节点范围验证' }, admin.id);
  const processPayments = await paymentService.list({ page: 1, pageSize: 20 }, processStaff.id, 'RELATED');
  check('当前节点负责人可查看所属项目的回款', processPayments.total >= 1, String(processPayments.total));
  const processFiles = await fileStorage.list('Project', project.id, processStaff.id);
  check('当前节点负责人可查看所属项目的附件', Array.isArray(processFiles), String(processFiles.length));

  await expectFailure(
    '专利代理人推进「受理」→ 被拒',
    () => transitionService.transition(project.id, { reason: '越权推进' }, agent.id, 'RELATED'),
    '当前节点由「流程人员」负责',
  );

  console.log('\n=== 4. 流程人员接手继续推进 ===');
  const current = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { version: true } });
  const byProcess = await transitionService.transition(project.id, { version: current.version, reason: '受理完成' }, processStaff.id, 'RELATED');
  check('流程人员推进「受理 → 审查」成功', byProcess.toNode.code === 'EXAMINATION', byProcess.toNode.code);

  const backToAgent = await transitionService.availableTransitions(project.id, processStaff.id, 'RELATED');
  check('回到专利代理人负责的节点，流程人员不能再推', backToAgent.canTransition === false, String(backToAgent.canTransition));
  const agentAgain = await transitionService.availableTransitions(project.id, agent.id, 'RELATED');
  check('专利代理人此时又可以推（该节点归他）', agentAgain.canTransition === true, String(agentAgain.canTransition));

  console.log('\n=== 5. 管理员与总经理不受分派限制 ===');
  const adminView = await transitionService.availableTransitions(project.id, admin.id, 'ALL');
  check('系统管理员可推进任意节点', adminView.canTransition === true);
  const gmView = await transitionService.availableTransitions(project.id, gm.id, 'ALL');
  check('总经理可推进任意节点', gmView.canTransition === true);

  const gmTransition = await transitionService.transition(project.id, { reason: '总经理代推' }, gm.id, 'ALL');
  check('总经理代推成功（越过节点分派）', gmTransition.toNode.code === 'GRANT', gmTransition.toNode.code);

  const gmAudit = await prisma.auditLog.findFirst({
    where: { resourceType: 'Project', resourceId: project.id, action: 'NODE_TRANSITION', actorId: gm.id },
    orderBy: { createdAt: 'desc' },
    select: { reason: true },
  });
  check('代推写入审计日志（可追溯是谁代的）', gmAudit !== null, String(gmAudit?.reason));

  console.log('\n=== 6. 节点未配负责人时不限制（避免流程卡死） ===');
  const template = await prisma.workflowTemplate.findFirstOrThrow({ where: { name: '专利' } });
  const version = await prisma.workflowVersion.findFirstOrThrow({ where: { templateId: template.id, status: 'PUBLISHED' } });
  const grantNode = await prisma.workflowNode.findFirstOrThrow({ where: { versionId: version.id, code: 'GRANT' } });
  await prisma.workflowNode.update({ where: { id: grantNode.id }, data: { assigneeType: null, assigneeId: null } });

  const unassignedView = await transitionService.availableTransitions(project.id, salesA.id, 'SELF');
  check('未配负责人的节点：任何人都可推进', unassignedView.canTransition === true, String(unassignedView.canTransition));
  check('界面能识别出"未指定负责人"', unassignedView.currentNode?.assignee?.unassigned === true, JSON.stringify(unassignedView.currentNode?.assignee));

  // 还原节点负责人配置
  await prisma.workflowNode.update({ where: { id: grantNode.id }, data: { assigneeType: 'ROLE', assigneeId: 'PROCESS_STAFF' } });

  console.log('\n=== 7. 角色下无人在职时也不限制 ===');
  const certificateNode = await prisma.workflowNode.findFirstOrThrow({ where: { versionId: version.id, code: 'GRANT' } });
  // 临时把该节点指向一个没有在职人员的角色
  const emptyRole = await prisma.role.create({ data: { code: 'VERIFY_EMPTY_ROLE', name: '验证空角色', isActive: true } });
  await prisma.workflowNode.update({ where: { id: certificateNode.id }, data: { assigneeType: 'ROLE', assigneeId: 'VERIFY_EMPTY_ROLE' } });
  const emptyRoleCheck = await nodeAssignee.checkTransitionPermission(salesA.id, { assigneeType: 'ROLE', assigneeId: 'VERIFY_EMPTY_ROLE' });
  check('角色下无人在职 → 视为无人负责，不限制', emptyRoleCheck.canTransition === true, String(emptyRoleCheck.canTransition));

  // 停用角色后同样不限制
  await prisma.role.update({ where: { id: emptyRole.id }, data: { isActive: false } });
  const inactiveRoleCheck = await nodeAssignee.checkTransitionPermission(salesA.id, { assigneeType: 'ROLE', assigneeId: 'VERIFY_EMPTY_ROLE' });
  check('角色已停用 → 视为无人负责，不限制', inactiveRoleCheck.canTransition === true, String(inactiveRoleCheck.canTransition));

  await prisma.workflowNode.update({ where: { id: certificateNode.id }, data: { assigneeType: 'ROLE', assigneeId: 'PROCESS_STAFF' } });
  await prisma.role.delete({ where: { id: emptyRole.id } });

  console.log('\n=== 8. 未进入节点时不限制（起步） ===');
  await prisma.project.update({ where: { id: project.id }, data: { currentNodeCode: null } });
  const notStarted = await nodeAssignee.checkTransitionPermission(salesA.id, null);
  check('尚未进入任何节点 → 允许起步', notStarted.canTransition === true, String(notStarted.canTransition));
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await resetBusinessData(prisma);
      console.log('\n[清理] 已清理业务数据与残留字段定义');
    } catch (error) {
      console.error('清理失败:', error.message);
      failures += 1;
    }
    if (app) await app.close();
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    if (failures > 0) process.exitCode = 1;
  });

/**
 * 阶段 1b 验证：流程模板、版本绑定与节点推进（真实服务 + 真实事务 + 真实数据库）。
 *
 * 覆盖：
 *   - 系统 A 按项目类型读取已发布流程（专利/软著/通用兜底）
 *   - 创建项目时绑定已发布版本并落到第一个节点
 *   - 节点推进：状态自动同步、写节点历史与状态历史、写审计日志、计算节点期限
 *   - 只能推进到下一个节点，不能跳号
 *   - 不属于该版本的节点被拒绝
 *   - 并发推进乐观锁：过期版本号 409
 *   - 版本化：发布新版本后旧版本锁定、老项目仍走老版本、新项目走新版本
 *   - 节点插入/修改/删除后序号自动重排且连续、不重复
 *   - 已发布版本不能改/删节点，必须新建版本
 * 运行结束后清理测试数据与流程测试版本。
 *
 * 用法：node scripts/verify-workflow.cjs   （需先 tsc 构建出 dist）
 */
const { PrismaClient } = require('@prisma/client');
const { resetBusinessData, logResetResult, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');
const { ProjectService } = require('../dist/modules/projects/project.service');
const { WorkflowService } = require('../dist/modules/workflows/workflow.service');
const { TransitionService } = require('../dist/modules/workflows/transition.service');
const { HistoryService } = require('../dist/modules/history/history.service');

const prisma = createTestPrismaClient();
const TEST_CUSTOMER_NAME = '流程验证客户（临时）';
const TEST_TEMPLATE_NAME = '流程验证模板（临时）';
let failures = 0;
let app;

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

/**
 * 清理本次验证对预置模板造成的改动（在专利模板上发布的新版本），保证脚本可重复执行。
 * 只保留每个模板最早的版本并置为 PUBLISHED，把绑到临时版本的项目改绑回来。
 */
async function restorePresetTemplates() {
  const templates = await prisma.workflowTemplate.findMany({ where: { name: { in: ['专利', '商标', '软著', '项目', '通用流程'] } }, select: { id: true, name: true } });
  for (const template of templates) {
    const versions = await prisma.workflowVersion.findMany({ where: { templateId: template.id }, orderBy: { version: 'asc' }, select: { id: true, version: true } });
    if (versions.length <= 1) {
      if (versions[0]) await prisma.workflowVersion.update({ where: { id: versions[0].id }, data: { status: 'PUBLISHED' } });
      continue;
    }
    const [keep, ...extras] = versions;
    for (const extra of extras) {
      await prisma.project.updateMany({ where: { workflowVersionId: extra.id }, data: { workflowVersionId: keep.id } });
      await prisma.workflowNode.deleteMany({ where: { versionId: extra.id } });
      await prisma.workflowVersion.delete({ where: { id: extra.id } });
    }
    await prisma.workflowVersion.update({ where: { id: keep.id }, data: { status: 'PUBLISHED' } });
    console.log(`  [还原] 模板「${template.name}」已清理 ${extras.length} 个验证版本`);
  }
}

async function cleanupFixtures() {
  const templates = await prisma.workflowTemplate.findMany({ where: { name: TEST_TEMPLATE_NAME }, select: { id: true } });
  for (const template of templates) {
    const versions = await prisma.workflowVersion.findMany({ where: { templateId: template.id }, select: { id: true } });
    await prisma.project.updateMany({ where: { workflowVersionId: { in: versions.map((v) => v.id) } }, data: { workflowVersionId: null, currentNodeCode: null, currentNodeEnteredAt: null } });
    await prisma.workflowNode.deleteMany({ where: { versionId: { in: versions.map((v) => v.id) } } });
    await prisma.workflowVersion.deleteMany({ where: { templateId: template.id } });
    await prisma.workflowTemplate.delete({ where: { id: template.id } });
  }
}

async function main() {
  logResetResult('流程与节点', await resetBusinessData(prisma));
  await cleanupFixtures();
  await restorePresetTemplates();

  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const contractService = app.get(ContractService);
  const projectService = app.get(ProjectService);
  const workflowService = app.get(WorkflowService);
  const transitionService = app.get(TransitionService);
  const historyService = app.get(HistoryService);
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true, displayName: true } });
  const customer = await prisma.customer.create({ data: { name: TEST_CUSTOMER_NAME } });

  console.log('=== 1. 按项目类型读取已发布流程 ===');
  const patentFlow = await workflowService.listPublishedNodes('专利');
  check('专利项目取到专用模板', patentFlow.version?.templateName === '专利', String(patentFlow.version?.templateName));
  check('专利流程 5 个节点', patentFlow.nodes.length === 5, String(patentFlow.nodes.length));
  check('首节点是「提交申请」', patentFlow.nodes[0]?.name === '提交申请', patentFlow.nodes[0]?.name ?? '');
  check('末节点统计状态为已完成', patentFlow.nodes[4]?.statisticsCode === 'COMPLETED', String(patentFlow.nodes[4]?.statisticsCode));

  const unknownFlow = await workflowService.listPublishedNodes('未知类型');
  check('未匹配到专用模板时退回通用流程', unknownFlow.version?.templateName === '通用流程', String(unknownFlow.version?.templateName));
  check('通用流程 8 个节点', unknownFlow.nodes.length === 8, String(unknownFlow.nodes.length));

  console.log('\n=== 2. 创建项目时绑定流程并落到首节点 ===');
  const contract = await contractService.create(
    { contractNo: 'VERIFY-WORKFLOW-1', customerId: customer.id, amount: 30000, contractType: 'PATENT', itemCount: 2, signedAt: '2026-09-01' },
    admin.id,
  );
  const projects = await prisma.project.findMany({ where: { contractId: contract.id }, orderBy: { sequence: 'asc' } });
  check('生成的 2 个项目都绑定了流程版本', projects.every((item) => item.workflowVersionId !== null));
  check('两个项目都落在首节点 SUBMIT_APPLICATION', projects.every((item) => item.currentNodeCode === 'SUBMIT_APPLICATION'), projects.map((p) => p.currentNodeCode).join(','));
  check('记录了进入首节点的时间', projects.every((item) => item.currentNodeEnteredAt !== null));

  const projectId = projects[0].id;
  const detail = await projectService.getById(projectId, admin.id, 'ALL');
  check('项目详情返回流程上下文', detail.workflow.bound === true);
  check('详情返回当前节点名称', detail.workflow.currentNode?.name === '提交申请', String(detail.workflow.currentNode?.name));
  check('详情返回下一节点名称', detail.workflow.nextNode?.name === '受理', String(detail.workflow.nextNode?.name));
  check('详情返回完整节点序列', detail.workflow.nodes.length === 5, String(detail.workflow.nodes.length));

  console.log('\n=== 3. 推进到下一个节点 ===');
  const beforeVersion = (await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { version: true } })).version;
  const advanced = await transitionService.transition(
    projectId,
    { version: beforeVersion, reason: '材料已备齐' },
    admin.id,
    'ALL',
  );
  check('推进到「受理」', advanced.toNode.code === 'ACCEPTANCE', advanced.toNode.code);
  check('项目状态自动同步为进行中', advanced.statusCode === 'IN_PROGRESS', advanced.statusCode);
  check('项目版本自增', advanced.project.version === beforeVersion + 1, String(advanced.project.version));
  check('按节点时限算出截止日（受理 15 天）', advanced.deadlineAt !== null);

  const nodeHistory = await historyService.listNodeHistory(projectId);
  check('写入节点流转历史', nodeHistory.length === 1, String(nodeHistory.length));
  check('节点历史记录方向 提交申请→受理', nodeHistory[0]?.fromNodeCode === 'SUBMIT_APPLICATION' && nodeHistory[0]?.toNodeCode === 'ACCEPTANCE');
  check('节点历史记录操作人', nodeHistory[0]?.operator?.displayName === admin.displayName);
  check('节点历史记录流转原因', nodeHistory[0]?.reason === '材料已备齐', String(nodeHistory[0]?.reason));

  const statusHistory = await historyService.listStatusHistory('Project', projectId);
  check('同步写入状态变化历史', statusHistory.length === 1, String(statusHistory.length));
  check('状态变化为 待完成→进行', statusHistory[0]?.toStatusLabel === '进行', String(statusHistory[0]?.toStatusLabel));

  const auditCount = await prisma.auditLog.count({ where: { action: 'NODE_TRANSITION', resourceId: projectId } });
  check('节点推进写入审计日志', auditCount === 1, String(auditCount));

  console.log('\n=== 4. 推进规则 ===');
  const currentVersion = (await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { version: true } })).version;
  await expectFailure(
    '用过期版本号推进 → 409',
    () => transitionService.transition(projectId, { version: beforeVersion }, admin.id, 'ALL'),
    '已被他人更新',
  );
  await expectFailure(
    '跳到本版本内但非下一个节点 → 拒绝（防止跳过中间节点）',
    () => transitionService.transition(projectId, { version: currentVersion, toNodeCode: 'CERTIFICATE' }, admin.id, 'ALL'),
    '只能推进到下一个节点',
  );
  await expectFailure(
    '指定不属于该版本的节点 → 拒绝',
    () => transitionService.transition(projectId, { version: currentVersion, toNodeCode: 'NOT_EXIST_NODE' }, admin.id, 'ALL'),
    '不属于本项目绑定的流程版本',
  );
  const afterFailed = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { currentNodeCode: true, version: true } });
  check('失败的推进不改变节点与版本', afterFailed.currentNodeCode === 'ACCEPTANCE' && afterFailed.version === currentVersion);

  // 一路推进到末尾，验证末节点不可再推进
  let guard = 0;
  while (guard < 10) {
    guard += 1;
    const current = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { currentNodeCode: true, version: true } });
    const context = await transitionService.availableTransitions(projectId, admin.id, 'ALL');
    if (!context.nextNode) break;
    await transitionService.transition(projectId, { version: current.version }, admin.id, 'ALL');
  }
  const finalProject = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { currentNodeCode: true, statusCode: true } });
  check('推进到末节点 CERTIFICATE', finalProject.currentNodeCode === 'CERTIFICATE', finalProject.currentNodeCode ?? '');
  check('末节点状态同步为已完成', finalProject.statusCode === 'COMPLETED', finalProject.statusCode);
  const lastContext = await transitionService.availableTransitions(projectId, admin.id, 'ALL');
  check('末节点没有下一节点', lastContext.nextNode === null);
  const finalVersion = (await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { version: true } })).version;
  await expectFailure(
    '末节点继续推进 → 拒绝',
    () => transitionService.transition(projectId, { version: finalVersion }, admin.id, 'ALL'),
    '已经是最后一个节点',
  );

  console.log('\n=== 5. 版本化：老项目走老版本，新项目走新版本 ===');
  const patentTemplate = await prisma.workflowTemplate.findFirstOrThrow({ where: { name: '专利', moduleKey: 'project' }, select: { id: true } });
  const publishedV1 = await prisma.workflowVersion.findFirstOrThrow({ where: { templateId: patentTemplate.id, status: 'PUBLISHED' } });

  const draft = await workflowService.createVersion(patentTemplate.id, { copyFromVersionId: publishedV1.id }, admin.id);
  check('新建版本为草稿', draft.status === 'DRAFT', draft.status);
  check('新版本复制了原有节点', draft.nodes.length === 5, String(draft.nodes.length));

  // 断言不写死节点名，改为按"插入/移动后的位置关系"校验，避免与具体模板耦合
  const beforeInsert = await prisma.workflowNode.findMany({ where: { versionId: draft.id }, orderBy: { sequence: 'asc' }, select: { name: true } });
  const originalAt3 = beforeInsert[2]?.name;

  const insertedNode = await workflowService.createNode(
    draft.id,
    { code: 'INTERNAL_REVIEW', name: '内部审核', nodeType: 'MANUAL', sequence: 3, assigneeType: 'ROLE', assigneeId: 'FILING_REVIEWER', statisticsCode: 'IN_PROGRESS' },
    admin.id,
  );
  const afterInsertNodes = await prisma.workflowNode.findMany({ where: { versionId: draft.id }, orderBy: { sequence: 'asc' }, select: { sequence: true, name: true } });
  check(
    '在顺序 3 插入节点后，新节点占住第 3 位、原第 3 位被后移',
    afterInsertNodes[2]?.name === '内部审核' && afterInsertNodes[3]?.name === originalAt3,
    afterInsertNodes.map((item) => `${item.sequence}:${item.name}`).join('、'),
  );
  check('插入后节点序号连续且不重复', afterInsertNodes.every((item, index) => item.sequence === index + 1));

  await workflowService.updateNode(
    insertedNode.id,
    { code: 'INTERNAL_REVIEW', name: '内部审核', nodeType: 'MANUAL', sequence: 5, assigneeType: 'ROLE', assigneeId: 'FILING_REVIEWER', statisticsCode: 'IN_PROGRESS' },
    admin.id,
  );
  const afterMoveNodes = await prisma.workflowNode.findMany({ where: { versionId: draft.id }, orderBy: { sequence: 'asc' }, select: { sequence: true, name: true } });
  check(
    '修改节点顺序到 5 后整体自动重排（该节点落到第 5 位）',
    afterMoveNodes[4]?.name === '内部审核',
    afterMoveNodes.map((item) => `${item.sequence}:${item.name}`).join('、'),
  );
  check('修改顺序后节点序号连续且不重复', afterMoveNodes.every((item, index) => item.sequence === index + 1));

  await workflowService.deleteNode(insertedNode.id, admin.id);
  const afterDeleteNodes = await prisma.workflowNode.findMany({ where: { versionId: draft.id }, orderBy: { sequence: 'asc' }, select: { sequence: true, name: true } });
  check('删除节点后后续序号自动补齐', afterDeleteNodes.length === 5 && afterDeleteNodes.every((item, index) => item.sequence === index + 1));

  await workflowService.createNode(
    draft.id,
    { code: 'ANNUITY', name: '年费监控', nodeType: 'MANUAL', sequence: 6, assigneeType: 'ROLE', assigneeId: 'PROCESS_STAFF', deadlineDays: 30, statisticsCode: 'IN_PROGRESS' },
    admin.id,
  );
  await workflowService.publishVersion(draft.id, admin.id);

  const afterPublish = await prisma.workflowVersion.findMany({ where: { templateId: patentTemplate.id }, orderBy: { version: 'asc' }, select: { id: true, version: true, status: true } });
  check('新版本已发布', afterPublish.some((v) => v.id === draft.id && v.status === 'PUBLISHED'));
  check('旧版本自动锁定为 LOCKED', afterPublish.some((v) => v.id === publishedV1.id && v.status === 'LOCKED'), afterPublish.map((v) => `v${v.version}:${v.status}`).join(', '));

  const oldProject = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { workflowVersionId: true } });
  check('老项目仍绑定老版本', oldProject.workflowVersionId === publishedV1.id, String(oldProject.workflowVersionId));

  const newContract = await contractService.create(
    { contractNo: 'VERIFY-WORKFLOW-2', customerId: customer.id, amount: 10000, contractType: 'PATENT', itemCount: 1, signedAt: '2026-10-01' },
    admin.id,
  );
  const newProject = await prisma.project.findFirstOrThrow({ where: { contractId: newContract.id }, select: { workflowVersionId: true } });
  check('新项目绑定新版本', newProject.workflowVersionId === draft.id, String(newProject.workflowVersionId));

  console.log('\n=== 6. 已发布版本不可直接修改 ===');
  const publishedNode = await prisma.workflowNode.findFirstOrThrow({ where: { versionId: draft.id }, select: { id: true, code: true, name: true, sequence: true } });
  await expectFailure(
    '修改已发布版本的节点 → 拒绝',
    () => workflowService.updateNode(publishedNode.id, { code: publishedNode.code, name: '改名', nodeType: 'MANUAL', sequence: publishedNode.sequence }, admin.id),
    '已发布并锁定',
  );
  await expectFailure(
    '在已发布版本上新增节点 → 拒绝',
    () => workflowService.createNode(draft.id, { code: 'EXTRA', name: '额外节点', nodeType: 'MANUAL', sequence: 9 }, admin.id),
    '已发布并锁定',
  );
  await expectFailure(
    '删除已发布版本的节点 → 拒绝',
    () => workflowService.deleteNode(publishedNode.id, admin.id),
    '已发布并锁定',
  );

  console.log('\n=== 7. 未绑定流程的项目按项目类型自动绑定 ===');
  // 模拟阶段 1b 之前创建的历史项目：既没有绑定版本，也没有当前节点
  await prisma.project.update({
    where: { id: projects[1].id },
    data: { workflowVersionId: null, currentNodeCode: null, currentNodeEnteredAt: null },
  });
  const rebindContext = await transitionService.availableTransitions(projects[1].id, admin.id, 'ALL');
  check('未绑定项目能解析出首节点作为下一步', rebindContext.nextNode?.code === 'SUBMIT_APPLICATION', rebindContext.nextNode?.name ?? '(空)');
  const rebindVersion = (await prisma.project.findUniqueOrThrow({ where: { id: projects[1].id }, select: { version: true } })).version;
  await transitionService.transition(projects[1].id, { version: rebindVersion }, admin.id, 'ALL');
  const rebound = await prisma.project.findUniqueOrThrow({ where: { id: projects[1].id }, select: { workflowVersionId: true, currentNodeCode: true } });
  check('推进后自动绑定并落到首节点', rebound.workflowVersionId !== null && rebound.currentNodeCode === 'SUBMIT_APPLICATION', `${rebound.workflowVersionId ? '已绑定' : '未绑定'} / ${rebound.currentNodeCode}`);
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await restorePresetTemplates();
      await cleanupFixtures();
      await resetBusinessData(prisma);
      console.log('\n[清理] 已还原预置流程模板、删除流程测试模板与业务数据，编号计数器已归零');
    } catch (error) {
      console.error('清理失败:', error.message);
      failures += 1;
    }
    if (app) await app.close();
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    if (failures > 0) process.exitCode = 1;
  });



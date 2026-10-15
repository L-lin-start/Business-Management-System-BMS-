/**
 * 合同类型 / 项目类型选项治理验证。
 *
 * 背景：这两个字段原先接受自由文本，会出现「专利」「发明专利」「专利业务」各写各的，
 * 导致流程匹配、筛选与统计口径不一致。现在只允许选择系统 B 配置好的选项。
 *
 * 覆盖：
 *   - 选项接口按模块返回启用中的选项
 *   - 合同类型：编码与中文标签都能提交（都会归一为编码存储）
 *   - 未配置的类型被拒绝（400），且不产生数据
 *   - 项目类型由合同类型带出为中文标签，据此匹配同名流程模板
 *   - 项目类型直接提交非法值同样被拒绝
 *   - 内置合同/项目类型不可删除，自定义类型可直接删除
 *   - 自定义类型删除后不能再选，但历史数据仍能正常显示
 *   - 删除是软删除，不物理删除
 *
 * 用法：node scripts/verify-options.cjs   （需先 tsc 构建出 dist）
 */
const { PrismaClient } = require('@prisma/client');
const { resetBusinessData, logResetResult, createContractNoFactory, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');
const { ProjectService } = require('../dist/modules/projects/project.service');
const { OptionsService } = require('../dist/modules/options/options.service');

const prisma = createTestPrismaClient();
const TEST_CUSTOMER_NAME = '选项验证客户（临时）';
const TEST_OPTION_CODE = 'TEMP_TYPE';
let failures = 0;
let app;
const nextContractNo = createContractNoFactory('VERIFY-OPT');

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

async function cleanupFixtures() {
  await prisma.statusDefinition.deleteMany({ where: { code: { startsWith: TEST_OPTION_CODE } } });
}

async function main() {
  logResetResult('选项治理', await resetBusinessData(prisma));
  await cleanupFixtures();

  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const contractService = app.get(ContractService);
  const projectService = app.get(ProjectService);
  const optionsService = app.get(OptionsService);
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true } });
  const customer = await prisma.customer.create({ data: { name: TEST_CUSTOMER_NAME } });

  console.log('=== 1. 选项接口 ===');
  const contractTypes = await optionsService.listOptions('contractType');
  check('合同类型有 5 个预置选项', contractTypes.length === 5, String(contractTypes.length));
  check('包含「专利」', contractTypes.some((item) => item.label === '专利'));
  const builtinContractTypes = await prisma.statusDefinition.findMany({ where: { moduleKey: 'contractType', code: { in: ['PATENT', 'TRADEMARK', 'COPYRIGHT', 'PROJECT', 'OTHER'] } } });
  check('预置合同类型均标记为系统内置', builtinContractTypes.length === 5 && builtinContractTypes.every((item) => item.isSystem && item.isActive));
  const projectTypes = await optionsService.listOptions('projectType');
  check('项目类型有 4 个预置选项', projectTypes.length === 4, String(projectTypes.length));
  check('项目类型不含「其他」（项目必须有明确类型才能匹配流程）', !projectTypes.some((item) => item.label === '其他'));

  // 回归防线：新增选项模块时若忘了加进 OPTION_MODULES 白名单，接口会 400、前端下拉静默变空
  const { OPTION_MODULES } = require('../dist/modules/options/options.service');
  const unreadable = [];
  for (const moduleKey of OPTION_MODULES) {
    const items = await optionsService.listOptions(moduleKey);
    if (items.length === 0) unreadable.push(moduleKey);
  }
  check(
    `全部 ${OPTION_MODULES.length} 个选项模块都能读到选项（防止下拉框静默变空）`,
    unreadable.length === 0,
    unreadable.length > 0 ? `无选项的模块：${unreadable.join('、')}` : OPTION_MODULES.join('、'),
  );

  console.log('\n=== 2. 合同类型必须是配置好的选项 ===');
  await expectFailure(
    '提交未配置的类型「咨询」→ 拒绝',
    () => contractService.create({ contractNo: nextContractNo(), customerId: customer.id, amount: 1000, contractType: '咨询', itemCount: 1 }, admin.id),
    '不在可选范围内',
  );
  const leaked = await prisma.contract.count();
  check('被拒绝时不产生合同数据', leaked === 0, String(leaked));

  const byCode = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 1000, contractType: 'PATENT', itemCount: 1, signedAt: '2026-09-01' },
    admin.id,
  );
  check('按编码「PATENT」提交成功，存储归一为编码', byCode.contractType === 'PATENT', String(byCode.contractType));

  const byLabel = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 2000, contractType: '商标', itemCount: 1, signedAt: '2026-09-02' },
    admin.id,
  );
  check('按中文标签「商标」提交也成功', byLabel.contractType === 'TRADEMARK', String(byLabel.contractType));

  console.log('\n=== 3. 项目类型由合同类型带出，并据此匹配流程 ===');
  const patentProject = await prisma.project.findFirstOrThrow({ where: { contractId: byCode.id } });
  check('项目类型带出中文标签「专利」', patentProject.projectType === '专利', String(patentProject.projectType));
  check('项目名称用中文标签「专利项目-1」', patentProject.projectName === '专利项目-1', patentProject.projectName);

  const flow = await optionsService.listOptions('projectType');
  check('中文标签与流程模板同名，可匹配到专用流程', flow.some((item) => item.label === '专利'));

  console.log('\n=== 4. 项目类型直接提交非法值同样被拒绝 ===');
  await expectFailure(
    '手动建项目传未配置类型 → 拒绝',
    () => projectService.create({ contractId: byCode.id, projectName: '非法类型项目', projectType: '随便写的类型' }, admin.id),
    '不在可选范围内',
  );
  const projectCount = await prisma.project.count({ where: { contractId: byCode.id } });
  check('被拒绝时不产生项目数据', projectCount === 1, String(projectCount));

  const legalProject = await projectService.create(
    { contractId: byCode.id, projectName: '指定类型项目', projectType: '软著' },
    admin.id,
  );
  check('按标签「软著」建项目成功且归一为标签', legalProject.projectType === '软著', String(legalProject.projectType));

  console.log('\n=== 5. 编辑合同时同样校验 ===');
  await expectFailure(
    '编辑合同改成未配置类型 → 拒绝',
    () => contractService.update(byCode.id, { contractType: '不存在的类型' }, admin.id, 'ALL'),
    '不在可选范围内',
  );
  const unchanged = await prisma.contract.findUniqueOrThrow({ where: { id: byCode.id } });
  check('被拒绝时合同类型未被改动', unchanged.contractType === 'PATENT', String(unchanged.contractType));

  console.log('\n=== 6. 新增与删除自定义选项 ===');
  const created = await prisma.statusDefinition.create({
    data: { moduleKey: 'contractType', code: TEST_OPTION_CODE, label: '临时类型', sortOrder: 900 },
  });
  const afterCreate = await optionsService.listOptions('contractType');
  check('新增后出现在选项中', afterCreate.some((item) => item.code === TEST_OPTION_CODE), String(afterCreate.length));

  const tempContract = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 3000, contractType: TEST_OPTION_CODE, itemCount: 1, signedAt: '2026-09-03', autoGenerateProjects: false },
    admin.id,
  );
  check('新选项可正常用于建合同', tempContract.contractType === TEST_OPTION_CODE, String(tempContract.contractType));

  await prisma.statusDefinition.update({ where: { id: created.id }, data: { isActive: false } });
  const afterDisable = await optionsService.listOptions('contractType');
  check('删除后不再出现在可选列表中', !afterDisable.some((item) => item.code === TEST_OPTION_CODE), String(afterDisable.length));

  const stillThere = await prisma.statusDefinition.findUnique({ where: { id: created.id } });
  check('删除是软删除，记录仍在（历史数据可正常显示）', stillThere !== null && stillThere.isActive === false);
  const historicalContract = await prisma.contract.findUniqueOrThrow({ where: { id: tempContract.id } });
  check('已用该类型的历史合同不受影响', historicalContract.contractType === TEST_OPTION_CODE, String(historicalContract.contractType));

  await expectFailure(
    '删除后再提交该类型 → 拒绝',
    () => contractService.create({ contractNo: nextContractNo(), customerId: customer.id, amount: 100, contractType: TEST_OPTION_CODE, itemCount: 1 }, admin.id),
    '不在可选范围内',
  );

  console.log('\n=== 7. 空值处理 ===');
  const noType = await contractService.create(
    { contractNo: nextContractNo(), customerId: customer.id, amount: 500, itemCount: 1, signedAt: '2026-09-04', autoGenerateProjects: false },
    admin.id,
  );
  check('不填类型仍可建合同（存储为空）', noType.contractType === null, String(noType.contractType));
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await cleanupFixtures();
      await resetBusinessData(prisma);
      console.log('\n[清理] 已删除临时选项与业务数据，编号计数器已归零');
    } catch (error) {
      console.error('清理失败:', error.message);
      failures += 1;
    }
    if (app) await app.close();
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    if (failures > 0) process.exitCode = 1;
  });


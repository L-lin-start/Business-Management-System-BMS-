/**
 * 自定义字段（系统 B 配置 → 系统 A 生效）验证，走真实服务 + 真实数据库。
 *
 * 覆盖：
 *   - 字段定义接口只返回自定义字段（内置字段由表单固定渲染）
 *   - 录入时自定义字段值写入 customFields
 *   - 必填校验（isRequired）
 *   - 类型校验（NUMBER / DATE）
 *   - 选项校验（SELECT 取值必须在 config.options 内）
 *   - 默认值填充（config.defaultValue）
 *   - 未定义字段被丢弃，避免 customFields 堆积垃圾
 *   - 停用字段后不再参与校验
 * 运行结束后清理测试数据并把流水号计数器归零。
 *
 * 用法：node scripts/verify-custom-fields.cjs   （需先 tsc 构建出 dist）
 */
const { PrismaClient } = require('@prisma/client');
const { resetBusinessData, logResetResult, createContractNoFactory, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { ContractService } = require('../dist/modules/contracts/contract.service');
const { CustomFieldsService } = require('../dist/infrastructure/custom-fields/custom-fields.service');
const { OptionsService } = require('../dist/modules/options/options.service');

const prisma = createTestPrismaClient();
const TEST_CUSTOMER_NAME = '自定义字段验证客户（临时）';
const FIXTURE_PREFIX = 'cfv_';
let failures = 0;
let app;
const nextContractNo = createContractNoFactory('VERIFY-FIELD');

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

async function main() {
  // 脚本自包含：清空业务数据与编号计数器，避免受其它验证脚本影响
  logResetResult('自定义字段', await resetBusinessData(prisma));
  await prisma.fieldDefinition.deleteMany({ where: { fieldKey: { startsWith: FIXTURE_PREFIX } } });

  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const contractService = app.get(ContractService);
  const customFieldsService = app.get(CustomFieldsService);
  const optionsService = app.get(OptionsService);
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' }, select: { id: true } });
  const customer = await prisma.customer.create({ data: { name: TEST_CUSTOMER_NAME } });

  // 建立本轮验证用的字段定义
  await prisma.fieldDefinition.createMany({
    data: [
      { moduleKey: 'contract', fieldKey: `${FIXTURE_PREFIX}level`, label: '重要程度', fieldType: 'SELECT', isRequired: true, isSystem: false, isListVisible: true, isSearchable: false, sortOrder: 900, config: { options: ['高', '中', '低'] } },
      { moduleKey: 'contract', fieldKey: `${FIXTURE_PREFIX}budget`, label: '预算金额', fieldType: 'NUMBER', isRequired: false, isSystem: false, isListVisible: true, isSearchable: false, sortOrder: 901 },
      { moduleKey: 'contract', fieldKey: `${FIXTURE_PREFIX}deadline`, label: '内部期限', fieldType: 'DATE', isRequired: false, isSystem: false, isListVisible: false, isSearchable: false, sortOrder: 902 },
      { moduleKey: 'contract', fieldKey: `${FIXTURE_PREFIX}channel`, label: '渠道', fieldType: 'TEXT', isRequired: false, isSystem: false, isListVisible: true, isSearchable: false, sortOrder: 903, config: { defaultValue: '直销' } },
    ],
  });

  console.log('=== 1. 字段定义接口只返回自定义字段 ===');
  const exposed = await optionsService.listCustomFields('contract');
  check('返回的字段全部是自定义字段', exposed.every((item) => !item.fieldKey.startsWith('customerId')), `${exposed.length} 个`);
  check('包含本轮新建的 4 个字段', [FIXTURE_PREFIX + 'level', FIXTURE_PREFIX + 'budget', FIXTURE_PREFIX + 'deadline', FIXTURE_PREFIX + 'channel'].every((key) => exposed.some((item) => item.fieldKey === key)));
  check('内置字段（合同编号/所属客户）未出现在自定义字段列表中', !exposed.some((item) => item.fieldKey === 'contractNo'));

  // 合同编号已是人工填写且不允许重号：fixture 里不含编号，
  // 每次建合同都单独生成一个，避免复用同一个编号被拒。
  const baseContract = { customerId: customer.id, amount: 10000, contractType: 'COPYRIGHT', itemCount: 1, signedAt: '2026-09-10', autoGenerateProjects: false };

  console.log('\n=== 2. 自定义字段值写入 customFields ===');
  const created = await contractService.create(
    { ...baseContract, contractNo: nextContractNo(), customFields: { [`${FIXTURE_PREFIX}level`]: '高', [`${FIXTURE_PREFIX}budget`]: '2500', [`${FIXTURE_PREFIX}deadline`]: '2026-10-01' } },
    admin.id,
  );
  const stored = created.customFields;
  check('重要程度已保存', stored?.[`${FIXTURE_PREFIX}level`] === '高', String(stored?.[`${FIXTURE_PREFIX}level`]));
  check('预算金额按数字保存', stored?.[`${FIXTURE_PREFIX}budget`] === 2500, String(stored?.[`${FIXTURE_PREFIX}budget`]));
  check('日期已归一化为 ISO 字符串', typeof stored?.[`${FIXTURE_PREFIX}deadline`] === 'string' && String(stored[`${FIXTURE_PREFIX}deadline`]).startsWith('2026-10-01'), String(stored?.[`${FIXTURE_PREFIX}deadline`]));

  console.log('\n=== 3. 必填校验 ===');
  await expectFailure(
    '缺少必填自定义字段 → 拒绝',
    () => contractService.create({ ...baseContract, contractNo: nextContractNo(), customFields: { [`${FIXTURE_PREFIX}budget`]: 100 } }, admin.id),
    '重要程度为必填',
  );

  console.log('\n=== 4. 类型与选项校验 ===');
  await expectFailure(
    '数字字段传非数字 → 拒绝',
    () => contractService.create({ ...baseContract, contractNo: nextContractNo(), customFields: { [`${FIXTURE_PREFIX}level`]: '高', [`${FIXTURE_PREFIX}budget`]: 'abc' } }, admin.id),
    '预算金额必须是数字',
  );
  await expectFailure(
    '下拉字段传非法选项 → 拒绝',
    () => contractService.create({ ...baseContract, contractNo: nextContractNo(), customFields: { [`${FIXTURE_PREFIX}level`]: '超高' } }, admin.id),
    '重要程度的取值不在可选范围内',
  );
  await expectFailure(
    '日期字段传非法日期 → 拒绝',
    () => contractService.create({ ...baseContract, contractNo: nextContractNo(), customFields: { [`${FIXTURE_PREFIX}level`]: '中', [`${FIXTURE_PREFIX}deadline`]: 'not-a-date' } }, admin.id),
    '内部期限必须是合法日期',
  );

  console.log('\n=== 5. 默认值与未定义字段 ===');
  const withDefault = await contractService.create(
    { ...baseContract, contractNo: nextContractNo(), signedAt: '2026-09-11', customFields: { [`${FIXTURE_PREFIX}level`]: '低', notDefinedField: '应被丢弃' } },
    admin.id,
  );
  check('未传的字段按默认值填充', withDefault.customFields?.[`${FIXTURE_PREFIX}channel`] === '直销', String(withDefault.customFields?.[`${FIXTURE_PREFIX}channel`]));
  check('未定义字段被丢弃', withDefault.customFields?.notDefinedField === undefined);

  console.log('\n=== 6. 更新时的校验 ===');
  const updated = await contractService.update(created.id, { customFields: { [`${FIXTURE_PREFIX}level`]: '中' } }, admin.id, 'ALL');
  check('可更新自定义字段', updated.customFields?.[`${FIXTURE_PREFIX}level`] === '中', String(updated.customFields?.[`${FIXTURE_PREFIX}level`]));
  await expectFailure(
    '更新时把必填字段清空 → 拒绝',
    () => contractService.update(created.id, { customFields: { [`${FIXTURE_PREFIX}level`]: '' } }, admin.id, 'ALL'),
    '重要程度为必填',
  );
  const partialUpdate = await contractService.update(created.id, { amount: 12000 }, admin.id, 'ALL');
  check('不提交自定义字段时不影响已有值', partialUpdate.customFields?.[`${FIXTURE_PREFIX}level`] === '中' && Number(partialUpdate.amount) === 12000);

  console.log('\n=== 7. 停用字段后不再校验 ===');
  await prisma.fieldDefinition.updateMany({ where: { fieldKey: `${FIXTURE_PREFIX}level` }, data: { isActive: false } });
  const afterDisable = await contractService.create({ ...baseContract, contractNo: nextContractNo(), signedAt: '2026-09-12' }, admin.id);
  check('停用必填字段后无需再填', afterDisable.customFields?.[`${FIXTURE_PREFIX}level`] === undefined, '已通过');

  const sanitized = await customFieldsService.sanitize('contract', { [`${FIXTURE_PREFIX}level`]: '高' });
  check('停用字段的值会被丢弃', sanitized?.[`${FIXTURE_PREFIX}level`] === undefined);
}

main()
  .catch((error) => {
    console.error('\n验证异常:', error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await prisma.fieldDefinition.deleteMany({ where: { fieldKey: { startsWith: FIXTURE_PREFIX } } });
      const customers = await prisma.customer.findMany({ where: { name: TEST_CUSTOMER_NAME }, select: { id: true } });
      const ids = customers.map((item) => item.id);
      if (ids.length) {
        await prisma.projectPaymentAllocation.deleteMany({ where: { payment: { contract: { customerId: { in: ids } } } } });
        await prisma.paymentReceipt.deleteMany({ where: { contract: { customerId: { in: ids } } } });
        await prisma.costRecord.deleteMany({ where: { contract: { customerId: { in: ids } } } });
        await prisma.project.deleteMany({ where: { contract: { customerId: { in: ids } } } });
        await prisma.contract.deleteMany({ where: { customerId: { in: ids } } });
        await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      }
      await prisma.$executeRawUnsafe('DELETE FROM "DocumentSequence"');
      console.log(`\n[清理] 删除验证字段与客户，流水号已归零`);
    } catch (error) {
      console.error('清理失败:', error.message);
      failures += 1;
    }
    if (app) await app.close();
    await prisma.$disconnect();
    console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    if (failures > 0) process.exitCode = 1;
  });


/**
 * 客户「所属销售」绑定规则验证。
 *
 * 规则（业务确认 2026-10-14）：
 *   1. 可指派角色（总经理、系统管理员，即 customer.create 数据范围为 ALL）新建客户时可自由指定所属销售；
 *   2. 其余角色（销售等）新建客户时**强制绑定自己**，请求里传别人的 id 会被静默改写；
 *   3. 编辑时同样收窄：不可指派者把 owner 改成别人 → 403 拒绝；
 *   4. `GET /api/customers/form-policy` 下发字段锁定规则供前端渲染。
 *
 * 用法：node scripts/verify-customer-owner-policy.cjs   （需先 tsc 构建出 dist）
 */
const { PrismaClient } = require('@prisma/client');
const { resetBusinessData, logResetResult, prepareTestDatabaseEnv, createTestPrismaClient } = require('./test-utils.cjs');

const { NestFactory } = require('@nestjs/core');
// 必须在加载任何 dist 产物之前把连接指向测试库：
// PrismaService 在模块加载时就用 DATABASE_URL 建连接池，之后再改环境变量不生效。
prepareTestDatabaseEnv();

const { AppModule } = require('../dist/app.module');

const { CustomerService } = require('../dist/modules/customers/customer.service');

const prisma = createTestPrismaClient();
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

async function main() {
  logResetResult('客户归属', await resetBusinessData(prisma));
  await prisma.fieldDefinition.deleteMany({ where: { isSystem: false } });

  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const customerService = app.get(CustomerService);

  // 复用种子里已建好的业务账号；缺了就补建，保证脚本自包含
  const pick = async (username, displayName, roleCode) => {
    const existing = await prisma.user.findFirst({ where: { username } });
    if (existing) return existing;
    const role = await prisma.role.findFirstOrThrow({ where: { code: roleCode } });
    return prisma.user.create({
      data: { username, displayName, passwordHash: 'not-a-real-hash', roles: { create: [{ roleId: role.id }] } },
    });
  };

  const salesA = await pick('aaa', '销售A', 'SALES');
  const salesB = await pick('bbb', '销售B', 'SALES');
  const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
  const gm = await pick('zjl', '总经理', 'GENERAL_MANAGER');

  console.log('=== 1. 表单锁定规则下发 ===');
  const salesPolicy = await customerService.formPolicy(salesA.id);
  check('销售：所属销售被锁定', salesPolicy.ownerId.locked === true);
  check('销售：锁定值为自己', salesPolicy.ownerId.lockedValue === salesA.id, String(salesPolicy.ownerId.lockedValue));
  check('销售：下发可读名称便于展示', salesPolicy.ownerId.lockedLabel === '销售A', String(salesPolicy.ownerId.lockedLabel));
  check('销售：给出锁定原因', (salesPolicy.ownerId.reason ?? '').includes('只能把客户归属于自己'), salesPolicy.ownerId.reason);

  const adminPolicy = await customerService.formPolicy(admin.id);
  check('系统管理员：不锁定，可自由指派', adminPolicy.ownerId.locked === false, JSON.stringify(adminPolicy.ownerId));

  const gmPolicy = await customerService.formPolicy(gm.id);
  check('总经理：不锁定，可自由指派', gmPolicy.ownerId.locked === false, JSON.stringify(gmPolicy.ownerId));

  console.log('\n=== 2. 销售新建客户：强制绑定自己 ===');
  const createdNoOwner = await customerService.create({ name: '销售A自建客户（不传所属销售）' }, salesA.id);
  check('不传所属销售 → 归属自己', createdNoOwner.ownerId === salesA.id, String(createdNoOwner.ownerId));

  const createdIgnore = await customerService.create(
    { name: '销售A试图建到销售B名下', ownerId: salesB.id },
    salesA.id,
  );
  check('传别人的 id → 被改写为自己', createdIgnore.ownerId === salesA.id, String(createdIgnore.ownerId));
  check('返回的 owner 也是自己', createdIgnore.owner?.id === salesA.id, String(createdIgnore.owner?.id));

  const overrideAudit = await prisma.auditLog.findFirst({
    where: { resourceType: 'Customer', resourceId: createdIgnore.id, action: 'CREATE' },
    select: { reason: true },
  });
  check('被强制改写时留痕说明原因', (overrideAudit?.reason ?? '').includes('强制绑定'), String(overrideAudit?.reason));

  const createdSelf = await customerService.create({ name: '销售A显式指定自己', ownerId: salesA.id }, salesA.id);
  check('显式传自己也正常', createdSelf.ownerId === salesA.id, String(createdSelf.ownerId));
  check('显式传自己不产生改写留痕', (await prisma.auditLog.findFirst({ where: { resourceType: 'Customer', resourceId: createdSelf.id, action: 'CREATE' } }))?.reason === null);

  console.log('\n=== 3. 管理者新建客户：可自由指派 ===');
  const assignedByAdmin = await customerService.create({ name: '管理员指派给销售B', ownerId: salesB.id }, admin.id);
  check('管理员可指派给销售B', assignedByAdmin.ownerId === salesB.id, String(assignedByAdmin.ownerId));

  const adminDefault = await customerService.create({ name: '管理员不指派' }, admin.id);
  check('管理员不传时默认自己', adminDefault.ownerId === admin.id, String(adminDefault.ownerId));

  const assignedByGm = await customerService.create({ name: '总经理指派给销售A', ownerId: salesA.id }, gm.id);
  check('总经理可指派给销售A', assignedByGm.ownerId === salesA.id, String(assignedByGm.ownerId));

  console.log('\n=== 4. 编辑时同样收窄（否则"建完再改"就绕过了） ===');
  const ownCustomer = await customerService.create({ name: '销售A自己的客户' }, salesA.id);

  // 销售A 把客户改到自己名下：允许（本来就是自己）
  const keepSelf = await customerService.update(ownCustomer.id, { ownerId: salesA.id }, salesA.id, 'SELF');
  check('销售改到自己名下 → 允许', keepSelf.ownerId === salesA.id, String(keepSelf.ownerId));

  // 销售A 想把客户转给别人：拒绝
  await expectFailure(
    '销售把客户转给他人 → 拒绝',
    () => customerService.update(ownCustomer.id, { ownerId: salesB.id }, salesA.id, 'SELF'),
    '只能是你自己',
  );
  const stillOwn = await prisma.customer.findUniqueOrThrow({ where: { id: ownCustomer.id }, select: { ownerId: true } });
  check('被拒绝后归属未变', stillOwn.ownerId === salesA.id, String(stillOwn.ownerId));

  // 不改 owner 的普通编辑不受影响
  const renamed = await customerService.update(ownCustomer.id, { name: '销售A自己的客户（改名）' }, salesA.id, 'SELF');
  check('只改名称不影响归属', renamed.ownerId === salesA.id && renamed.name.includes('改名'), `${renamed.ownerId} / ${renamed.name}`);

  // 管理者仍可改派
  const reassigned = await customerService.update(ownCustomer.id, { ownerId: salesB.id }, admin.id, 'ALL');
  check('管理员可把客户改派给销售B', reassigned.ownerId === salesB.id, String(reassigned.ownerId));

  console.log('\n=== 5. 数据范围（SELF）与归属规则一致 ===');
  const salesAList = await customerService.list({ page: 1, pageSize: 50 }, salesA.id, 'SELF');
  check(
    '销售A只看得到自己名下的客户',
    salesAList.items.every((item) => item.ownerId === salesA.id),
    salesAList.items.map((item) => item.name).join('、') || '(空)',
  );
  check('被改派给销售B的客户已从销售A列表消失', !salesAList.items.some((item) => item.id === ownCustomer.id));

  const salesBList = await customerService.list({ page: 1, pageSize: 50 }, salesB.id, 'SELF');
  check('销售B看得到改派来的客户', salesBList.items.some((item) => item.id === ownCustomer.id), String(salesBList.total));
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

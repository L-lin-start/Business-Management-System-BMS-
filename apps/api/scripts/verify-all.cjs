/**
 * 一键回归：按顺序跑完全部验证脚本，跑完自动恢复配置数据，任一失败即整体失败。
 *
 * 用法：node scripts/verify-all.cjs
 * 说明：依赖 apps/api/dist 构建产物，正式回归请先执行 `pnpm --filter @bms/api build`。
 *       子进程使用 stdio: 'inherit'，避免在受限环境下因管道权限失败。
 *
 * 为什么跑完要重新播种：
 *   验证脚本为了自包含会清理「自定义字段定义」等数据（否则残留的必填字段会阻塞后续脚本）。
 *   清理后系统会处于"缺配置"状态（界面上自定义字段消失），因此回归结束必须重跑种子，
 *   把角色、权限、字段定义、状态枚举、流程模板恢复到可用基线。
 */
const { spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const SCRIPTS = [
  'verify-document-numbering.cjs',
  'verify-contract-numbering.cjs',
  'verify-numbering-services.cjs',
  'verify-item-count.cjs',
  'verify-payment-allocation.cjs',
  'verify-custom-fields.cjs',
  'verify-customer-owner-policy.cjs',
  'verify-department-delete.cjs',
  'verify-options.cjs',
  'verify-contract-rules.cjs',
  'verify-time-limit.cjs',
  'verify-history-and-locking.cjs',
  'verify-node-assignee.cjs',
  'verify-records.cjs',
  'verify-template-delete.cjs',
  'verify-workflow.cjs',
  'verify-reminders.cjs',
  'verify-export.cjs',
  'verify-delete-rules.cjs',
  'verify-reminder-scope.cjs',
  'verify-user-delete.cjs',
];

const API_ROOT = path.resolve(__dirname, '..');

const summary = [];

for (const script of SCRIPTS) {
  console.log(`\n${'='.repeat(70)}\n▶ ${script}\n${'='.repeat(70)}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    stdio: 'inherit',
    cwd: API_ROOT,
  });
  summary.push({ script, passed: result.status === 0 });
}

// 恢复配置数据基线：验证脚本会清掉自定义字段定义，不重播种子界面会缺配置
console.log(`\n${'='.repeat(70)}\n恢复配置基线（重新播种）\n${'='.repeat(70)}`);
const seedResult = spawnSync(process.execPath, [path.join(API_ROOT, 'prisma', 'seed.ts')], {
  stdio: 'inherit',
  cwd: API_ROOT,
});
const seedOk = seedResult.status === 0;
console.log(seedOk ? '  种子执行完成，配置数据已恢复到可用基线' : `  [警告] 种子执行失败（退出码 ${seedResult.status}），请手动执行 node prisma/seed.ts`);

console.log(`\n${'='.repeat(70)}\n回归结果\n${'='.repeat(70)}`);
for (const item of summary) {
  console.log(`  ${item.passed ? 'PASS' : 'FAIL'}  ${item.script}`);
}
const failed = summary.filter((item) => !item.passed);
const conclusion = `共 ${summary.length} 个脚本，${failed.length} 个失败${seedOk ? '' : '（另：配置恢复失败，需手工播种）'}`;
console.log(`\n${conclusion}`);

// 额外落一份汇总文件，便于在不方便读取终端输出的环境下查看结论
try {
  const lines = summary.map((item) => `${item.passed ? 'PASS' : 'FAIL'}  ${item.script}`).join('\n');
  writeFileSync(
    path.resolve(API_ROOT, '..', '..', 'docs', '回归结果.txt'),
    `回归时间：${new Date().toLocaleString('zh-CN')}\n\n${lines}\n\n${conclusion}\n`,
    'utf8',
  );
} catch {
  // 汇总文件写入失败不影响回归结论
}

if (failed.length > 0 || !seedOk) process.exitCode = 1;

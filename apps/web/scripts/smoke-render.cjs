/**
 * 前端渲染烟测：用与生产一致的编译链把 App.vue 整棵组件树打成 CJS，
 * 再用 vue/server-renderer 真实渲染一次，验证编译产物能正常出 HTML。
 *
 * 只做一次临时构建（写入系统临时目录，不落进仓库）。
 * 用法：node scripts/smoke-render.cjs
 */
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const builder = require('./build-web-rollup.cjs');

const webRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(webRoot, '..', '..');
// 打包产物必须留在工作区内，才能解析 vue / element-plus 这些外部依赖。
const tempDir = path.join(webRoot, '.smoke');
const entryFile = path.join(tempDir, 'entry.js');
const outFile = path.join(tempDir, 'bundle.cjs');

const viteRequire = createRequire(require.resolve('vite', { paths: [webRoot, workspaceRoot] }));
const rollupRequire = createRequire(viteRequire.resolve('rollup'));

async function main() {
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(
    entryFile,
    [
      "import { h } from 'vue';",
      "import { renderToString } from 'vue/server-renderer';",
      "import { createSSRApp } from 'vue';",
      "import ElementPlus from 'element-plus';",
      `import App from ${JSON.stringify(path.join(webRoot, 'src', 'App.vue').split(path.sep).join('/'))};`,
      'export async function render() {',
      '  const app = createSSRApp({ render: () => h(App) });',
      '  app.use(ElementPlus);',
      '  return renderToString(app);',
      '}',
      '',
    ].join('\n'),
  );

  const rollup = await import(pathToFileURL(rollupRequire.resolve('rollup')).href);
  const bundle = await rollup.rollup({
    input: entryFile,
    external: (id) => id === 'vue' || id === 'vue/server-renderer' || id === 'element-plus' || id.startsWith('element-plus/'),
    plugins: builder.buildPlugins(),
    onwarn(warning, warn) {
      if (warning.code === 'CIRCULAR_DEPENDENCY' || warning.code === 'SOURCEMAP_ERROR') return;
      warn(warning);
    },
  });
  await bundle.write({ file: outFile, format: 'cjs', exports: 'named', sourcemap: false });
  await bundle.close();

  // 最小浏览器桩：只补 SSR 缺失的全局对象，用不到真实 DOM。
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  };
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ message: '烟测环境不访问后端' }) });

  const mod = require(outFile);
  const html = await mod.render();

  const checks = [
    ['登录页标题存在', html.includes('业务管理系统')],
    ['账号输入框已渲染', html.includes('账号') || html.includes('用户名')],
    ['密码输入框已渲染', html.includes('密码')],
    ['登录按钮已渲染', html.includes('登') && html.includes('录')],
    ['未出现渲染错误占位', !html.includes('undefined</')],
  ];
  let failures = 0;
  for (const [label, ok] of checks) {
    if (!ok) failures += 1;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
  }
  console.log(`\n渲染输出长度：${html.length} 字符`);
  console.log(html.slice(0, 400).replace(/\s+/g, ' '));

  rmSync(tempDir, { recursive: true, force: true });
  console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('烟测失败:', error);
  rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = 1;
});

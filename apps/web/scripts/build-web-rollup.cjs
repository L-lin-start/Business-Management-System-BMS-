/**
 * 不依赖 esbuild 的前端构建链：Rollup + @vue/compiler-sfc + TypeScript 转译。
 *
 * 背景：`vite build` 与 `@vitejs/plugin-vue` 都依赖 esbuild 子进程（配置打包、Windows realpath
 * 辅助进程、依赖预构建、TS 类型剥离），在受限环境下会 spawn EPERM。这里改用 @vue/compiler-sfc
 * 直接编译单文件组件、TypeScript 的 transpileModule 剥离类型，由 Rollup 打包为 IIFE，
 * Vue 与 Element Plus 通过 CDN 全局变量提供（与 Vite 构建的运行时行为一致）。
 *
 * 用法：node scripts/build-web-rollup.cjs
 */
const { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

const webRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(webRoot, '..', '..');

// rollup 与 @vue/compiler-sfc 都是 vite / @vitejs/plugin-vue 的传递依赖，需要通过它们的解析路径加载。
const viteRequire = createRequire(require.resolve('vite', { paths: [webRoot, workspaceRoot] }));
const rollupRequire = createRequire(viteRequire.resolve('rollup'));
const vuePluginRequire = createRequire(require.resolve('@vitejs/plugin-vue', { paths: [webRoot, workspaceRoot] }));
const compilerSfc = vuePluginRequire('@vue/compiler-sfc');

const distDir = path.join(webRoot, 'dist');
const bootstrapEntry = path.join(webRoot, '.build', 'bootstrap.js');

const EXTERNAL_HINT = /^(element-plus|vue)(\/|$)/;

/** 剥离 TypeScript 类型（保留 ESM 语法）。 */
function stripTypes(code, id) {
  return ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      sourceMap: false,
      jsx: ts.JsxEmit.Preserve,
    },
    fileName: path.basename(id),
  }).outputText;
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** 解析项目内相对导入：补全 .ts / .vue / index.ts。 */
function resolveLocal(source, importer) {
  if (!importer || !source.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importer), source);
  const candidates = [base, `${base}.ts`, `${base}.vue`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.js')];
  for (const candidate of candidates) {
    if (isFile(candidate) && !candidate.endsWith('.d.ts')) return candidate;
  }
  return null;
}

/** 平台内建组件（el-* / ElXxx）由 ElementPlus 全局注册，编译期不做组件解析。 */
function isBuiltinComponent(tag) {
  if (tag === 'component' || tag === 'slot' || tag === 'template') return false;
  return tag.startsWith('el-') || /^El[A-Z]/.test(tag) || tag.startsWith('router-');
}

/** 给 scoped 样式选择器补 [data-v-xxx] 属性。 */
function scopeCss(css, scopeId) {
  return css.replace(/(^|\})\s*([^{}@]+)\{/g, (match, brace, selector) => {
    const scopedSelector = selector
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (item.startsWith('@') ? item : `${item}[${scopeId}]`))
      .join(', ');
    return `${brace}${scopedSelector}{`;
  });
}

const vuePlugin = {
  name: 'bms-vue',
  async resolveId(source, importer) {
    if (EXTERNAL_HINT.test(source)) return { id: source, external: true };
    return resolveLocal(source, importer);
  },
  load(id) {
    if (!id.endsWith('.vue')) return null;
    const source = readFileSync(id, 'utf8');
    const { descriptor, errors } = compilerSfc.parse(source, { filename: id });
    if (errors.length) throw new Error(`解析 ${id} 失败：${errors.map((item) => item.message).join('; ')}`);

    // 作用域 ID 用「完整路径」哈希，避免不同组件取文件名前缀时撞同一个 ID 导致样式互相污染。
    const scopeId = `data-v-${createHash('sha1').update(id).digest('hex').slice(0, 8)}`;
    const hasScoped = descriptor.styles.some((style) => style.scoped);

    const script = compilerSfc.compileScript(descriptor, {
      id: scopeId,
      // 内联模板：让模板编译器拿到 <script setup> 的绑定分析，本地组件（LoginView 等）
      // 才能被正确内联，否则会被当成未解析组件（resolveComponent 失败）。
      inlineTemplate: true,
      isProd: true,
    });

    if (!descriptor.scriptSetup) {
      throw new Error(`${id} 未使用 <script setup>，当前构建链暂不支持其它写法`);
    }

    // 与官方 @vitejs/plugin-vue 一致：把 `export default` 改写为 `_sfc_main` 变量，
    // 便于附加 __scopeId 并在末尾重新导出。rewriteDefault 内部用 babel 解析，
    // 需显式声明 typescript 插件（输出里保留了 `!` 非空断言）。
    let code = compilerSfc.rewriteDefault(script.content, '_sfc_main', ['typescript']);
    code = stripTypes(code, id);
    if (hasScoped) code += `\n_sfc_main.__scopeId = ${JSON.stringify(scopeId)};\n`;
    code += `\nexport default _sfc_main;\n`;

    const styles = descriptor.styles
      .map((style) => (style.scoped ? scopeCss(style.content, scopeId) : style.content))
      .filter(Boolean);
    if (styles.length) {
      // 惰性注入：只在浏览器环境写入 <style>，SSR / 构建期不触碰 document。
      code +=
        `\n;(function(){if(typeof document==='undefined')return;` +
        `const css=${JSON.stringify(styles.join('\n'))};` +
        `const el=document.createElement('style');el.setAttribute('data-vue-style',${JSON.stringify(id)});` +
        `el.textContent=css;document.head.appendChild(el);})();\n`;
    }

    return { code, map: null };
  },
};

const typescriptPlugin = {
  name: 'bms-typescript',
  transform(code, id) {
    if (id.endsWith('.ts') && !id.endsWith('.d.ts')) return { code: stripTypes(code, id), map: null };
    return null;
  },
};

const envPlugin = {
  name: 'bms-import-meta-env',
  transform(code) {
    if (!code.includes('import.meta.env')) return null;
    return { code: code.replace(/import\.meta\.env\.MODE/g, JSON.stringify('production')), map: null };
  },
};

/** 收集样式 */
const collectedCss = { global: '', vendor: '' };

/**
 * 处理 CSS 导入：Rollup 默认不认 CSS，会把 `import './styles.css'` 当成空模块丢掉
 * （全局样式会静默失效）。这里把样式收集起来，构建结束后写入 dist/css/*.css，
 * 并在 index.html 里用 <link> 引入。
 */
const cssPlugin = {
  name: 'bms-css',
  resolveId(source, importer) {
    if (!source.endsWith('.css')) return null;
    if (source.startsWith('element-plus/')) return { id: `\0vendor-css:${source}`, external: false };
    if (source.startsWith('.')) return resolveLocal(source, importer) ?? null;
    return null;
  },
  load(id) {
    if (id.startsWith('\0vendor-css:')) {
      const specifier = id.slice('\0vendor-css:'.length);
      const resolved = require.resolve(specifier, { paths: [webRoot, workspaceRoot] });
      collectedCss.vendor += readFileSync(resolved, 'utf8');
      return 'export default {};';
    }
    if (id.endsWith('.css')) {
      collectedCss.global += readFileSync(id, 'utf8');
      return 'export default {};';
    }
    return null;
  },
};

/** 把收集到的样式写进 dist/css，并生成 <link> 标签。 */
function emitCss() {
  const cssDir = path.join(distDir, 'css');
  mkdirSync(cssDir, { recursive: true });
  const links = [];

  const groups = [
    { name: 'vendor.css', content: collectedCss.vendor },
    { name: 'app.css', content: collectedCss.global },
  ];

  for (const group of groups) {
    if (!group.content.trim()) continue;
    writeFileSync(path.join(cssDir, group.name), group.content);
    links.push(`<link rel="stylesheet" href="./css/${group.name}" />`);
  }

  return { links, sizes: groups.map((group) => [group.name, group.content.length]) };
}

/** 解析运行时依赖（vue / element-plus）的 UMD 脚本，复制到 dist/vendor，使产物离线自包含。 */
function copyVendorAssets() {
  const vendorDir = path.join(distDir, 'vendor');
  mkdirSync(vendorDir, { recursive: true });

  const copies = [
    { specifier: 'vue/dist/vue.global.prod.js', filename: 'vue.global.prod.js' },
    { specifier: 'element-plus/dist/index.full.min.js', filename: 'element-plus.full.min.js' },
  ];

  for (const item of copies) {
    const resolved = require.resolve(item.specifier, { paths: [webRoot, workspaceRoot] });
    cpSync(resolved, path.join(vendorDir, item.filename));
  }
  return copies.map((item) => item.filename);
}

function writePreviewIndexHtml(vendorFiles, cssLinks) {
  const scripts = vendorFiles
    .map((file) => `    <script src="./vendor/${file}"></script>`)
    .join('\n');

  const styles = cssLinks.join('\n');

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="业务管理系统" />
    <title>业务管理系统</title>
${styles}
  </head>
  <body>
    <div id="app"></div>
${scripts}
    <script src="./app.js"></script>
  </body>
</html>
`;
  writeFileSync(path.join(distDir, 'index.html'), html);
}

async function main() {
  const rollup = await import(pathToFileURL(rollupRequire.resolve('rollup')).href);

  mkdirSync(path.dirname(bootstrapEntry), { recursive: true });
  writeFileSync(
    bootstrapEntry,
    [
      "import { createApp } from 'vue';",
      "import ElementPlus from 'element-plus';",
      "import 'element-plus/dist/index.css';",
      "import '../src/styles.css';",
      "import App from '../src/App.vue';",
      'const app = createApp(App);',
      'app.use(ElementPlus);',
      "app.mount('#app');",
      '',
    ].join('\n'),
  );

  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  const bundle = await rollup.rollup({
    input: bootstrapEntry,
    // 注意：CSS 不能走 external，否则样式会被直接丢弃（不会进入任何 load 钩子）。
    external: (id) => !id.endsWith('.css') && EXTERNAL_HINT.test(id),
    // cssPlugin 必须排在 vuePlugin 之前：否则 `element-plus/dist/index.css` 会先被
    // external 规则判定为外部依赖，样式就收不到了。
    plugins: [cssPlugin, vuePlugin, typescriptPlugin, envPlugin],
    onwarn(warning, warn) {
      if (warning.code === 'CIRCULAR_DEPENDENCY' || warning.code === 'SOURCEMAP_ERROR') return;
      warn(warning);
    },
  });

  await bundle.write({
    file: path.join(distDir, 'app.js'),
    format: 'iife',
    name: 'BmsApp',
    globals: { vue: 'Vue', 'element-plus': 'ElementPlus' },
    sourcemap: false,
    banner: '/* 业务管理系统前端产物：Rollup + @vue/compiler-sfc 构建 */',
  });
  await bundle.close();

  const vendorFiles = copyVendorAssets();
  const { links, sizes } = emitCss();
  writePreviewIndexHtml(vendorFiles, links);
  rmSync(path.join(webRoot, '.build'), { recursive: true, force: true });

  if (!collectedCss.vendor.trim()) {
    throw new Error('未收集到 Element Plus 样式，产物会缺失基础组件样式');
  }
  if (!collectedCss.global.trim()) {
    throw new Error('未收集到 src/styles.css，全局样式会失效');
  }

  const size = readFileSync(path.join(distDir, 'app.js')).length;
  const cssSummary = sizes.filter(([, bytes]) => bytes > 0).map(([name, bytes]) => `${name} ${(bytes / 1024).toFixed(0)}KB`).join(' + ');
  console.log(`前端构建完成：dist/app.js（${(size / 1024).toFixed(0)} KB）+ index.html + vendor（${vendorFiles.length}）+ css（${cssSummary || '无'}）`);
}

// 仅在直接执行时构建；被其它脚本 require 时只导出编译链插件。
if (require.main === module) {
  main().catch((error) => {
    console.error('前端构建失败:', error);
    process.exitCode = 1;
  });
}

/** 供其它脚本（如渲染烟测）复用的编译链插件。 */
module.exports = { buildPlugins: () => [cssPlugin, vuePlugin, typescriptPlugin, envPlugin] };

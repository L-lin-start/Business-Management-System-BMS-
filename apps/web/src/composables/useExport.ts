/**
 * 数据导出（PRD 4.12）。
 *
 * ## 为什么不用 `window.open` 或直接挂 `<a href>`
 *
 * 导出接口需要 `Authorization: Bearer` 头，而浏览器直接跳转链接不会带自定义头，
 * 结果是 401。因此这里改成 `fetch` 拿二进制 → 造 Blob → 触发下载。
 * 代价是文件先落到内存，但导出的数据量（列表页筛选结果）完全可接受。
 *
 * ## 为什么从响应头取文件名
 *
 * 后端用 `Content-Disposition` 同时给出 ASCII 兜底名与 RFC 5987 的 `filename*`，
 * 后者是 UTF-8 编码的中文名。前端解析 `filename*` 才能拿到「合同导出.csv」这样的
 * 中文名，否则会变成一串下划线。
 */

import { ref } from 'vue';
import { ElMessage } from 'element-plus';

export type ExportModule = 'customer' | 'contract' | 'project' | 'payment' | 'cost';

/**
 * 各模块导出所需的权限码 —— **必须与后端 `export-definitions.ts` 保持一致**。
 *
 * 回款用 `payment.manage`：回款没有独立的 export 权限点（种子里有意收敛掉了），
 * 所以"能登记回款"即"能导出回款"。
 */
export const EXPORT_PERMISSIONS: Record<ExportModule, string[]> = {
  customer: ['customer.export'],
  contract: ['contract.export'],
  project: ['project.export'],
  payment: ['payment.manage'],
  cost: ['cost.export'],
};

/**
 * 判断当前用户能否导出某模块。
 *
 * 之所以做成"判定函数"而不是每页一个 computed：
 *   - 判定规则只有一处，不会出现合同页允许、回款页不允许这类分叉
 *   - 这套规则需要与后端逐字一致，集中一处才好核对
 *
 * 注意**不能**用"拥有任意一个 .export 权限就都显示"这种粗粒度写法：
 * 曾因此让只有 cost.export 的账号在合同页也看到导出按钮，点了才 403。
 */
export function canExportModule(permissions: readonly string[] | undefined, isSystemAdmin: boolean | undefined, module: ExportModule): boolean {
  if (isSystemAdmin) return true; // 与后端 resolveScope 的管理员放行一致
  const required = EXPORT_PERMISSIONS[module];
  const granted = permissions ?? [];
  return required.some((code) => granted.includes(code));
}

/** 从 Content-Disposition 里取文件名（优先 RFC 5987 的 filename*） */export function parseFilename(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      /* 编码异常时退回下面的 ASCII 名 */
    }
  }
  const plain = /filename="([^"]*)"/i.exec(disposition);
  return plain?.[1] || fallback;
}

/** 触发浏览器下载 */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 交给下一轮事件循环释放，避免某些浏览器在下载开始前就回收 URL
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param token   当前登录令牌
 * @param module  导出模块（决定接口路径与后端权限校验）
 * @param label   提示语里用的中文名，如「合同」
 */
export function useExport(token: string | (() => string), module: ExportModule, label: string) {
  const exporting = ref(false);

  /**
   * @param query 与列表页相同的筛选条件 —— 保证"界面筛什么，导出就是什么"
   */
  async function exportData(query: Record<string, string> = {}) {
    if (exporting.value) return;
    exporting.value = true;
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') params.set(key, value);
      }
      const suffix = params.toString();
      const currentToken = typeof token === 'function' ? token() : token;
      const response = await fetch(`/api/export/${module}${suffix ? `?${suffix}` : ''}`, {
        headers: { Authorization: `Bearer ${currentToken}` },
      });

      if (!response.ok) {
        // 后端在无权限时返回 JSON，这里尽量把原因读出来（403 时"无权导出"比"导出失败"有用得多）
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message ?? `导出失败（HTTP ${response.status}）`);
      }

      const blob = await response.blob();
      const rows = response.headers.get('X-Export-Rows');
      const filename = parseFilename(response.headers.get('Content-Disposition'), `${label}导出`);
      saveBlob(blob, filename);
      ElMessage.success(rows === null ? `${label}已开始下载` : `已导出 ${rows} 条${label}记录`);
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : `${label}导出失败`);
    } finally {
      exporting.value = false;
    }
  }

  return { exporting, exportData };
}

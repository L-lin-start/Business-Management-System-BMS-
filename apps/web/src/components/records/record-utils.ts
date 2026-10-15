/**
 * 附属业务数据面板的共用工具。
 *
 * 这些面板（官文 / 邮件送达 / 动作记录 / 申报结果）都要做同一件事：
 * 带令牌请求接口、把日期按本地日历格式化、把选项**编码翻成中文标签**。
 * 抽出来避免四个组件各抄一份。
 */
import { ref } from 'vue';
import { toCalendarDateText } from '../../utils/calendar-date';

/**
 * 接口错误：带上 HTTP 状态码。
 *
 * 为什么需要：后端对「没权限(403)」和「记录不存在(404)」返回不同文案，
 * 但界面如果只显示一句「加载失败」，排查时根本分不清是权限问题还是数据问题
 * （曾经把 404 显示成「项目不存在或已删除」，让人以为是数据被删了）。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 带令牌的 JSON 请求；失败时抛出带状态码的错误，文案优先用后端返回的中文提示 */
export async function apiRequest<T>(token: string, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = Array.isArray(payload?.message) ? payload.message.join('；') : payload?.message;
    throw new ApiError(message ?? `请求失败（HTTP ${response.status}）`, response.status);
  }
  return payload as T;
}

/** 把错误整理成给用户看的一句话（含状态码，便于区分 403 权限 / 404 数据） */
export function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return `${fallback}（HTTP ${error.status}）：${error.message}`;
  if (error instanceof Error) return `${fallback}：${error.message}`;
  return fallback;
}

/**
 * 日期展示：后端返回的是 UTC ISO 串，必须按**本地日历**格式化，
 * 不能直接 slice(0,10)（UTC+8 下会差一天）。
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const text = toCalendarDateText(value);
  return text || '-';
}

/** 日期时间展示（登记时间这类需要精确到分的场景） */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

type OptionItem = { code: string; label: string };

/**
 * 选项编码 → 中文标签。
 *
 * 数据库里存的是编码（如 `OFFICE_ACTION`），表格里必须显示中文（「审查意见通知书」），
 * 否则界面上会露出内部编码。这里加载一次选项列表并缓存，多个面板可各持一份。
 */
export function useOptionLabels(token: string, moduleKeys: string[]) {
  const cache = ref<Record<string, string>>({});

  async function load() {
    const results = await Promise.all(
      moduleKeys.map(async (key) => {
        try {
          const items = await apiRequest<OptionItem[]>(token, `/api/options/list/${key}`);
          return [key, items] as const;
        } catch {
          return [key, [] as OptionItem[]] as const;
        }
      }),
    );
    const next: Record<string, string> = {};
    for (const [, items] of results) {
      for (const item of items) next[item.code] = item.label;
    }
    cache.value = next;
  }

  /** 找不到映射时回退为原值，这样历史编码也能看见，不会显示成空白 */
  function labelOf(code: string | null | undefined): string {
    if (!code) return '-';
    return cache.value[code] ?? code;
  }

  return { labelOf, load };
}

/**
 * 该模块在系统 B 里有没有配置**自定义字段**。
 *
 * 用途：面板的弹窗里要决定是否显示「自定义字段」分割线 /
 * 表格是否需要给自定义列留位置。没有任何自定义字段时不应出现空的分割线。
 *
 * 说明：这里单独查一次字段定义，而不是让 `CustomFieldForm` 抛出 loaded 事件 ——
 * 那个组件是项目/合同/客户等模块共用的，为了一个分割线去改它不划算。
 */
export function useCustomFieldPresence(token: string, moduleKey: string) {
  const hasCustomFields = ref(false);

  async function load() {
    try {
      const fields = await apiRequest<Array<{ fieldKey: string }>>(token, `/api/options/fields/${moduleKey}`);
      hasCustomFields.value = fields.length > 0;
    } catch {
      hasCustomFields.value = false;
    }
  }

  return { hasCustomFields, load };
}

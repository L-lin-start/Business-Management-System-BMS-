/**
 * 前端日期工具：处理"日历日"与后端 UTC ISO 串之间的换算。
 *
 * 背景：后端把日期按**本地零点**存库，序列化成 JSON 会变成 UTC ISO 串。
 * 例如本地 2026-09-01 00:00（UTC+8）→ `2026-08-31T16:00:00.000Z`。
 *
 * 因此**绝不能**对 ISO 串做 `slice(0, 10)` 取日期 —— 那会得到 8 月 31 日，差一天。
 * 正确做法是先用 Date 解析（自动转本地时区），再按本地年月日取值。
 */

/** 本地时区的 Date → 'YYYY-MM-DD'（用于回填日期选择器、提交表单） */
export function toCalendarDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 后端返回的日期字段 → 'YYYY-MM-DD'。
 * 兼容 null / undefined / 空串；非法值原样返回，避免静默丢失数据。
 */
export function toCalendarDateText(value: string | null | undefined): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return toCalendarDate(parsed);
}

/** 今天（本地）的 'YYYY-MM-DD'，用于表单默认值 */
export function todayCalendarDate(): string {
  return toCalendarDate(new Date());
}

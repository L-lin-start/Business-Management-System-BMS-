/**
 * CSV 导出工具。
 *
 * ## 为什么不引第三方库
 *
 * 需求只是「把若干行对象写成可被 Excel 打开的表格」，用 `csv` / `exceljs` 这类库属于
 * 为一件小事增加一个长期依赖。这里手工实现，并把几个**必须处理对的细节**固定下来：
 *
 * 1. **BOM 头**：Excel 打开 UTF-8 CSV 时若没有 BOM，中文会变乱码。
 *    因此内容以 `\uFEFF` 开头。
 * 2. **逗号/引号/换行转义**：按 RFC 4180，字段含 `,` `"` 换行时用双引号包裹，
 *    内部的双引号写成两个。
 * 3. **公式注入防护**：单元格以 `=` `+` `-` `@` 开头时，Excel 会当公式执行。
 *    导出内容包含用户输入（客户名、备注等），因此统一加前导单引号，
 *    避免"打开导出的表格就执行了公式"。
 * 4. **换行统一用 CRLF**：Excel 对 LF 的兼容性不如 CRLF。
 */

/** 需要防公式注入的前导字符 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * 纯数值文本（可含负号、小数）。
 *
 * 这类值**不可能是公式**，必须原样输出：
 * 若给 `-2000.00` 加前导单引号，Excel 会把它当文本，金额列就无法求和了。
 */
const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

/** 单个字段转成 CSV 单元格 */
export function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // 公式注入防护：前置单引号让 Excel 当纯文本（纯数值豁免，否则负数金额会变文本）
  if (!NUMERIC_TEXT.test(text) && FORMULA_PREFIX.test(text)) text = `'${text}`;
  // 含分隔符/引号/换行时用引号包裹，内部引号翻倍
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export type CsvColumn<T> = {
  /** 列标题（导出后的表头） */
  header: string;
  /** 取值函数；返回 null/undefined 会被写成空单元格 */
  value: (row: T) => unknown;
};

/**
 * 把数据行转成 CSV 文本。
 *
 * @param columns 列定义（决定导出哪些字段、顺序、以及如何取值）
 * @param rows    数据行
 * @param options.includeHeader 是否输出表头（默认 true）
 */
export function toCsv<T>(columns: Array<CsvColumn<T>>, rows: T[], options: { includeHeader?: boolean } = {}): string {
  const lines: string[] = [];
  if (options.includeHeader !== false) {
    lines.push(columns.map((column) => toCsvCell(column.header)).join(','));
  }
  for (const row of rows) {
    lines.push(columns.map((column) => toCsvCell(column.value(row))).join(','));
  }
  // BOM + CRLF：保证 Excel 双击打开不乱码、不串行
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * 生成下载用的文件名。
 *
 * 遵循 RFC 5987：HTTP 头里非 ASCII 文件名要 URL 编码后放在 `filename*`，
 * 同时给一个 ASCII 的 `filename` 兜底，兼容老浏览器。
 */
export function buildContentDisposition(filename: string, inline = false): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `${inline ? 'inline' : 'attachment'}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/** 导出文件名里的时间戳：20261014-1530 */
export function exportStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

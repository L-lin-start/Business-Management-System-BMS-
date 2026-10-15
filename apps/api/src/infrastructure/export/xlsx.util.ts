/**
 * 最小 XLSX 生成器（零第三方依赖）。
 *
 * ## 为什么手写
 *
 * 导出功能只需要"把表格写成 Excel 能打开的文件"。引 `exceljs`（约 2 MB 依赖）为一个
 * 单表导出服务，代价过大。xlsx 本质是一个 ZIP，里面放几个固定结构的 XML，
 * 因此这里用 Node 自带的 `zlib` 做 deflate、手写 ZIP 中央目录，直接产出合规文件。
 *
 * ## 支持范围（够用即可）
 *
 * - 单个工作表
 * - 表头加粗冻结首行
 * - 单元格自动判定数字/文本（金额以数字写入，Excel 可直接求和）
 * - 字符串走 `inlineStr`，不需要共享字符串表
 *
 * ## 不支持（明确不做）
 *
 * - 多工作表、公式、样式主题、图表、条件格式
 * - 读取（这是只写实现）
 */

import { deflateRawSync } from 'node:zlib';

/** 一个待写入的单元格 */
export type XlsxCell = string | number | null | undefined;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 不允许的控制字符，直接剔除，否则 Excel 会报文件损坏
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** 0 → A，25 → Z，26 → AA */
function columnName(index: number): string {
  let name = '';
  let current = index + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

type ZipEntry = { name: string; data: Buffer };

/** 按 ZIP（store + deflate）格式打包；文件名均为 ASCII，无需 UTF-8 标志 */
function buildZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'ascii');
    const deflated = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 需要的解压版本
    local.writeUInt16LE(0, 6); // 通用标志
    local.writeUInt16LE(8, 8); // 压缩方法：deflate
    local.writeUInt16LE(0, 10); // 修改时间
    local.writeUInt16LE(0x21, 12); // 修改日期（固定值，保证产物可复现）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28); // 额外字段长度

    chunks.push(local, nameBuffer, deflated);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
    centralEntry.writeUInt16LE(20, 4); // 创建版本
    centralEntry.writeUInt16LE(20, 6); // 需要版本
    centralEntry.writeUInt16LE(0, 8);
    centralEntry.writeUInt16LE(8, 10);
    centralEntry.writeUInt16LE(0, 12);
    centralEntry.writeUInt16LE(0x21, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(deflated.length, 20);
    centralEntry.writeUInt32LE(entry.data.length, 24);
    centralEntry.writeUInt16LE(nameBuffer.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt16LE(0, 36);
    centralEntry.writeUInt32LE(0, 38); // 外部属性
    centralEntry.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(centralEntry, nameBuffer);

    offset += local.length + nameBuffer.length + deflated.length;
  }

  const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 中央目录结束记录
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, end]);
}

function sheetXml(headers: string[], rows: XlsxCell[][]): string {
  const rowXml: string[] = [];

  const headerCells = headers
    .map((header, index) => `<c r="${columnName(index)}1" s="1" t="inlineStr"><is><t>${escapeXml(header)}</t></is></c>`)
    .join('');
  rowXml.push(`<row r="1">${headerCells}</row>`);

  rows.forEach((row, rowIndex) => {
    const excelRow = rowIndex + 2;
    const cells = row
      .map((cell, columnIndex) => {
        const ref = `${columnName(columnIndex)}${excelRow}`;
        if (cell === null || cell === undefined || cell === '') return '';
        if (typeof cell === 'number' && Number.isFinite(cell)) {
          return `<c r="${ref}"><v>${cell}</v></c>`;
        }
        // 纯数字文本（如编号 "001"）按文本写，避免丢前导零
        return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(String(cell))}</t></is></c>`;
      })
      .join('');
    rowXml.push(`<row r="${excelRow}">${cells}</row>`);
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${rowXml.join('')}</sheetData></worksheet>`;
}

/**
 * 生成 xlsx 文件内容。
 *
 * @param sheetName 工作表名（非法字符会被替换，Excel 限制 31 字符）
 */
export function buildXlsx(sheetName: string, headers: string[], rows: XlsxCell[][]): Buffer {
  const safeSheetName = (sheetName || 'Sheet1').replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet1';

  const entries: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        'utf8',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        'utf8',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'utf8',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        'utf8',
      ),
    },
    {
      // 仅定义两个样式：0 = 默认，1 = 表头（加粗）
      name: 'xl/styles.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
        'utf8',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${sheetXml(headers, rows)}`, 'utf8'),
    },
  ];

  return buildZip(entries);
}

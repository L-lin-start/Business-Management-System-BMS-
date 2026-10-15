import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export const DOCUMENT_NUMBER_PREFIX = {
  payment: 'HK',
  feedback: 'FK',
} as const;

export const DOCUMENT_SEQUENCE_PAD = 3;

const ALLOCATE_RETRY = 5;

type AllocateInput = {
  scope: string;
  prefix: string;
  year: number;
  /** 校验生成的编号是否未被占用；返回 true 表示可用。 */
  isAvailable?: (value: string) => Promise<boolean>;
};

type AllocateResult = {
  value: string;
  sequence: number;
  year: number;
};

type CounterRow = { lastValue: number };

/**
 * 单据编号分配器。
 *
 * 回款等系统单据使用 `前缀 + 年份 + 定长顺序号`，按年份独立计数。
 * 合同编号由人工填写；项目编号由合同号派生，规则为 `合同号-序号`，不经过本分配器。
 *
 * 顺序号存放在 DocumentSequence 计数表，通过 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
 * 在单条语句内原子自增：并发登记时 PostgreSQL 会对该行加锁串行化，因此不会重号。
 * 这里刻意使用原始 SQL 而不是 Prisma 模型委托，保证新增计数表后无需重新生成 Client 即可运行。
 */
@Injectable()
export class DocumentNumberService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 为仍使用系统流水号的单据分配下一编号，例如回款单 HK2026001。 */
  async allocate(input: AllocateInput): Promise<AllocateResult> {
    this.assertPrefix(input.prefix);

    for (let attempt = 0; attempt < ALLOCATE_RETRY; attempt += 1) {
      const rows = await this.prisma.$queryRaw<CounterRow[]>`
        INSERT INTO "DocumentSequence" ("id", "scope", "prefix", "year", "lastValue", "updatedAt")
        VALUES (gen_random_uuid()::text, ${input.scope}, ${input.prefix}, ${input.year}, 1, CURRENT_TIMESTAMP)
        ON CONFLICT ("scope", "prefix", "year")
        DO UPDATE SET "lastValue" = "DocumentSequence"."lastValue" + 1, "updatedAt" = CURRENT_TIMESTAMP
        RETURNING "lastValue"
      `;
      const sequence = Number(rows[0]?.lastValue ?? 0);
      if (!sequence) throw new InternalServerErrorException('编号分配失败，请重试');

      const value = this.format(input.prefix, input.year, sequence);
      if (!input.isAvailable || (await input.isAvailable(value))) {
        return { value, sequence, year: input.year };
      }
    }

    throw new InternalServerErrorException(`编号生成失败（${input.prefix}${input.year}），请重试`);
  }

  /** 只读预览下一个编号，不占用流水号。 */
  async preview(input: { scope: string; prefix: string; year: number }): Promise<string> {
    this.assertPrefix(input.prefix);
    const rows = await this.prisma.$queryRaw<CounterRow[]>`
      SELECT "lastValue" FROM "DocumentSequence"
      WHERE "scope" = ${input.scope} AND "prefix" = ${input.prefix} AND "year" = ${input.year}
    `;
    return this.format(input.prefix, input.year, Number(rows[0]?.lastValue ?? 0) + 1);
  }

  /** 项目编号 = 人工合同号 + 序号，例如 HT-2026-001-1。 */
  buildProjectNo(contractNo: string, sequence: number): string {
    return `${contractNo}-${sequence}`;
  }

  /** 单据编号所属年份：有业务日期用业务日期年份，否则用当前年份。 */
  resolveYear(businessDate?: string | Date | null): number {
    if (businessDate) {
      const parsed = businessDate instanceof Date ? businessDate : new Date(businessDate);
      if (!Number.isNaN(parsed.getTime())) return parsed.getUTCFullYear();
    }
    return new Date().getUTCFullYear();
  }

  isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private format(prefix: string, year: number, sequence: number): string {
    return `${prefix}${year}${String(sequence).padStart(DOCUMENT_SEQUENCE_PAD, '0')}`;
  }

  private assertPrefix(prefix: string) {
    if (!/^[A-Z][A-Z0-9]{0,7}$/.test(prefix)) {
      throw new InternalServerErrorException(`单据编号前缀不合法：${prefix}`);
    }
  }
}

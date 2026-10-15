<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

type Reminder = {
  id: string;
  type: 'CONTRACT_DEADLINE' | 'INTERNAL_SAFETY' | 'NODE_OVERDUE' | 'PAYMENT_PENDING';
  sourceType: 'Contract' | 'Project';
  sourceId: string;
  sourceNo: string | null;
  title: string;
  detail: string | null;
  triggerAt: string;
  dueAt: string;
  overdueDays: number;
  daysRemaining: number;
  isOverdue: boolean;
  isHandled: boolean;
  handledAt: string | null;
  handleNote: string | null;
  handledBy: { id: string; displayName: string } | null;
  /** 分级预警档位（PRD 4.7） */
  alertLevel: 'NORMAL' | 'NOTICE' | 'WARNING' | 'URGENT' | 'OVERDUE';
  tierDays: number | null;
};

const props = defineProps<{ token: string; canViewMail?: boolean; dataScope?: string | undefined }>();
const emit = defineEmits<{ navigate: [payload: { target: string; keyword?: string; needsMail?: boolean }] }>();

/**
 * 范围说明文案。
 *
 * 提醒按角色的数据范围收窄（销售只看自己名下、节点负责人只看与自己相关的），
 * 因此不同账号看到的条数不同。界面上必须说清楚，否则用户会以为系统漏了数据。
 */
const scopeHint = computed(() => {
  switch (props.dataScope) {
    case 'ALL':
      return '';
    case 'SELF':
      return '当前账号只能看到自己名下的项目与合同的提醒。';
    case 'RELATED':
      return '当前账号只能看到与自己相关的项目提醒（你是项目负责人，或当前节点归你办）。';
    case 'DEPARTMENT':
    case 'DEPARTMENT_AND_DESCENDANTS':
      return '当前账号只能看到本部门的项目与合同的提醒。';
    case 'NONE':
      return '当前账号没有数据范围，看不到任何提醒。';
    default:
      return '';
  }
});

const loading = ref(false);
const scanning = ref(false);
const reminders = ref<Reminder[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const summary = reactive({ unhandled: 0, overdue: 0, handled: 0 });
const mailPendingCount = ref(0);
const query = reactive({ isHandled: 'false', type: '' });

const typeOptions = [
  { value: 'CONTRACT_DEADLINE', label: '合同法定截止日' },
  { value: 'INTERNAL_SAFETY', label: '内部安全日' },
  { value: 'NODE_OVERDUE', label: '流程节点超期' },
  { value: 'PAYMENT_PENDING', label: '待回款合同' },
];

const overdueCount = computed(() => reminders.value.filter((item) => !item.isHandled && item.isOverdue).length);

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}`, ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? '请求失败');
  return payload as T;
}

async function loadReminders(options: { scan?: boolean } = {}) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize.value) });
    if (query.isHandled) params.set('isHandled', query.isHandled);
    if (query.type) params.set('type', query.type);
    params.set('scan', options.scan === false ? 'false' : 'true');

    const result = await request<{
      items: Reminder[];
      total: number;
      summary: { unhandled: number; overdue: number; handled: number };
    }>(`/api/reminders?${params.toString()}`);
    reminders.value = result.items;
    total.value = result.total;
    Object.assign(summary, result.summary);
    if (props.canViewMail) {
      const mailSummary = await request<{ overdueMailRegistrations: number }>('/api/reminders/prd-summary');
      mailPendingCount.value = mailSummary.overdueMailRegistrations;
    } else {
      mailPendingCount.value = 0;
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '提醒加载失败');
  } finally {
    loading.value = false;
  }
}

function openMailRegistration() {
  emit('navigate', { target: '项目', needsMail: true });
}

/** 手动触发一次扫描：合同/项目日期改动后不必等定时任务 */
async function scanNow() {
  scanning.value = true;
  try {
    const result = await request<{ created: number; refreshed: number; cleaned: number; unhandled: number }>('/api/reminders/scan', {
      method: 'POST',
    });
    ElMessage.success(`扫描完成：新增 ${result.created} 条，更新 ${result.refreshed} 条，清理 ${result.cleaned} 条`);
    await loadReminders({ scan: false });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '扫描失败');
  } finally {
    scanning.value = false;
  }
}

async function handleReminder(reminder: Reminder) {
  let note = '';
  try {
    const result = await ElMessageBox.prompt('请填写处理说明（会记入操作日志）', `处理提醒：${reminder.title}`, {
      confirmButtonText: '确认已处理',
      cancelButtonText: '取消',
      inputPlaceholder: '例如：已电话催办，客户承诺本周回复',
      inputValidator: (value: string) => (value && value.trim().length > 0 ? true : '请填写处理说明'),
    });
    note = result.value.trim();
  } catch {
    return;
  }

  try {
    await request(`/api/reminders/${reminder.id}/handle`, { method: 'POST', body: JSON.stringify({ note }) });
    ElMessage.success('已标记为处理');
    await loadReminders({ scan: false });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '处理失败');
  }
}

async function unhandleReminder(reminder: Reminder) {
  try {
    await ElMessageBox.confirm(`确定把「${reminder.title}」恢复为未处理吗？`, '取消处理', {
      confirmButtonText: '恢复未处理',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    await request(`/api/reminders/${reminder.id}/unhandle`, { method: 'POST' });
    ElMessage.success('已恢复为未处理');
    await loadReminders({ scan: false });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败');
  }
}

/** 点提醒跳到对应对象：合同去合同页，项目去项目页并带上编号定位 */
function openSource(reminder: Reminder) {
  if (!reminder.sourceNo) return;
  emit('navigate', {
    target: reminder.sourceType === 'Contract' ? '合同' : '项目',
    keyword: reminder.sourceNo,
  });
}

function typeLabel(type: Reminder['type']) {
  return typeOptions.find((item) => item.value === type)?.label ?? type;
}

function typeTagType(type: Reminder['type']) {
  if (type === 'CONTRACT_DEADLINE') return 'warning';
  if (type === 'INTERNAL_SAFETY') return 'primary';
  if (type === 'PAYMENT_PENDING') return 'success';
  return 'danger';
}

/** 分级预警档位 → 展示配置（PRD 4.7） */
const ALERT_LEVEL_META: Record<Reminder['alertLevel'], { label: string; type: 'info' | 'primary' | 'warning' | 'danger' }> = {
  NORMAL: { label: '正常', type: 'info' },
  NOTICE: { label: '提示', type: 'info' },
  WARNING: { label: '警告', type: 'warning' },
  URGENT: { label: '紧急', type: 'danger' },
  OVERDUE: { label: '已逾期', type: 'danger' },
};

function alertMeta(level: Reminder['alertLevel']) {
  return ALERT_LEVEL_META[level] ?? ALERT_LEVEL_META.NORMAL;
}

function dueText(reminder: Reminder) {
  const date = new Date(reminder.dueAt).toLocaleDateString('zh-CN');
  if (reminder.isHandled) return `到期 ${date}`;
  if (reminder.overdueDays > 0) return `已逾期 ${reminder.overdueDays} 天（${date}）`;
  if (reminder.daysRemaining === 0) return `今天到期（${date}）`;
  return `还有 ${reminder.daysRemaining} 天（${date}）`;
}

function handleFilterChange() {
  page.value = 1;
  void loadReminders({ scan: false });
}

onMounted(() => void loadReminders());
</script>

<template>
  <div class="page-heading">
    <div>
      <p class="eyebrow">系统 A · 提醒中心</p>
      <h1>提醒</h1>
      <p class="subtitle">合同法定截止日、内部安全日、流程节点超期的统一提醒。提前提醒天数与保留周期在「管理系统 → 提醒配置」中调整。</p>
      <!--
        范围说明：提醒按角色数据范围收窄（销售只看自己名下、节点负责人只看与自己相关的），
        但界面上本来没有任何提示，用户会以为"数据少了/漏了"。这里明说一句。
      -->
      <p v-if="scopeHint" class="scope-hint">{{ scopeHint }}</p>
    </div>
    <div class="page-actions">
      <el-button v-if="props.canViewMail" :type="mailPendingCount > 0 ? 'warning' : 'default'" @click="openMailRegistration">
        待邮件登记（{{ mailPendingCount }}）
      </el-button>
      <el-button type="primary" :loading="scanning" @click="scanNow">立即扫描</el-button>
    </div>
  </div>

  <el-row :gutter="16" class="summary-row">
    <el-col :xs="24" :sm="8">
      <el-card shadow="never" class="summary-card">
        <span class="summary-label">未处理</span>
        <strong>{{ summary.unhandled }}</strong>
        <small>需要跟进的提醒总数</small>
      </el-card>
    </el-col>
    <el-col :xs="24" :sm="8">
      <el-card shadow="never" class="summary-card" :class="{ 'has-overdue': summary.overdue > 0 }">
        <span class="summary-label">已逾期</span>
        <strong :class="{ 'profit-negative': summary.overdue > 0 }">{{ summary.overdue }}</strong>
        <small>已超过截止日，优先处理</small>
      </el-card>
    </el-col>
    <el-col :xs="24" :sm="8">
      <el-card shadow="never" class="summary-card">
        <span class="summary-label">已处理</span>
        <strong>{{ summary.handled }}</strong>
        <small>保留 7 天后自动清理（可配置）</small>
      </el-card>
    </el-col>
  </el-row>

  <el-card shadow="never" class="content-card">
    <div class="filter-row">
      <el-radio-group v-model="query.isHandled" @change="handleFilterChange">
        <el-radio-button value="false">未处理</el-radio-button>
        <el-radio-button value="true">已处理</el-radio-button>
        <el-radio-button value="">全部</el-radio-button>
      </el-radio-group>
      <el-select v-model="query.type" clearable placeholder="提醒类型" class="status-input" @change="handleFilterChange">
        <el-option v-for="item in typeOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-button @click="loadReminders({ scan: false })">刷新</el-button>
      <span v-if="overdueCount > 0" class="overdue-hint">本页有 {{ overdueCount }} 条已逾期</span>
    </div>

    <el-table v-loading="loading" :data="reminders" stripe empty-text="暂无提醒，点「立即扫描」检查一次">
      <el-table-column label="类型" width="140">
        <template #default="scope">
          <el-tag size="small" :type="typeTagType(scope.row.type)">{{ typeLabel(scope.row.type) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="提醒内容" min-width="300">
        <template #default="scope">
          <div class="reminder-title">{{ scope.row.title }}</div>
          <div class="reminder-detail">{{ scope.row.detail }}</div>
        </template>
      </el-table-column>
      <el-table-column label="对象" width="150">
        <template #default="scope">
          <el-button link type="primary" @click="openSource(scope.row)">{{ scope.row.sourceNo ?? '—' }}</el-button>
        </template>
      </el-table-column>
      <el-table-column label="预警" width="100">
        <template #default="scope">
          <el-tooltip
            :content="scope.row.tierDays ? `命中档位阈值：剩余 ${scope.row.tierDays} 天` : '未进入预警档位'"
            placement="top"
          >
            <el-tag size="small" :type="alertMeta(scope.row.alertLevel).type" effect="plain">
              {{ alertMeta(scope.row.alertLevel).label }}
            </el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="期限" width="200">
        <template #default="scope">
          <span :class="{ 'overdue-text': !scope.row.isHandled && scope.row.isOverdue }">{{ dueText(scope.row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="190">
        <template #default="scope">
          <template v-if="scope.row.isHandled">
            <el-tooltip :content="`${scope.row.handledBy?.displayName ?? '—'}：${scope.row.handleNote ?? '无说明'}`" placement="top">
              <el-tag size="small" type="success">已处理</el-tag>
            </el-tooltip>
            <span class="handled-time">{{ scope.row.handledAt ? new Date(scope.row.handledAt).toLocaleString('zh-CN') : '' }}</span>
          </template>
          <el-tag v-else size="small" :type="scope.row.isOverdue ? 'danger' : 'warning'">
            {{ scope.row.isOverdue ? '逾期未处理' : '待处理' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="scope">
          <el-button v-if="!scope.row.isHandled" link type="primary" @click="handleReminder(scope.row)">标记已处理</el-button>
          <el-button v-else link @click="unhandleReminder(scope.row)">恢复未处理</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="pagination-row">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        background
        layout="total, sizes, prev, pager, next"
        :total="total"
        @current-change="() => loadReminders({ scan: false })"
        @size-change="handleFilterChange"
      />
    </div>
  </el-card>
</template>

<style scoped>
.overdue-hint {
  color: #b91c1c;
  font-size: 13px;
}

.scope-hint {
  margin: 6px 0 0;
  color: #8b99ad;
  font-size: 12px;
  line-height: 1.7;
}

.page-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.reminder-title {
  color: #1f2d3d;
  font-size: 14px;
}

.reminder-detail {
  margin-top: 2px;
  color: #8b99ad;
  font-size: 12px;
}

.overdue-text {
  color: #b91c1c;
  font-weight: 600;
}

.handled-time {
  margin-left: 8px;
  color: #8b99ad;
  font-size: 12px;
}

.has-overdue :deep(strong) {
  color: #b91c1c;
}
</style>


<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
// Element Plus 默认语言是英文：日期选择器会显示 "2026 October"、星期显示 Sun~Sat，
// 下拉占位符显示 Select、无数据时显示 No data。这里挂中文语言包统一成中文。
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import AdminView from './views/AdminView.vue';
import CustomerView from './views/CustomerView.vue';
import ContractView from './views/ContractView.vue';
import ProjectView from './views/ProjectView.vue';
import RemindersView from './views/RemindersView.vue';
import LoginView from './views/LoginView.vue';
import FeedbackCenter from './components/FeedbackCenter.vue';
import { canExportModule } from './composables/useExport';

const activeNav = ref('首页');
const apiStatus = ref('检测中');
const apiStatusType = ref<'success' | 'warning' | 'danger' | 'info'>('info');
const accessToken = ref(localStorage.getItem('bms_access_token'));
const currentUser = ref<{ displayName: string; username: string; isSystemAdmin?: boolean; dataScope?: string } | null>(null);
/** 后端返回的权限点编码，用于控制菜单与入口是否可用 */
const permissions = ref<string[]>([]);
const feedbackVisible = ref(false);
const noAccessVisible = ref(false);
const noAccessMessage = ref('');
const dashboard = ref({
  contractAmount: '0.00',
  projectCount: 0,
  collectedAmount: '0.00',
  netProfit: '0.00',
  unpaidAmount: '0.00',
  reminders: { unhandled: 0, overdue: 0 },
  // PRD 第十章「卡片四：待办提醒」的四项口径
  prdReminders: {
    todayTodo: 0,
    overdueProjects: 0,
    overdueMailRegistrations: 0,
    paymentPendingContracts: 0,
    unhandled: 0,
    overdue: 0,
    unavailable: [] as Array<{ key: string; label: string; reason: string }>,
  },
});

// 回款与成本属于合同/项目的附属数据，不作为一级导航，统一在详情页内维护
const navigation = ['首页', '提醒', '客户', '合同', '项目', '管理系统'];
const avatarText = computed(() => currentUser.value?.displayName?.slice(0, 1) ?? '开');
const canAccessAdmin = computed(() => permissions.value.includes('system.admin.access') || Boolean(currentUser.value?.isSystemAdmin));
// 后端对系统管理员直接按 ALL 放行；前端按钮也必须遵循同一规则，避免权限列表短暂未刷新导致上传入口消失。
const canViewFiles = computed(() => permissions.value.includes('attachment.read') || Boolean(currentUser.value?.isSystemAdmin));
const canDownloadFiles = computed(() => permissions.value.includes('attachment.download') || Boolean(currentUser.value?.isSystemAdmin));
const canUploadFiles = computed(() => permissions.value.includes('attachment.upload') || Boolean(currentUser.value?.isSystemAdmin));
const canDeleteFiles = computed(() => permissions.value.includes('attachment.delete') || Boolean(currentUser.value?.isSystemAdmin));
// 合同附件权限跟随合同自身：查看/下载使用 contract.read，上传/删除使用 contract.manage。
const canReadContracts = computed(() => permissions.value.includes('contract.read') || Boolean(currentUser.value?.isSystemAdmin));
const canManageContracts = computed(() => permissions.value.includes('contract.manage') || Boolean(currentUser.value?.isSystemAdmin));
const canManageFeedback = computed(() => permissions.value.includes('feedback.manage') || Boolean(currentUser.value?.isSystemAdmin));
/**
 * 导出权限（PRD 4.12）—— **按模块**判定，不能粗粒度。
 *
 * 具体规则集中在 `useExport.ts` 的 `canExportModule()`，这里只负责把它接到当前用户上。
 * 曾经写成 `permissions.some(code => code.endsWith('.export'))`，
 * 结果只拥有 cost.export 的账号在合同页也会看到「导出合同列表」，点下去才 403。
 */
const canExportContracts = computed(() => canExportModule(permissions.value, currentUser.value?.isSystemAdmin, 'contract'));
const canExportProjects = computed(() => canExportModule(permissions.value, currentUser.value?.isSystemAdmin, 'project'));
/** 回款导出在项目详情里；后端校验的是 payment.manage */
const canExportPayments = computed(() => canExportModule(permissions.value, currentUser.value?.isSystemAdmin, 'payment'));

// 从合同详情点项目编号跳转到项目页时，带上项目编号用于定位
const projectKeyword = ref<string | undefined>(undefined);
/**
 * 从首页「超时邮件登记」卡片跳转时置为 true，
 * 让项目详情打开后直接切到「官文管理 → 只看待邮件登记」，并跨项目显示待办官文。
 */
const projectNeedsMail = ref(false);

/** 管理系统入口对所有登录用户可见；没有权限时点击给出明确提示（PRD 1.1）。 */
function handleNavSelect(target: string) {
  if (target === '管理系统' && !canAccessAdmin.value) {
    noAccessMessage.value = '你当前的角色没有「进入管理系统」权限。系统 B 的组织、用户、角色、权限与字段配置由系统管理员分配，请联系管理员开通。';
    noAccessVisible.value = true;
    return;
  }
  // 从顶部菜单手动切换时清掉「待邮件登记」直达标记，避免筛选一直粘着
  projectNeedsMail.value = false;
  projectKeyword.value = undefined;
  activeNav.value = target;
}

function handleNavigate(payload: { target: string; keyword?: string; needsMail?: boolean }) {
  projectKeyword.value = payload.keyword;
  projectNeedsMail.value = Boolean(payload.needsMail);
  activeNav.value = payload.target;
}

/**
 * 首页「超时邮件登记」卡片 → 项目页的「待邮件登记」视图。
 *
 * 之前这张卡片点下去是 `activeNav = '合同'`（跳到合同列表），与该指标毫无关系；
 * 而指标本身也**没有任何地方能看到明细**，导致"知道有 N 条待登记却无从下手"。
 */
function goToMailRegistration() {
  projectKeyword.value = undefined;
  projectNeedsMail.value = true;
  activeNav.value = '项目';
}

/* ---------------- 首页待办提醒 ---------------- */

type HomeReminder = {
  id: string;
  type: 'CONTRACT_DEADLINE' | 'INTERNAL_SAFETY' | 'NODE_OVERDUE' | 'PAYMENT_PENDING';
  sourceType: 'Contract' | 'Project';
  sourceNo: string | null;
  title: string;
  detail: string | null;
  dueAt: string;
  overdueDays: number;
  daysRemaining: number;
  isOverdue: boolean;
  /** 分级预警档位（PRD 4.7） */
  alertLevel: 'NORMAL' | 'NOTICE' | 'WARNING' | 'URGENT' | 'OVERDUE';
  tierDays: number | null;
};

const topReminders = ref<HomeReminder[]>([]);
const reminderLoading = ref(false);
const scanning = ref(false);

/** 分级预警档位 → 展示配置 */
const ALERT_LEVEL_META: Record<HomeReminder['alertLevel'], { label: string; type: 'info' | 'primary' | 'warning' | 'danger' }> = {
  NORMAL: { label: '正常', type: 'info' },
  NOTICE: { label: '提示', type: 'info' },
  WARNING: { label: '警告', type: 'warning' },
  URGENT: { label: '紧急', type: 'danger' },
  OVERDUE: { label: '已逾期', type: 'danger' },
};

function alertMeta(level: HomeReminder['alertLevel']) {
  return ALERT_LEVEL_META[level] ?? ALERT_LEVEL_META.NORMAL;
}

function reminderTypeLabel(type: HomeReminder['type']) {
  if (type === 'CONTRACT_DEADLINE') return '合同截止';
  if (type === 'INTERNAL_SAFETY') return '内部安全日';
  if (type === 'PAYMENT_PENDING') return '待回款';
  return '节点超期';
}

async function loadTopReminders() {
  if (!accessToken.value) return;
  reminderLoading.value = true;
  try {
    const response = await fetch('/api/reminders?isHandled=false&pageSize=5', {
      headers: { Authorization: `Bearer ${accessToken.value}` },
    });
    if (!response.ok) throw new Error('load failed');
    const result = (await response.json()) as { items: HomeReminder[] };
    topReminders.value = result.items;
  } catch {
    topReminders.value = [];
  } finally {
    reminderLoading.value = false;
  }
}

/** 手动扫描一次并刷新首页提醒（合同/项目日期改动后不必等定时任务） */
async function scanReminders() {
  if (!accessToken.value) return;
  scanning.value = true;
  try {
    const response = await fetch('/api/reminders/scan', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken.value}` },
    });
    const payload = (await response.json().catch(() => null)) as { created?: number; message?: string } | null;
    if (!response.ok) throw new Error(payload?.message ?? '扫描失败');
    ElMessage.success(`扫描完成：新增 ${payload?.created ?? 0} 条提醒`);
    await Promise.all([loadOverview(), loadTopReminders()]);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '扫描失败');
  } finally {
    scanning.value = false;
  }
}

async function handleReminder(reminder: HomeReminder) {
  if (!accessToken.value) return;
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
    const response = await fetch(`/api/reminders/${reminder.id}/handle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken.value}` },
      body: JSON.stringify({ note }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(payload?.message ?? '处理失败');
    }
    ElMessage.success('已标记为处理');
    await Promise.all([loadOverview(), loadTopReminders()]);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '处理失败');
  }
}

function goToSource(reminder: HomeReminder) {
  if (!reminder.sourceNo) return;
  projectKeyword.value = reminder.sourceNo;
  activeNav.value = reminder.sourceType === 'Contract' ? '合同' : '项目';
}

function handleLogin(payload: { accessToken: string; user: { displayName: string; username: string; isSystemAdmin?: boolean; permissions?: string[] } }) {
  localStorage.setItem('bms_access_token', payload.accessToken);
  accessToken.value = payload.accessToken;
  currentUser.value = payload.user;
  permissions.value = payload.user.permissions ?? [];
  void loadOverview();
  void loadTopReminders();
}

function logout() {
  localStorage.removeItem('bms_access_token');
  accessToken.value = null;
  currentUser.value = null;
  permissions.value = [];
  activeNav.value = '首页';
}

async function restoreSession() {
  if (!accessToken.value) return;

  try {
    const response = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${accessToken.value}` },
    });
    if (!response.ok) throw new Error('session expired');
    const me = (await response.json()) as { displayName: string; username: string; isSystemAdmin?: boolean; dataScope?: string; permissions?: string[] };
    currentUser.value = me;
    permissions.value = me.permissions ?? [];
    await loadOverview();
    await loadTopReminders();
  } catch {
    logout();
  }
}

async function loadOverview() {
  if (!accessToken.value) return;
  try {
    const response = await fetch('/api/dashboard/overview', { headers: { Authorization: `Bearer ${accessToken.value}` } });
    if (response.ok) dashboard.value = (await response.json()) as typeof dashboard.value;
  } catch {
    // 首页允许在汇总接口不可用时继续使用业务菜单。
  }
}
function money(value: string) {
  return `¥${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`;
}

onMounted(async () => {
  await restoreSession();
  await loadTopReminders();
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('health check failed');
    apiStatus.value = '后端已连接';
    apiStatusType.value = 'success';
  } catch {
    apiStatus.value = '等待后端';
    apiStatusType.value = 'warning';
  }
});
</script>

<template>
  <!-- 全局中文语言包：包住整个应用，日期选择器/分页/确认框/下拉占位符都会走中文 -->
  <el-config-provider :locale="zhCn">
    <LoginView v-if="!accessToken" @success="handleLogin" />

  <el-container v-else class="app-shell">
    <el-header class="topbar" height="64px">
      <div class="brand">业务管理系统</div>
      <el-menu
        :default-active="activeNav"
        mode="horizontal"
        :ellipsis="false"
        class="main-nav"
        @select="handleNavSelect"
      >
        <el-menu-item v-for="item in navigation" :key="item" :index="item">
          {{ item }}
        </el-menu-item>
      </el-menu>
      <div class="user-area">
        <el-button plain size="small" class="feedback-entry" @click="feedbackVisible = true">意见反馈</el-button>
        <el-avatar :size="30">{{ avatarText }}</el-avatar>
        <span class="user-name">{{ currentUser?.displayName ?? '本地开发环境' }}</span>
        <el-button text size="small" @click="logout">退出</el-button>
      </div>
    </el-header>

    <FeedbackCenter v-model="feedbackVisible" :token="accessToken ?? ''" :can-manage="canManageFeedback" />

    <el-main class="main-content">
      <AdminView v-if="activeNav === '管理系统'" :token="accessToken ?? ''" />
      <RemindersView v-else-if="activeNav === '提醒'" :token="accessToken ?? ''" :can-view-mail="permissions.includes('mail_delivery.read') || Boolean(currentUser?.isSystemAdmin)" :data-scope="currentUser?.dataScope" @navigate="handleNavigate" />
      <CustomerView v-else-if="activeNav === '客户'" :token="accessToken ?? ''" />
      <ContractView v-else-if="activeNav === '合同'" :token="accessToken ?? ''" :can-assign-owner="canAccessAdmin" :can-view-files="canReadContracts || canManageContracts" :can-download-files="canReadContracts || canManageContracts" :can-upload-files="canManageContracts" :can-delete-files="canManageContracts" :can-export="canExportContracts" @navigate="handleNavigate" />
      <ProjectView v-else-if="activeNav === '项目'" :token="accessToken ?? ''" :keyword="projectKeyword" :needs-mail="projectNeedsMail" :permissions="permissions" :can-view-files="canViewFiles" :can-download-files="canDownloadFiles" :can-upload-files="canUploadFiles" :can-delete-files="canDeleteFiles" :can-export-projects="canExportProjects" :can-export-payments="canExportPayments" />

      <template v-else>
      <div class="page-heading">
        <div>
          <p class="eyebrow">系统 A · 工作台</p>
          <h1>工作台</h1>
          <p class="subtitle">全局统计与待办提醒。金额口径：已收款按收款单汇总，成本按项目汇总。</p>
        </div>
        <el-tag :type="apiStatusType" effect="light" round>{{ apiStatus }}</el-tag>
      </div>

      <!-- PRD 第十章「卡片四：待办提醒」的四项口径 -->
      <el-row :gutter="16" class="summary-row">
        <el-col :xs="12" :sm="6">
          <el-card shadow="never" class="summary-card prd-card" @click="activeNav = '提醒'">
            <span class="summary-label">今日待办</span>
            <strong>{{ dashboard.prdReminders.todayTodo }}</strong>
            <small>今天到期或已逾期且未处理</small>
          </el-card>
        </el-col>
        <el-col :xs="12" :sm="6">
          <el-card shadow="never" class="summary-card prd-card" :class="{ 'has-overdue': dashboard.prdReminders.overdueProjects > 0 }" @click="activeNav = '提醒'">
            <span class="summary-label">逾期项目</span>
            <strong>{{ dashboard.prdReminders.overdueProjects }}</strong>
            <small>节点已超过时限的项目</small>
          </el-card>
        </el-col>
        <el-col :xs="12" :sm="6">
          <el-card shadow="never" class="summary-card prd-card" :class="{ 'has-overdue': dashboard.prdReminders.overdueMailRegistrations > 0 }" @click="goToMailRegistration">
            <span class="summary-label">超时邮件登记</span>
            <strong>{{ dashboard.prdReminders.overdueMailRegistrations }}</strong>
            <small>需邮件送达但尚未登记</small>
          </el-card>
        </el-col>
        <el-col :xs="12" :sm="6">
          <el-card shadow="never" class="summary-card prd-card" :class="{ 'has-overdue': dashboard.prdReminders.paymentPendingContracts > 0 }" @click="activeNav = '提醒'">
            <span class="summary-label">待回款合同</span>
            <strong>{{ dashboard.prdReminders.paymentPendingContracts }}</strong>
            <small>项目已走完但款未收齐</small>
          </el-card>
        </el-col>
      </el-row>

      <el-row :gutter="16" class="summary-row">
        <el-col :xs="24" :sm="12" :lg="6">
          <el-card shadow="never" class="summary-card reminder-card" :class="{ 'has-overdue': dashboard.reminders.overdue > 0 }" @click="activeNav = '提醒'">
            <span class="summary-label">待办提醒</span>
            <strong>{{ dashboard.reminders.unhandled }}</strong>
            <small>
              <template v-if="dashboard.reminders.overdue > 0">其中 {{ dashboard.reminders.overdue }} 条已逾期 · 点击查看</template>
              <template v-else>暂无逾期 · 点击查看</template>
            </small>
          </el-card>
        </el-col>
        <el-col :xs="24" :sm="12" :lg="6">
          <el-card shadow="never" class="summary-card">
            <span class="summary-label">合同金额</span>
            <strong>{{ money(dashboard.contractAmount) }}</strong>
            <small>当前数据范围内的不含税金额</small>
          </el-card>
        </el-col>
        <el-col :xs="24" :sm="12" :lg="6">
          <el-card shadow="never" class="summary-card">
            <span class="summary-label">未收款</span>
            <strong>{{ money(dashboard.unpaidAmount) }}</strong>
            <small>合同金额 - 已收款</small>
          </el-card>
        </el-col>
        <el-col :xs="24" :sm="12" :lg="6">
          <el-card shadow="never" class="summary-card">
            <span class="summary-label">已收款 / 净收益</span>
            <strong>{{ money(dashboard.collectedAmount) }}</strong>
            <small :class="{ 'profit-negative': Number(dashboard.netProfit) < 0 }">净收益 {{ money(dashboard.netProfit) }}</small>
          </el-card>
        </el-col>
      </el-row>
      <el-row :gutter="16" class="summary-row dashboard-second-row">
        <el-col :xs="24" :sm="12" :lg="6">
          <el-card shadow="never" class="summary-card">
            <span class="summary-label">项目数量</span>
            <strong>{{ dashboard.projectCount }}</strong>
            <small>未软删除项目</small>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="content-card reminder-panel">
        <template #header>
          <div class="card-header">
            <span>待办提醒</span>
            <div class="reminder-panel-actions">
              <el-tag v-if="dashboard.reminders.overdue > 0" type="danger" size="small">{{ dashboard.reminders.overdue }} 条已逾期</el-tag>
              <el-tag v-else type="success" size="small">暂无逾期</el-tag>
              <el-button size="small" :loading="scanning" @click="scanReminders">立即扫描</el-button>
              <el-button size="small" link type="primary" @click="activeNav = '提醒'">查看全部</el-button>
            </div>
          </div>
        </template>

        <el-table v-loading="reminderLoading" :data="topReminders" stripe empty-text="暂无待办提醒">
          <el-table-column label="类型" width="130">
            <template #default="scope">
              <el-tag size="small" :type="scope.row.type === 'CONTRACT_DEADLINE' ? 'warning' : scope.row.type === 'INTERNAL_SAFETY' ? 'primary' : scope.row.type === 'PAYMENT_PENDING' ? 'success' : 'danger'">
                {{ reminderTypeLabel(scope.row.type) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="提醒内容" min-width="300">
            <template #default="scope">
              <div>{{ scope.row.title }}</div>
              <div class="reminder-detail">{{ scope.row.detail }}</div>
            </template>
          </el-table-column>
          <el-table-column label="预警" width="100">
            <template #default="scope">
              <el-tag size="small" :type="alertMeta(scope.row.alertLevel).type" effect="plain">
                {{ alertMeta(scope.row.alertLevel).label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="期限" width="190">
            <template #default="scope">
              <span :class="{ 'overdue-text': scope.row.isOverdue }">
                {{ scope.row.isOverdue ? `已逾期 ${scope.row.overdueDays} 天` : scope.row.daysRemaining === 0 ? '今天到期' : `还有 ${scope.row.daysRemaining} 天` }}
                （{{ new Date(scope.row.dueAt).toLocaleDateString('zh-CN') }}）
              </span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="goToSource(scope.row)">查看对象</el-button>
              <el-button link type="primary" @click="handleReminder(scope.row)">标记已处理</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="content-card">
        <template #header>
          <div class="card-header">
            <span>本地运行状态</span>
            <el-tag :type="apiStatusType" effect="plain" round>{{ apiStatus }}</el-tag>
          </div>
        </template>
        <div class="quick-entry">
          <div class="quick-entry-text">
            <strong>从业务主线开始</strong>
            <p>标准链路为「客户 → 合同 → 项目 → 回款 → 成本」，合同录入时会按件数自动生成项目。</p>
          </div>
          <div class="quick-entry-actions">
            <el-button type="primary" @click="activeNav = '客户'">客户管理</el-button>
            <el-button @click="activeNav = '合同'">合同管理</el-button>
            <el-button @click="activeNav = '项目'">项目管理</el-button>
          </div>
        </div>
      </el-card>
      </template>
    </el-main>

    <el-dialog v-model="noAccessVisible" title="无访问权限" width="440px">
      <div class="no-access-body">
        <span class="no-access-icon">!</span>
        <p>{{ noAccessMessage }}</p>
      </div>
      <template #footer>
        <el-button type="primary" @click="noAccessVisible = false">我知道了</el-button>
      </template>
    </el-dialog>
  </el-container>
  </el-config-provider>
</template>

<style scoped>
.user-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-entry {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}

.quick-entry-text strong {
  color: #1f3355;
  font-size: 16px;
}

.quick-entry-text p {
  margin: 8px 0 0;
  color: #5b6b85;
  font-size: 13px;
  line-height: 1.7;
}

.quick-entry-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.no-access-body {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.no-access-icon {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: #fef3c7;
  color: #b45309;
  font-size: 20px;
  font-weight: 700;
  line-height: 34px;
  text-align: center;
}

.no-access-body p {
  margin: 4px 0 0;
  color: #46587a;
  font-size: 14px;
  line-height: 1.8;
}
.reminder-panel {
  margin-bottom: 16px;
}

.reminder-panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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

@media (max-width: 1180px) {
  .main-nav .el-menu-item {
    padding: 0 12px;
    font-size: 14px;
  }
}

@media (max-width: 1024px) {
  .main-nav .el-menu-item {
    padding: 0 8px;
    font-size: 13px;
  }
}
.prd-card {
  cursor: pointer;
}

.prd-card .summary-label {
  display: inline-block;
}

.prd-card.is-unavailable {
  cursor: default;
  background: #f8fafc;
}

.prd-card.is-unavailable .muted {
  color: #a9b4c4;
}

.reminder-panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>





<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import CustomFieldColumns from '../components/CustomFieldColumns.vue';
import CustomFieldForm from '../components/CustomFieldForm.vue';
import ProjectWorkflow from '../components/ProjectWorkflow.vue';
import TypeSelector from '../components/TypeSelector.vue';
import FileAttachmentPanel from '../components/FileAttachmentPanel.vue';
import OfficialDocumentPanel from '../components/records/OfficialDocumentPanel.vue';
import DangerDeleteDialog from '../components/DangerDeleteDialog.vue';
import ActionRecordPanel from '../components/records/ActionRecordPanel.vue';
import FilingResultPanel from '../components/records/FilingResultPanel.vue';
import { toCalendarDateText, todayCalendarDate } from '../utils/calendar-date';
import { useExport } from '../composables/useExport';

type ContractOption = { id: string; contractNo: string; customer: { id: string; name: string } };
type Project = {
  id: string;
  projectNo: string;
  contractId: string;
  sequence: number;
  projectName: string;
  projectType: string | null;
  statusCode: string;
  version: number;
  startDate: string | null;
  dueDate: string | null;
  contract: ContractOption;
  owner: { id: string; displayName: string } | null;
  customFields?: Record<string, unknown> | null;
  workflow?: { bound: boolean; templateName: string | null; version: number | null; currentNodeName: string | null };
  _count: { costs: number; payments: number };
};

type ProjectPayment = {
  amount: string | number;
  payment: { id: string; receiptNo: string; amount: string | number; receivedAt: string; paymentMethod: string | null; note: string | null };
};
type ProjectCost = { id: string; costType: string; amount: string | number; incurredAt: string; note: string | null };
type ProjectDetail = Project & {
  payments: ProjectPayment[];
  costs: ProjectCost[];
  totals: { collectedAmount: string; costAmount: string; netProfit: string };
  workflow: {
    bound: boolean;
    version: { id: string; version: number; status?: string; templateName: string } | null;
    currentNode: { code: string; name: string; sequence: number; statisticsCode: string } | null;
    nextNode: { code: string; name: string; sequence: number } | null;
    nodes: Array<{ code: string; name: string; sequence: number; statisticsCode: string }>;
  };
};
type SiblingProject = { id: string; projectNo: string; projectName: string };
type StatusOption = { code: string; label: string; color: string | null };

const props = defineProps<{
  token: string;
  keyword?: string | undefined;
  /** 由首页「超时邮件登记」卡片跳转而来：直接进入待邮件登记视图 */
  needsMail?: boolean;
  /** 当前用户的权限点列表（由 App.vue 传入），用于判定附属业务数据的增删改权限 */
  permissions?: string[];
  canViewFiles?: boolean;
  canDownloadFiles?: boolean;
  canUploadFiles?: boolean;
  canDeleteFiles?: boolean;
  /**
   * 导出权限（PRD 4.12），**按模块分开**：
   * 拥有 project.export 才显示「导出项目列表」；拥有 payment.manage 才显示「导出本项目回款」。
   * 分开传值是为了避免"按钮显示了但点下去 403"。
   */
  canExportProjects?: boolean;
  canExportPayments?: boolean;
}>();

/** 导出项目列表（PRD 4.12「项目列表页导出项目列表」），筛选条件与列表完全一致 */
const { exporting: exportingProjects, exportData: exportProjects } = useExport(() => props.token, 'project', '项目');

/** 导出回款记录（PRD 4.12「回款列表页导出回款记录」）；回款没有独立 export 权限点，用 payment.manage */
const { exporting: exportingPayments, exportData: exportPayments } = useExport(() => props.token, 'payment', '回款');

/**
 * 附属业务数据（官文 / 动作记录 / 申报结果）的权限判定。
 * 口径与后端一致：**录入需要 manage，删除需要 delete**，两者独立。
 * 没有对应权限时按钮不显示，避免用户点了才被 403 拒绝。
 */
function has(permission: string): boolean {
  return (props.permissions ?? []).includes(permission);
}
const loading = ref(false);
const saving = ref(false);
const projects = ref<Project[]>([]);
const contracts = ref<ContractOption[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const query = reactive({ keyword: '', statusCode: '', contractId: '' });
const form = reactive({ contractId: '', projectName: '', projectType: '', statusCode: 'PENDING', startDate: '', dueDate: '' });
/** 自定义字段的取值，按系统 B 的字段定义动态渲染 */
const customFieldValues = ref<Record<string, unknown>>({});
/** 编辑时的乐观锁版本号 */
const editingVersion = ref<number | null>(null);
/** 项目状态枚举来自系统 B（StatusDefinition），页面不再写死中文状态名 */
const projectStatuses = ref<StatusOption[]>([]);
const statusLabel = (code: string) => projectStatuses.value.find((item) => item.code === code)?.label ?? '未知状态';

// 项目详情（回款、成本都在详情内维护）
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<ProjectDetail | null>(null);
const detailTab = ref('payments');
/**
 * 当前项目**是否允许访问附件**。
 *
 * 为什么不能只看 `props.canViewFiles`：那只是"有没有 attachment.read 这个权限点"，
 * 而附件接口还会按**数据范围**判定（范围不通过就 403）。两者不是一回事 ——
 * 只按权限点显示标签，就会出现"标签能点开、点开就弹无权访问"的困惑。
 *
 * 所以打开详情时先静默探测一次，没有权限就不显示附件入口。
 */
const canAccessFiles = ref(false);
/** 流转记录（状态变化 + 节点流转） */
const statusHistory = ref<Array<{
  id: string;
  fromStatusCode: string | null;
  toStatusCode: string;
  fromStatusLabel: string | null;
  toStatusLabel: string | null;
  reason: string | null;
  changedAt: string;
  operator: { displayName: string } | null;
}>>([]);
const nodeHistory = ref<Array<{
  id: string;
  fromNodeName: string | null;
  toNodeName: string;
  actionAt: string;
  note: string | null;
  operator: { displayName: string } | null;
}>>([]);
const historyLoading = ref(false);

async function loadProjectHistory() {
  if (!detail.value) return;
  historyLoading.value = true;
  try {
    const [statuses, nodes] = await Promise.all([
      request<typeof statusHistory.value>(`/api/projects/${detail.value.id}/status-history`),
      request<typeof nodeHistory.value>(`/api/projects/${detail.value.id}/node-history`),
    ]);
    statusHistory.value = statuses;
    nodeHistory.value = nodes;
  } catch {
    statusHistory.value = [];
    nodeHistory.value = [];
  } finally {
    historyLoading.value = false;
  }
}

function handleDetailTab(name: string | number) {
  if (name === 'history') void loadProjectHistory();
}

/** 节点推进后：刷新详情与流转记录，保证节点、状态、时间线一致 */
async function onWorkflowChanged() {
  if (!detail.value) return;
  try {
    detail.value = await request<ProjectDetail>(`/api/projects/${detail.value.id}`);
    await loadProjects();
    if (detailTab.value === 'history') await loadProjectHistory();
  } catch {
    // 刷新失败不打断操作，下次打开详情会重新加载
  }
}
const siblingProjects = ref<SiblingProject[]>([]);

// 回款表单
const paymentDialog = ref(false);
const paymentSaving = ref(false);
const editingPaymentId = ref<string | null>(null);
const paymentForm = reactive({ amount: '', receivedAt: todayCalendarDate(), paymentMethod: '', note: '' });
const paymentAllocations = ref<Array<{ projectId: string; amount: string }>>([]);
const allocationTotal = computed(() => paymentAllocations.value.reduce((sum, item) => sum + (Number(item.amount) || 0), 0));

// 成本表单
const costDialog = ref(false);
const costSaving = ref(false);
const editingCostId = ref<string | null>(null);
const costForm = reactive({ costType: '', amount: '', incurredAt: todayCalendarDate(), note: '' });

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}`, ...(options.headers ?? {}) } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? '请求失败');
  return payload as T;
}

function money(value: string | number) {
  return `¥ ${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`;
}

async function loadProjects() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize.value) });
    if (query.keyword.trim()) params.set('keyword', query.keyword.trim());
    if (query.statusCode) params.set('statusCode', query.statusCode);
    if (query.contractId) params.set('contractId', query.contractId);
    const result = await request<{ items: Project[]; total: number }>(`/api/projects?${params.toString()}`);
    projects.value = result.items;
    total.value = result.total;

    // 从首页「超时邮件登记」跳进来时，自动打开一个项目并切到该视图，
    // 否则用户看到的只是普通项目列表，还得自己点进详情才知道去哪儿登记。
    // 打开第一个项目只是为了让详情弹窗有宿主（面板内会按跨项目口径列出全部待登记官文）。
    if (props.needsMail && !detailVisible.value && result.items.length > 0) {
      await openDetail(result.items[0]!);
      detailTab.value = 'officialDocumentList';
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '项目数据加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadContracts() {
  try {
    const result = await request<{ items: ContractOption[] }>('/api/contracts?page=1&pageSize=100');
    contracts.value = result.items;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '合同列表加载失败');
  }
}

async function loadStatusOptions() {
  try {
    const grouped = await request<Record<string, StatusOption[]>>('/api/options/statuses');
    projectStatuses.value = grouped.project ?? [];
  } catch {
    // 状态枚举读取失败时退回显示原始编码，不阻塞页面
    projectStatuses.value = [];
  }
}

/* ---------------- 项目详情 ---------------- */

async function openDetail(project: Project) {
  detailVisible.value = true;
  detailLoading.value = true;
  detailTab.value = 'payments';
  statusHistory.value = [];
  nodeHistory.value = [];
  canAccessFiles.value = false;
  try {
    detail.value = await request<ProjectDetail>(`/api/projects/${project.id}`);
    // 同合同下的项目，供一笔回款在项目间拆分时选择
    const siblings = await request<{ items: SiblingProject[] }>(`/api/projects?contractId=${project.contractId}&page=1&pageSize=100`);
    siblingProjects.value = siblings.items.filter((item) => item.id !== project.id);
    // 附件入口能否显示，取决于真实权限（含数据范围），而不是只看权限点
    await probeFileAccess(project.id);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '项目详情加载失败');
    detailVisible.value = false;
  } finally {
    detailLoading.value = false;
  }
}

async function refreshDetail() {
  if (!detail.value) return;
  detail.value = await request<ProjectDetail>(`/api/projects/${detail.value.id}`);
  await loadProjects();
}

/**
 * 静默探测「当前用户能否访问该项目的附件」。
 *
 * 用原生 fetch 而不是页面里的 `request` 包装 —— 后者失败会弹全局错误提示，
 * 那正是我们要消除的"吓人红字"。这里只看状态码，不打扰用户。
 *
 * 探测用的路径与实际附件面板完全相同，所以结论一致；
 * 后端 `list()` 是**先校验权限再查文件**，因此即使一个附件都没有也会返回 403，
 * 探测结果不受"附件为空"影响。
 */
async function probeFileAccess(projectId: string) {
  // 没有附件查看权限点，就不必发这个请求
  if (!props.canViewFiles) {
    canAccessFiles.value = false;
    return;
  }
  try {
    const response = await fetch(`/api/files/Project/${projectId}`, {
      headers: { Authorization: `Bearer ${props.token}` },
    });
    canAccessFiles.value = response.ok;
  } catch {
    canAccessFiles.value = false;
  }
}

/* ---------------- 回款（登记在项目上） ---------------- */

function resetPaymentForm() {
  Object.assign(paymentForm, { amount: '', receivedAt: todayCalendarDate(), paymentMethod: '', note: '' });
  paymentAllocations.value = detail.value ? [{ projectId: detail.value.id, amount: '' }] : [];
  editingPaymentId.value = null;
}

function openCreatePayment() {
  resetPaymentForm();
  paymentDialog.value = true;
}

function openEditPayment(row: ProjectPayment) {
  editingPaymentId.value = row.payment.id;
  Object.assign(paymentForm, {
    amount: String(row.payment.amount),
    receivedAt: toCalendarDateText(row.payment.receivedAt),
    paymentMethod: row.payment.paymentMethod ?? '',
    note: row.payment.note ?? '',
  });
  paymentAllocations.value = [{ projectId: detail.value?.id ?? '', amount: String(row.amount) }];
  paymentDialog.value = true;
}

function addAllocation() {
  paymentAllocations.value.push({ projectId: '', amount: '' });
}

function removeAllocation(index: number) {
  paymentAllocations.value.splice(index, 1);
}

async function savePayment() {
  if (!detail.value) return;
  if (!paymentForm.amount || Number(paymentForm.amount) <= 0) {
    ElMessage.warning('请输入有效的回款金额');
    return;
  }
  const allocations = paymentAllocations.value.filter((item) => item.projectId && Number(item.amount) > 0);
  if (allocations.length === 0) {
    ElMessage.warning('请至少选择一个分摊项目并填写金额');
    return;
  }
  if (paymentAllocations.value.some((item) => item.projectId && !(Number(item.amount) > 0))) {
    ElMessage.warning('分摊金额必须大于 0');
    return;
  }
  if (Math.abs(allocationTotal.value - Number(paymentForm.amount)) > 0.005) {
    ElMessage.warning('分摊合计必须等于回款总额');
    return;
  }
  if (new Set(allocations.map((item) => item.projectId)).size !== allocations.length) {
    ElMessage.warning('同一项目不能重复分摊');
    return;
  }

  paymentSaving.value = true;
  try {
    const body: Record<string, unknown> = {
      contractId: detail.value.contractId,
      amount: Number(paymentForm.amount),
      receivedAt: paymentForm.receivedAt,
      paymentMethod: paymentForm.paymentMethod || undefined,
      note: paymentForm.note || undefined,
      allocations: allocations.map((item) => ({ projectId: item.projectId, amount: Number(item.amount) })),
    };
    const path = editingPaymentId.value ? `/api/payments/${editingPaymentId.value}` : '/api/payments';
    const method = editingPaymentId.value ? 'PATCH' : 'POST';

    /**
     * 超额收款二次确认（业务确认 2026-10-14）。
     *
     * 允许超收（预收款/多期款），但不能悄悄收超：后端检测到「已收 + 本次 > 应收净额」
     * 会返回 409 + OVERPAY_CONFIRMATION_REQUIRED 与超收明细；这里弹确认框，
     * 用户确认后带 `confirmOverpay: true` 重提。
     *
     * 这里用原生 fetch 而不是页面的 `request` 助手 —— 后者会把错误压成一句 message，
     * 拿不到 HTTP 状态码与业务错误码，无法区分"超收待确认"和"真失败"。
     */
    const send = async (confirmOverpay: boolean) => {
      const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}` },
        body: JSON.stringify({ ...body, ...(confirmOverpay ? { confirmOverpay: true } : {}) }),
      });
      const payload = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, payload };
    };

    let result = await send(false);

    if (!result.ok && result.status === 409 && result.payload?.code === 'OVERPAY_CONFIRMATION_REQUIRED') {
      const overpays: Array<{ contractNo: string; overAmount: number; receivable: number; collected: number }> =
        result.payload.overpays ?? [];
      const lines = overpays.map(
        (item) =>
          `合同 ${item.contractNo}：应收净额 ¥${Number(item.receivable).toFixed(2)}，已收 ¥${Number(item.collected).toFixed(2)}，本次将超收 ¥${Number(item.overAmount).toFixed(2)}`,
      );
      try {
        await ElMessageBox.confirm(
          `${lines.join('\n')}\n\n确认要继续登记这笔超额回款吗？`,
          '本次回款超出合同应收金额',
          { type: 'warning', confirmButtonText: '确认继续', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' },
        );
      } catch {
        return; // 用户取消，保留弹窗内容让其修改金额
      }
      result = await send(true);
    }

    if (!result.ok) {
      throw new Error(result.payload?.message ?? '回款保存失败');
    }

    ElMessage.success(editingPaymentId.value ? '回款已更新' : '回款已登记');
    paymentDialog.value = false;
    resetPaymentForm();
    await refreshDetail();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '回款保存失败');
  } finally {
    paymentSaving.value = false;
  }
}

function removePayment(row: ProjectPayment) {
  deletingPayment.value = { id: row.payment.id, receiptNo: row.payment.receiptNo };
}

async function confirmDeletePayment(reason: string) {
  const target = deletingPayment.value;
  if (!target) return;
  const ok = await runDelete(
    `/api/payments/${target.id}`,
    reason,
    '回款已删除，合同与项目的已收款已同步减少',
    refreshDetail,
  );
  if (ok) deletingPayment.value = null;
}

/* ---------------- 成本（登记在项目上） ---------------- */

function resetCostForm() {
  Object.assign(costForm, { costType: '', amount: '', incurredAt: todayCalendarDate(), note: '' });
  editingCostId.value = null;
}

function openCreateCost() {
  resetCostForm();
  costDialog.value = true;
}

function openEditCost(row: ProjectCost) {
  editingCostId.value = row.id;
  Object.assign(costForm, { costType: row.costType, amount: String(row.amount), incurredAt: toCalendarDateText(row.incurredAt), note: row.note ?? '' });
  costDialog.value = true;
}

async function saveCost() {
  if (!detail.value) return;
  if (!costForm.costType.trim()) {
    ElMessage.warning('请输入成本类型');
    return;
  }
  if (!costForm.amount || Number(costForm.amount) <= 0) {
    ElMessage.warning('请输入有效的金额');
    return;
  }
  costSaving.value = true;
  try {
    const body = {
      projectId: detail.value.id,
      costType: costForm.costType.trim(),
      amount: Number(costForm.amount),
      incurredAt: costForm.incurredAt,
      note: costForm.note || undefined,
    };
    if (editingCostId.value) {
      await request(`/api/costs/${editingCostId.value}`, { method: 'PATCH', body: JSON.stringify(body) });
      ElMessage.success('成本已更新');
    } else {
      await request('/api/costs', { method: 'POST', body: JSON.stringify(body) });
      ElMessage.success('成本已登记');
    }
    costDialog.value = false;
    resetCostForm();
    await refreshDetail();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '成本保存失败');
  } finally {
    costSaving.value = false;
  }
}

function removeCost(row: ProjectCost) {
  deletingCost.value = { id: row.id, costType: row.costType, amount: money(row.amount) };
}

async function confirmDeleteCost(reason: string) {
  const target = deletingCost.value;
  if (!target) return;
  const ok = await runDelete(`/api/costs/${target.id}`, reason, '成本已删除，合同与项目的成本已同步减少', refreshDetail);
  if (ok) deletingCost.value = null;
}

/* ---------------- 项目自身增删改 ---------------- */

function resetForm() {
  Object.assign(form, { contractId: '', projectName: '', projectType: '', statusCode: 'PENDING', startDate: '', dueDate: '' });
  customFieldValues.value = {};
  editingVersion.value = null;
  editingId.value = null;
}

function openCreate() {
  resetForm();
  dialogVisible.value = true;
}

function openEdit(project: Project) {
  editingId.value = project.id;
  Object.assign(form, {
    contractId: project.contractId,
    projectName: project.projectName,
    projectType: project.projectType ?? '',
    statusCode: project.statusCode,
    startDate: toCalendarDateText(project.startDate),
    dueDate: toCalendarDateText(project.dueDate),
  });
  customFieldValues.value = { ...(project.customFields ?? {}) };
  editingVersion.value = project.version;
  dialogVisible.value = true;
}

async function saveProject() {
  if (!editingId.value && !form.contractId) {
    ElMessage.warning('请选择所属合同');
    return;
  }
  if (!form.projectName.trim()) {
    ElMessage.warning('请输入项目名称');
    return;
  }
  saving.value = true;
  try {
    const body = { ...form, projectName: form.projectName.trim(), projectType: form.projectType || undefined, startDate: form.startDate || undefined, dueDate: form.dueDate || undefined, customFields: customFieldValues.value };
    if (editingId.value) {
      const { contractId: _contractId, ...updateBody } = body;
      // 带上版本号做乐观锁：他人已修改时后端返回 409
      await request(`/api/projects/${editingId.value}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...updateBody, version: editingVersion.value ?? 0, statusReason: '在项目编辑中调整状态' }),
      });
      ElMessage.success('项目已更新');
    } else {
      await request('/api/projects', { method: 'POST', body: JSON.stringify(body) });
      ElMessage.success('项目已创建');
    }
    dialogVisible.value = false;
    resetForm();
    await loadProjects();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('已被他人更新')) {
      ElMessage.warning('该项目已被他人修改，已为你重新加载最新数据，请确认后再提交');
      await loadProjects();
      if (editingId.value) {
        const fresh = await request<Project>(`/api/projects/${editingId.value}`);
        editingVersion.value = fresh.version;
      }
      saving.value = false;
      return;
    }
    ElMessage.error(error instanceof Error ? error.message : '项目保存失败');
  } finally {
    saving.value = false;
  }
}

/** 待删除的项目 / 回款 / 成本（PRD 7.2 均需「勾选风险 + 必填原因」） */
const deletingProject = ref<Project | null>(null);
const deletingPayment = ref<{ id: string; receiptNo: string } | null>(null);
const deletingCost = ref<{ id: string; costType: string; amount: string } | null>(null);
const deleteSaving = ref(false);

/** 删除类请求的统一执行：成功提示 + 刷新 + 把后端拒绝原因原样显示 */
async function runDelete(path: string, reason: string, successMessage: string, after: () => Promise<void>) {
  deleteSaving.value = true;
  try {
    await request(path, { method: 'DELETE', body: JSON.stringify({ reason }) });
    ElMessage.success(successMessage);
    await after();
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败');
    return false;
  } finally {
    deleteSaving.value = false;
  }
}

function removeProject(project: Project) {
  deletingProject.value = project;
}

async function confirmDeleteProject(reason: string) {
  const project = deletingProject.value;
  if (!project) return;
  const ok = await runDelete(
    `/api/projects/${project.id}`,
    reason,
    '项目已删除，可在「管理系统 → 已删除数据」中恢复',
    loadProjects,
  );
  if (ok) deletingProject.value = null;
}

function handlePageChange(nextPage: number) { page.value = nextPage; void loadProjects(); }
function handlePageSizeChange(nextSize: number) { pageSize.value = nextSize; page.value = 1; void loadProjects(); }

onMounted(async () => {
  // 从合同详情跳转过来时带上项目编号，直接定位到该项目
  if (props.keyword) query.keyword = props.keyword;
  await Promise.all([loadProjects(), loadContracts(), loadStatusOptions()]);
});
</script>

<template>
  <section class="project-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">系统 A · 项目管理</p>
        <h1>项目</h1>
        <p class="subtitle">项目由合同按件数自动生成。回款与成本登记在项目上，点开项目编号即可在详情中维护。</p>
      </div>
      <el-button v-if="props.canExportProjects" :loading="exportingProjects" @click="exportProjects({ keyword: query.keyword, statusCode: query.statusCode, contractId: query.contractId })">导出项目列表</el-button>
      <el-button type="primary" @click="openCreate">新建项目</el-button>
    </div>

    <el-card shadow="never" class="content-card project-card">
      <div class="filter-row">
        <el-input v-model="query.keyword" clearable placeholder="搜索项目编号、项目名称或合同" class="keyword-input" @keyup.enter="page = 1; loadProjects()" />
        <el-select v-model="query.statusCode" clearable placeholder="项目状态" class="status-input" @change="page = 1; loadProjects()">
          <el-option v-for="item in projectStatuses" :key="item.code" :label="item.label" :value="item.code" />
        </el-select>
        <el-select v-model="query.contractId" clearable filterable placeholder="所属合同" class="contract-input" @change="page = 1; loadProjects()">
          <el-option v-for="contract in contracts" :key="contract.id" :label="`${contract.contractNo} · ${contract.customer.name}`" :value="contract.id" />
        </el-select>
        <el-button @click="page = 1; loadProjects()">查询</el-button>
        <el-button text @click="query.keyword = ''; query.statusCode = ''; query.contractId = ''; page = 1; loadProjects()">重置</el-button>
      </div>

      <el-table v-loading="loading" :data="projects" stripe empty-text="暂无项目">
        <el-table-column label="项目编号" min-width="170">
          <template #default="scope"><el-button link type="primary" @click="openDetail(scope.row)">{{ scope.row.projectNo }}</el-button></template>
        </el-table-column>
        <el-table-column prop="projectName" label="项目名称" min-width="200" />
        <el-table-column label="所属合同" min-width="220">
          <template #default="scope">{{ scope.row.contract.contractNo }} · {{ scope.row.contract.customer.name }}</template>
        </el-table-column>
        <el-table-column label="回款 / 成本" width="120">
          <template #default="scope">{{ scope.row._count.payments }} / {{ scope.row._count.costs }}</template>
        </el-table-column>
        <el-table-column label="流程 / 当前节点" min-width="200">
          <template #default="scope">
            <template v-if="scope.row.workflow?.templateName">
              <el-tag size="small" effect="plain">{{ scope.row.workflow.templateName }}</el-tag>
              <span class="workflow-node-name">{{ scope.row.workflow.currentNodeName ?? '未进入节点' }}</span>
            </template>
            <span v-else class="workflow-node-name">未绑定流程</span>
          </template>
        </el-table-column>
        <el-table-column label="截止日" width="120">
          <template #default="scope">{{ scope.row.dueDate ? new Date(scope.row.dueDate).toLocaleDateString('zh-CN') : '未设置' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="scope"><el-tag size="small" :type="scope.row.statusCode === 'COMPLETED' ? 'success' : scope.row.statusCode === 'EXCEPTION' ? 'danger' : 'info'">{{ statusLabel(scope.row.statusCode) }}</el-tag></template>
        </el-table-column>
        <CustomFieldColumns :token="props.token" module-key="project" :rows="projects" />
        <el-table-column label="操作" fixed="right" width="200">
          <template #default="scope">
            <el-button link type="primary" @click="openDetail(scope.row)">详情</el-button>
            <el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button>
            <el-button link type="danger" @click="removeProject(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="pagination-row"><el-pagination v-model:current-page="page" v-model:page-size="pageSize" background layout="total, sizes, prev, pager, next" :total="total" @current-change="handlePageChange" @size-change="handlePageSizeChange" /></div>
    </el-card>

    <!-- 项目详情：回款与成本都在这里维护 -->
    <el-dialog v-model="detailVisible" :title="`项目详情 · ${detail?.projectNo ?? ''}`" width="960px">
      <el-skeleton v-if="detailLoading" :rows="6" animated />
      <template v-else-if="detail">
        <el-descriptions :column="3" border>
          <el-descriptions-item label="项目名称">{{ detail.projectName }}</el-descriptions-item>
          <el-descriptions-item label="所属合同">{{ detail.contract.contractNo }}</el-descriptions-item>
          <el-descriptions-item label="客户">{{ detail.contract.customer.name }}</el-descriptions-item>
          <el-descriptions-item label="项目类型">{{ detail.projectType || '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="负责人">{{ detail.owner?.displayName ?? '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ statusLabel(detail.statusCode) }}</el-descriptions-item>
          <el-descriptions-item label="业务起算日期">{{ detail.startDate ? new Date(detail.startDate).toLocaleDateString('zh-CN') : '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="项目截止日">{{ detail.dueDate ? new Date(detail.dueDate).toLocaleDateString('zh-CN') : '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="序号">{{ detail.sequence }}</el-descriptions-item>
        </el-descriptions>

        <ProjectWorkflow
          v-if="detail"
          :token="props.token"
          :project-id="detail.id"
          :initial="(detail.workflow as never)"
          @changed="onWorkflowChanged"
        />

        <el-row :gutter="16" class="summary-row detail-summary">
          <el-col :span="8"><el-card shadow="never" class="summary-card"><span class="summary-label">本项目回款</span><strong>{{ money(detail.totals.collectedAmount) }}</strong><small>分摊到本项目的回款合计</small></el-card></el-col>
          <el-col :span="8"><el-card shadow="never" class="summary-card"><span class="summary-label">本项目成本</span><strong>{{ money(detail.totals.costAmount) }}</strong><small>登记在本项目的成本合计</small></el-card></el-col>
          <el-col :span="8"><el-card shadow="never" class="summary-card"><span class="summary-label">项目净收益</span><strong :class="{ 'profit-negative': Number(detail.totals.netProfit) < 0 }">{{ money(detail.totals.netProfit) }}</strong><small>本项目回款 - 本项目成本</small></el-card></el-col>
        </el-row>

        <el-tabs v-model="detailTab" @tab-change="handleDetailTab">
          <el-tab-pane label="流转记录" name="history">
            <div class="tab-toolbar">
              <span class="tab-hint">项目状态变化与节点流转的历史记录，只增不改。节点推进后会自动写入。</span>
              <el-button size="small" :loading="historyLoading" @click="loadProjectHistory">刷新</el-button>
            </div>
            <el-timeline v-if="statusHistory.length > 0" class="status-timeline">
              <el-timeline-item
                v-for="item in statusHistory"
                :key="item.id"
                :timestamp="new Date(item.changedAt).toLocaleString('zh-CN')"
                placement="top"
              >
                <div class="history-line">
                  <el-tag v-if="item.fromStatusLabel" size="small" type="info">{{ item.fromStatusLabel }}</el-tag>
                  <span v-if="item.fromStatusLabel" class="history-arrow">→</span>
                  <el-tag size="small">{{ item.toStatusLabel ?? item.toStatusCode }}</el-tag>
                  <span class="history-operator">{{ item.operator?.displayName ?? '系统' }}</span>
                </div>
                <p v-if="item.reason" class="history-reason">{{ item.reason }}</p>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-else :description="historyLoading ? '加载中…' : '暂无流转记录'" />

            <template v-if="nodeHistory.length > 0">
              <el-divider content-position="left">节点流转</el-divider>
              <el-timeline class="status-timeline">
                <el-timeline-item
                  v-for="item in nodeHistory"
                  :key="item.id"
                  :timestamp="new Date(item.actionAt).toLocaleString('zh-CN')"
                  placement="top"
                >
                  <div class="history-line">
                    <el-tag v-if="item.fromNodeName" size="small" type="info">{{ item.fromNodeName }}</el-tag>
                    <span v-if="item.fromNodeName" class="history-arrow">→</span>
                    <el-tag size="small">{{ item.toNodeName }}</el-tag>
                    <span class="history-operator">{{ item.operator?.displayName ?? '系统' }}</span>
                  </div>
                  <p v-if="item.note" class="history-reason">{{ item.note }}</p>
                </el-timeline-item>
              </el-timeline>
            </template>
          </el-tab-pane>
          <el-tab-pane v-if="canAccessFiles" label="项目文件" name="files">
            <FileAttachmentPanel :token="props.token" resource-type="Project" :resource-id="detail.id" title="项目文件" :can-download="props.canDownloadFiles" :can-upload="props.canUploadFiles" :can-delete="props.canDeleteFiles" />
          </el-tab-pane>
          <el-tab-pane label="官文管理" name="officialDocumentList">
            <OfficialDocumentPanel
              :token="props.token"
              :project-id="detail.id"
              :customer-id="detail.contract.customer.id"
              :can-manage="has('official_document.manage')"
              :can-delete="has('official_document.delete')"
              :can-view-files="Boolean(props.canViewFiles)"
              :can-download-files="Boolean(props.canDownloadFiles)"
              :can-upload-files="Boolean(props.canUploadFiles)"
              :can-delete-files="Boolean(props.canDeleteFiles)"
              :can-access-files="Boolean(props.canViewFiles) && canAccessFiles"
              :initial-needs-mail-only="Boolean(props.needsMail)"
              :cross-project="Boolean(props.needsMail)"
              :can-view-mail="has('mail_delivery.read')"
              :can-manage-mail="has('mail_delivery.manage')"
              :can-delete-mail="has('mail_delivery.delete')"
            />
          </el-tab-pane>
          <el-tab-pane label="动作记录" name="actionRecords">
            <ActionRecordPanel
              :token="props.token"
              :project-id="detail.id"
              :can-manage="has('action_record.manage')"
              :can-delete="has('action_record.delete')"
            />
          </el-tab-pane>
          <el-tab-pane label="申报结果" name="filingResults">
            <FilingResultPanel
              :token="props.token"
              :project-id="detail.id"
              :can-manage="has('filing_result.manage')"
              :can-delete="has('filing_result.delete')"
            />
          </el-tab-pane>
          <el-tab-pane label="回款记录" name="payments">
            <div class="tab-toolbar">
              <span class="tab-hint">回款登记在项目上；一笔回款可在同一合同下的多个项目之间拆分。合同里的已收款由这些记录自动汇总。</span>
              <el-button v-if="props.canExportPayments" size="small" :loading="exportingPayments" @click="exportPayments({ projectId: detail.id })">导出本项目回款</el-button>
              <el-button type="primary" size="small" @click="openCreatePayment">登记回款</el-button>
            </div>
            <el-table :data="detail.payments" stripe empty-text="暂无回款">
              <el-table-column label="回款单号" prop="payment.receiptNo" min-width="140" />
              <el-table-column label="本项目分摊金额" width="150">
                <template #default="scope">{{ money(scope.row.amount) }}</template>
              </el-table-column>
              <el-table-column label="整单金额" width="130">
                <template #default="scope">{{ money(scope.row.payment.amount) }}</template>
              </el-table-column>
              <el-table-column label="回款日期" width="120">
                <template #default="scope">{{ new Date(scope.row.payment.receivedAt).toLocaleDateString('zh-CN') }}</template>
              </el-table-column>
              <el-table-column label="方式" width="110"><template #default="scope">{{ scope.row.payment.paymentMethod || '未设置' }}</template></el-table-column>
              <el-table-column label="备注" min-width="120"><template #default="scope">{{ scope.row.payment.note || '-' }}</template></el-table-column>
              <el-table-column label="操作" width="130" fixed="right">
                <template #default="scope">
                  <el-button link type="primary" @click="openEditPayment(scope.row)">编辑</el-button>
                  <el-button link type="danger" @click="removePayment(scope.row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="成本记录" name="costs">
            <div class="tab-toolbar">
              <span class="tab-hint">成本登记在项目上，合同成本由项目成本汇总得出。</span>
              <el-button type="primary" size="small" @click="openCreateCost">登记成本</el-button>
            </div>
            <el-table :data="detail.costs" stripe empty-text="暂无成本">
              <el-table-column prop="costType" label="成本类型" min-width="140" />
              <el-table-column label="金额" width="140"><template #default="scope">{{ money(scope.row.amount) }}</template></el-table-column>
              <el-table-column label="发生日期" width="120"><template #default="scope">{{ new Date(scope.row.incurredAt).toLocaleDateString('zh-CN') }}</template></el-table-column>
              <el-table-column prop="note" label="备注" min-width="150" />
              <el-table-column label="操作" width="130" fixed="right">
                <template #default="scope">
                  <el-button link type="primary" @click="openEditCost(scope.row)">编辑</el-button>
                  <el-button link type="danger" @click="removeCost(scope.row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </template>
    </el-dialog>

    <!-- 回款登记 / 编辑 -->
    <el-dialog v-model="paymentDialog" :title="editingPaymentId ? '编辑回款' : '登记回款'" width="660px" @closed="resetPaymentForm">
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="回款总额" required><el-input v-model="paymentForm.amount" type="number" min="0.01" placeholder="0.00" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="回款日期" required><el-date-picker v-model="paymentForm.receivedAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width: 100%" /></el-form-item></el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="回款方式"><el-input v-model="paymentForm.paymentMethod" placeholder="例如：银行转账" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="分摊合计"><el-input :model-value="allocationTotal.toFixed(2)" readonly /></el-form-item></el-col>
        </el-row>
        <el-form-item label="项目分摊" required>
          <div class="allocation-list">
            <div v-for="(allocation, index) in paymentAllocations" :key="index" class="allocation-row">
              <el-select v-model="allocation.projectId" filterable placeholder="选择项目" class="allocation-project">
                <el-option v-if="detail" :label="`${detail.projectNo} · ${detail.projectName}（本项目）`" :value="detail.id" />
                <el-option v-for="item in siblingProjects" :key="item.id" :label="`${item.projectNo} · ${item.projectName}`" :value="item.id" />
              </el-select>
              <el-input v-model="allocation.amount" type="number" min="0.01" placeholder="分摊金额" class="allocation-amount" />
              <el-button text type="danger" :disabled="paymentAllocations.length === 1" @click="removeAllocation(index)">移除</el-button>
            </div>
          </div>
          <el-button link type="primary" @click="addAllocation">+ 添加项目分摊</el-button>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="paymentForm.note" type="textarea" :rows="2" placeholder="可选" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="paymentDialog = false">取消</el-button>
        <el-button type="primary" :loading="paymentSaving" @click="savePayment">保存</el-button>
      </template>
    </el-dialog>

    <!-- 成本登记 / 编辑 -->
    <el-dialog v-model="costDialog" :title="editingCostId ? '编辑成本' : '登记成本'" width="560px" @closed="resetCostForm">
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="成本类型" required><el-input v-model="costForm.costType" placeholder="例如：官费、外包费" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="金额" required><el-input v-model="costForm.amount" type="number" min="0.01" placeholder="0.00" /></el-form-item></el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="发生日期" required><el-date-picker v-model="costForm.incurredAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width: 100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="备注"><el-input v-model="costForm.note" placeholder="可选" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="costDialog = false">取消</el-button>
        <el-button type="primary" :loading="costSaving" @click="saveCost">保存</el-button>
      </template>
    </el-dialog>

    <!-- 项目新建 / 编辑 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑项目' : '新建项目'" width="660px" @closed="resetForm">
      <el-form label-position="top">
        <el-form-item v-if="!editingId" label="所属合同" required>
          <el-select v-model="form.contractId" filterable placeholder="请选择合同" style="width: 100%">
            <el-option v-for="contract in contracts" :key="contract.id" :label="`${contract.contractNo} · ${contract.customer.name}`" :value="contract.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="项目名称" required><el-input v-model="form.projectName" placeholder="请输入项目名称" /></el-form-item>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="项目类型">
              <TypeSelector v-model="form.projectType" :token="props.token" module-key="projectType" placeholder="请选择项目类型" />
              <span class="field-hint">决定本项目走哪套流程：与流程模板同名的类型（专利/商标/软著/项目）走专用流程，其余走通用流程。</span>
            </el-form-item>
          </el-col>
          <el-col :span="12"><el-form-item label="项目状态"><el-select v-model="form.statusCode" style="width: 100%"><el-option v-for="item in projectStatuses" :key="item.code" :label="item.label" :value="item.code" /></el-select></el-form-item></el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="业务起算日期"><el-date-picker v-model="form.startDate" type="date" value-format="YYYY-MM-DD" placeholder="可选" style="width: 100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="项目截止日"><el-date-picker v-model="form.dueDate" type="date" value-format="YYYY-MM-DD" placeholder="可选" style="width: 100%" /></el-form-item></el-col>
        </el-row>
        <CustomFieldForm :token="props.token" module-key="project" v-model="customFieldValues" />
      </el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveProject">保存</el-button></template>
    </el-dialog>

    <!-- PRD 7.2 高危删除确认（勾选风险 + 必填原因） -->
    <DangerDeleteDialog
      :model-value="deletingProject !== null"
      title="删除项目"
      :target="deletingProject ? `项目 ${deletingProject.projectNo} ${deletingProject.projectName}` : ''"
      consequences="其下未完成的官文、动作记录与申报结果会一并作废。"
      :loading="deleteSaving"
      @update:model-value="(value: boolean) => { if (!value) deletingProject = null; }"
      @confirm="confirmDeleteProject"
    />
    <DangerDeleteDialog
      :model-value="deletingPayment !== null"
      title="删除回款"
      :target="deletingPayment ? `回款 ${deletingPayment.receiptNo}` : ''"
      consequences="删除后合同与项目的已收款都会同步减少，合同状态会重新计算。"
      :loading="deleteSaving"
      @update:model-value="(value: boolean) => { if (!value) deletingPayment = null; }"
      @confirm="confirmDeletePayment"
    />
    <DangerDeleteDialog
      :model-value="deletingCost !== null"
      title="删除成本"
      :target="deletingCost ? `成本 ${deletingCost.costType} ${deletingCost.amount}` : ''"
      consequences="删除后合同与项目的成本、净收益会同步变化。"
      :loading="deleteSaving"
      @update:model-value="(value: boolean) => { if (!value) deletingCost = null; }"
      @confirm="confirmDeleteCost"
    />
  </section>
</template>

<style scoped>
.project-card {
  min-height: 420px;
}

.contract-input {
  width: 240px;
}

.detail-summary {
  margin-top: 18px;
}

.detail-summary .summary-card strong {
  font-size: 22px;
}

.tab-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 12px;
}

.tab-hint {
  color: #8b99ad;
  font-size: 12px;
  line-height: 1.6;
}

.allocation-list {
  width: 100%;
}

.allocation-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}

.allocation-project {
  flex: 1;
}

.allocation-amount {
  width: 150px;
}

.status-timeline {
  padding: 4px 0 0 4px;
}

.history-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.history-arrow {
  color: #8b99ad;
}

.history-operator {
  margin-left: 6px;
  color: #5b6b85;
  font-size: 12px;
}

.history-reason {
  margin: 6px 0 0;
  color: #5b6b85;
  font-size: 13px;
  line-height: 1.7;
}

.workflow-node-name {
  margin-left: 8px;
  color: #5b6b85;
  font-size: 13px;
}
</style>









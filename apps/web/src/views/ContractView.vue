<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import CustomFieldColumns from '../components/CustomFieldColumns.vue';
import CustomFieldForm from '../components/CustomFieldForm.vue';
import TypeSelector from '../components/TypeSelector.vue';
import DangerDeleteDialog from '../components/DangerDeleteDialog.vue';
import { useExport } from '../composables/useExport';
import FileAttachmentPanel from '../components/FileAttachmentPanel.vue';
import { toCalendarDateText, todayCalendarDate } from '../utils/calendar-date';

type CustomerOption = { id: string; name: string };
type OwnerOption = { id: string; username: string; displayName: string };
type Contract = {
  id: string;
  contractNo: string;
  customerId: string;
  customer: CustomerOption;
  contractType: string | null;
  /** PRD 8.2 补齐字段 */
  product: string | null;
  amount: string | number;
  unitPrice: string | number | null;
  itemCount: number;
  paymentTerm: string | null;
  remark: string | null;
  companyName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  companyAddress: string | null;
  signedAt: string | null;
  expiryDate: string | null;
  businessStartAt: string | null;
  legallyDueAt: string | null;
  internalSafetyDate: string | null;
  statusCode: string;
  /** 业务起算日：由业务人员人工填写 */
  createdAt: string;
  /** 合同终止（PRD 4.2） */
  terminatedAt?: string | null;
  terminationType?: string | null;
  terminationReason?: string | null;
  unfinishedProjectAction?: string | null;
  unpaidAmountAction?: string | null;
  version: number;
  customFields?: Record<string, unknown> | null;
  owner: { id: string; displayName: string } | null;
  _count: { projects: number; paymentAllocations: number; costs: number };
};

type ProjectBrief = { id: string; projectNo: string; projectName: string };

type ContractDetail = Contract & {
  projects: Array<ProjectBrief & { statusCode: string; sequence: number }>;
  // 回款/成本都是其下项目的汇总，合同上不直接登记，因此这里只读展示
  receipts: Array<{
    id: string;
    receiptNo: string;
    amount: string | number;
    receivedAt: string;
    paymentMethod: string | null;
    note: string | null;
    allocations: Array<{ amount: string | number; project: ProjectBrief }>;
    contractAllocations: Array<{ contractId: string; amount: string | number }>;
  }>;
  costs: Array<{ id: string; costType: string; amount: string | number; incurredAt: string; note: string | null; project: ProjectBrief }>;
  /** 金额调整（退款/折扣/部分豁免） */
  adjustments: Array<{
    id: string;
    adjustType: string;
    amount: string | number;
    reason: string | null;
    occurredAt: string;
    operator: { id: string; displayName: string } | null;
  }>;
  /** 终止信息，未终止时为 null */
  termination: {
    terminatedAt: string;
    terminationType: string | null;
    terminationReason: string | null;
    unfinishedProjectAction: string | null;
    unpaidAmountAction: string | null;
    operatedBy: string | null;
  } | null;
  totals: {
    contractAmount: string;
    collectedAmount: string;
    adjustedAmount: string;
    netReceivable: string;
    unpaidAmount: string;
    costAmount: string;
    netProfit: string;
  };
};

type CreateContractResult = Contract & { generatedProjectCount?: number; amountWarning?: string | null };
type StatusOption = { code: string; label: string; color: string | null };
const props = defineProps<{
  token: string;
  canAssignOwner?: boolean;
  canViewFiles?: boolean;
  canDownloadFiles?: boolean;
  canUploadFiles?: boolean;
  canDeleteFiles?: boolean;
  /** 导出权限（PRD 4.12）：无权限时不显示导出按钮，避免点开才被 403 拒绝 */
  canExport?: boolean;
}>();

/** 导出合同列表（PRD 4.12「合同列表页导出合同列表」），筛选条件与列表完全一致 */
const { exporting, exportData } = useExport(() => props.token, 'contract', '合同');
const loading = ref(false);
const saving = ref(false);
const contracts = ref<Contract[]>([]);
const customers = ref<CustomerOption[]>([]);
const owners = ref<OwnerOption[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const dialogVisible = ref(false);
const detailVisible = ref(false);
const detailLoading = ref(false);
const selectedContract = ref<ContractDetail | null>(null);
const editingId = ref<string | null>(null);
const editingRow = ref<Contract | null>(null);
const editingContractProjectCount = computed(() => editingRow.value?._count.projects ?? 0);
const detailTab = ref('projects');
/** 合同状态枚举来自系统 B（StatusDefinition），页面不再写死中文状态名 */
const contractStatuses = ref<StatusOption[]>([]);
const statusLabel = (code: string) => contractStatuses.value.find((item) => item.code === code)?.label ?? '未知状态';

/**
 * 项目状态枚举：合同详情的「项目」标签里要显示项目状态。
 *
 * 原来那一列直接 `prop="statusCode"`，于是界面上露出内部编码 `PENDING`
 * —— 同一张表里项目名称是中文、状态却是英文编码。
 */
const projectStatuses = ref<StatusOption[]>([]);
const projectStatusLabel = (code: string) =>
  projectStatuses.value.find((item) => item.code === code)?.label ?? code;

async function loadStatusOptions() {
  try {
    const grouped = await request<Record<string, StatusOption[]>>('/api/options/statuses');
    contractStatuses.value = grouped.contract ?? [];
    projectStatuses.value = grouped.project ?? [];
  } catch {
    // 状态枚举读取失败时退回显示原始编码，不阻塞页面
    contractStatuses.value = [];
    projectStatuses.value = [];
  }
}

/** 点击项目编号跳转到项目页，并按项目编号定位，便于直接进项目详情维护回款/成本。 */
const emit = defineEmits<{ navigate: [payload: { target: string; keyword?: string }] }>();

function switchToProjects(projectNo: string) {
  detailVisible.value = false;
  emit('navigate', { target: '项目', keyword: projectNo });
}

function money(value: string | number) {
  return `¥ ${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`;
}

function receiptAmountForContract(receipt: ContractDetail['receipts'][number]) {
  const allocated = receipt.contractAllocations?.reduce((sum, item) => sum + Number(item.amount), 0) ?? 0;
  return allocated > 0 ? allocated : Number(receipt.amount);
}

/** 选项内部编码 → 显示名；历史选项已删除时仍以中文提示占位。 */
function optionLabel(options: Array<{ code: string; label: string }>, code: string | null | undefined) {
  if (!code) return '未设置';
  return options.find((item) => item.code === code || item.label === code)?.label ?? '历史选项';
}

type StatusHistoryItem = {
  id: string;
  fromStatusCode: string | null;
  toStatusCode: string;
  fromStatusLabel: string | null;
  toStatusLabel: string | null;
  reason: string | null;
  changedAt: string;
  operator: { displayName: string } | null;
};
const statusHistory = ref<StatusHistoryItem[]>([]);
const historyLoading = ref(false);

async function loadStatusHistory() {
  if (!selectedContract.value) return;
  historyLoading.value = true;
  try {
    statusHistory.value = await request<StatusHistoryItem[]>(`/api/contracts/${selectedContract.value.id}/status-history`);
  } catch {
    statusHistory.value = [];
  } finally {
    historyLoading.value = false;
  }
}

function handleDetailTab(name: string | number) {
  if (name === 'history') void loadStatusHistory();
}

/** 乐观锁冲突：提示用户数据已被他人修改 */
async function handleConflict(error: unknown, reload: () => Promise<void>) {
  const message = error instanceof Error ? error.message : '';
  if (!message.includes('已被他人更新')) return false;
  ElMessage.warning('该合同已被他人修改，已为你重新加载最新数据，请确认后再提交');
  await reload();
  return true;
}
const query = reactive({ keyword: '', statusCode: '', customerId: '' });
const form = reactive({
  contractNo: '',
  customerId: '',
  ownerId: '',
  contractType: '',
  product: '',
  amount: '',
  unitPrice: '',
  itemCount: 1,
  paymentTerm: '',
  remark: '',
  companyName: '',
  contactName: '',
  contactPhone: '',
  contactEmail: '',
  companyAddress: '',
  autoGenerateProjects: true,
  signedAt: '',
  expiryDate: '',
  businessStartAt: todayCalendarDate(),
  legallyDueAt: '',
  internalSafetyDate: '',
  statusCode: 'ACTIVE',
});
/** 编辑时的乐观锁版本号：取打开表单时的版本，提交时回传 */
const editingVersion = ref<number | null>(null);
/** 自定义字段的取值，按系统 B 的字段定义动态渲染 */
const customFieldValues = ref<Record<string, unknown>>({});
/** 单价 × 件数 与金额不一致时的提示 */
const amountWarning = ref<string | null>(null);

/* ---------------- 系统算建议截止日（PRD 4.7） ---------------- */

type DeadlineSuggestion = {
  suggestedLegallyDueAt: string;
  suggestedInternalSafetyDate: string;
  timeLimitDays: number;
  timeLimitSource: 'CONTRACT_TYPE' | 'GLOBAL_DEFAULT';
  safetyMarginDays: number;
  explanation: string;
  cappedByExpiryDate: boolean;
  baseDate: string;
};

const suggestion = ref<DeadlineSuggestion | null>(null);
const suggesting = ref(false);

/** 向服务端要一次建议值；只算不写库，填进表单后人工可改 */
async function fetchSuggestion(options: { silent?: boolean } = {}) {
  if (!form.contractType) {
    if (!options.silent) ElMessage.warning('请先选择合同类型，系统才能推算建议截止日');
    return;
  }
  suggesting.value = true;
  try {
    const params = new URLSearchParams({ contractType: form.contractType });
    if (form.expiryDate) params.set('expiryDate', form.expiryDate);
    if (form.businessStartAt) params.set('businessStartAt', form.businessStartAt);
    // 编辑已有合同时传 contractId，兼容历史合同未填写人工起算日的情况
    if (editingId.value) params.set('contractId', editingId.value);
    const result = await request<DeadlineSuggestion>(`/api/contracts/suggest-deadline?${params.toString()}`);
    suggestion.value = result;
    if (!options.silent) ElMessage.success('已按系统建议值填充，请复核后确认或修改');
  } catch (error) {
    suggestion.value = null;
    if (!options.silent) ElMessage.error(error instanceof Error ? error.message : '推算建议截止日失败');
  } finally {
    suggesting.value = false;
  }
}

/** 把建议值填进表单（人工仍可覆盖） */
async function applySuggestion() {
  await fetchSuggestion({ silent: true });
  if (!suggestion.value) {
    if (form.contractType) ElMessage.error('未能推算建议截止日，请检查合同类型是否已在选项配置中设置时限');
    else ElMessage.warning('请先选择合同类型');
    return;
  }
  form.legallyDueAt = suggestion.value.suggestedLegallyDueAt;
  form.internalSafetyDate = suggestion.value.suggestedInternalSafetyDate;
  ElMessage.success('已填入系统建议值，请复核后确认或修改');
}

function clearSuggestionDates() {
  form.legallyDueAt = '';
  form.internalSafetyDate = '';
}

/** 合同类型或到期日变化时，静默刷新建议值说明，便于人工参考（不自动覆盖已填日期） */
async function onTypeOrExpiryChange() {
  if (form.contractType) await fetchSuggestion({ silent: true });
  else suggestion.value = null;
}

/** 单价 × 件数 与金额是否一致（本地即时提示，服务端也会再算一遍） */
const localAmountWarning = computed(() => {
  const unitPrice = Number(form.unitPrice);
  const amount = Number(form.amount);
  if (!form.unitPrice || !Number.isFinite(unitPrice) || !Number.isFinite(amount)) return null;
  const expected = unitPrice * Number(form.itemCount || 1);
  if (Math.abs(expected - amount) < 0.005) return null;
  return `单价 ¥${unitPrice.toFixed(2)} × 件数 ${form.itemCount} = ¥${expected.toFixed(2)}，与合同金额 ¥${amount.toFixed(2)} 不一致。`;
});

/* ---------------- 合同终止（PRD 4.2 的 5 个要素） ---------------- */

const terminateVisible = ref(false);
const terminateSaving = ref(false);
const terminateForm = reactive({
  terminatedAt: '',
  terminationType: '',
  terminationReason: '',
  unfinishedProjectAction: 'TERMINATE',
  unpaidAmountAction: 'KEEP_CLAIM',
});
const terminateOptions = reactive({
  terminationType: [] as Array<{ code: string; label: string }>,
  unfinishedProjectAction: [] as Array<{ code: string; label: string }>,
  unpaidAmountAction: [] as Array<{ code: string; label: string }>,
});

/** 合同金额调整 */
const adjustmentVisible = ref(false);
const adjustmentSaving = ref(false);
const adjustmentForm = reactive({ adjustType: '', amount: '', reason: '', occurredAt: '' });
const adjustTypeOptions = ref<Array<{ code: string; label: string }>>([]);
const paymentTermOptions = ref<Array<{ code: string; label: string }>>([]);
const contractTypeOptions = ref<Array<{ code: string; label: string }>>([]);

/**
 * 读取一个受控选项模块。
 *
 * 失败时不再静默返回空数组 —— 那会让下拉"看起来正常但一个选项都没有"，
 * 排查时完全没有线索（曾经因为漏调用加载函数，导致终止弹窗的三个下拉
 * 直接显示内部编码 TERMINATE / KEEP_CLAIM，很难看出是选项没加载）。
 * 这里至少打一条控制台警告，把模块名和原因带上；返回值仍为空数组，
 * 不阻断页面渲染。
 */
async function loadOption(moduleKey: string) {
  try {
    return await request<Array<{ code: string; label: string }>>(`/api/options/list/${moduleKey}`);
  } catch (error) {
    console.warn(`[合同] 选项模块「${moduleKey}」加载失败，对应下拉将为空：`, error instanceof Error ? error.message : error);
    return [];
  }
}

async function loadTerminateOptions() {
  const [terminationType, unfinishedProjectAction, unpaidAmountAction, adjustType, paymentTerm, contractType] = await Promise.all([
    loadOption('terminationType'),
    loadOption('unfinishedProjectAction'),
    loadOption('unpaidAmountAction'),
    loadOption('adjustType'),
    loadOption('paymentTerm'),
    loadOption('contractType'),
  ]);
  terminateOptions.terminationType = terminationType;
  terminateOptions.unfinishedProjectAction = unfinishedProjectAction;
  terminateOptions.unpaidAmountAction = unpaidAmountAction;
  adjustTypeOptions.value = adjustType;
  paymentTermOptions.value = paymentTerm;
  contractTypeOptions.value = contractType;
}

/**
 * 确保终止/金额调整相关选项已加载。
 *
 * 这些选项曾经只在 `onMounted` 里加载 —— 但**那一次调用被漏掉了**，
 * 导致三个下拉一直空白/显示内部编码（TERMINATE、KEEP_CLAIM）。
 * 现在改成「打开弹窗前按需补加载」：即使初始化时失败或漏调，用户点开弹窗也能自愈。
 */
async function ensureTerminateOptions() {
  if (terminateOptions.terminationType.length > 0 && adjustTypeOptions.value.length > 0) return;
  await loadTerminateOptions();
}

async function openTerminate() {
  const contract = selectedContract.value;
  if (!contract) return;
  await ensureTerminateOptions();
  Object.assign(terminateForm, {
    terminatedAt: todayCalendarDate(),
    terminationType: terminateOptions.terminationType[0]?.code ?? '',
    terminationReason: '',
    unfinishedProjectAction: 'TERMINATE',
    unpaidAmountAction: 'KEEP_CLAIM',
  });
  terminateVisible.value = true;
}

async function submitTerminate() {
  const contract = selectedContract.value;
  if (!contract) return;
  if (!terminateForm.terminationType) {
    ElMessage.warning('请选择终止类型');
    return;
  }
  if (!terminateForm.terminationReason.trim()) {
    ElMessage.warning('请填写终止原因');
    return;
  }
  terminateSaving.value = true;
  try {
    await request(`/api/contracts/${contract.id}/terminate`, {
      method: 'POST',
      body: JSON.stringify({ version: contract.version, ...terminateForm, terminationReason: terminateForm.terminationReason.trim() }),
    });
    ElMessage.success('合同已终止');
    terminateVisible.value = false;
    detailVisible.value = false;
    await loadContracts();
  } catch (error) {
    const message = error instanceof Error ? error.message : '终止失败';
    if (message.includes('已被他人更新')) {
      ElMessage.warning('该合同已被他人修改，已为你重新加载最新数据，请确认后再终止');
      terminateVisible.value = false;
      detailVisible.value = false;
      await loadContracts();
    } else {
      ElMessage.error(message);
    }
  } finally {
    terminateSaving.value = false;
  }
}

async function openAdjustment() {
  await ensureTerminateOptions();
  Object.assign(adjustmentForm, {
    adjustType: adjustTypeOptions.value[0]?.code ?? '',
    amount: '',
    reason: '',
    occurredAt: todayCalendarDate(),
  });
  adjustmentVisible.value = true;
}

async function submitAdjustment() {
  const contract = selectedContract.value;
  if (!contract) return;
  if (!adjustmentForm.adjustType) {
    ElMessage.warning('请选择调整类型');
    return;
  }
  if (!adjustmentForm.amount || Number(adjustmentForm.amount) <= 0) {
    ElMessage.warning('请填写调整金额');
    return;
  }
  adjustmentSaving.value = true;
  try {
    await request(`/api/contracts/${contract.id}/adjustments`, {
      method: 'POST',
      body: JSON.stringify({ ...adjustmentForm, amount: Number(adjustmentForm.amount) }),
    });
    ElMessage.success('金额调整已记账');
    adjustmentVisible.value = false;
    selectedContract.value = await request<ContractDetail>(`/api/contracts/${contract.id}`);
    await loadContracts();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '调整失败');
  } finally {
    adjustmentSaving.value = false;
  }
}

async function removeAdjustment(adjustmentId: string) {
  const contract = selectedContract.value;
  if (!contract) return;
  try {
    await ElMessageBox.confirm('撤销后这笔调整不再计入应收，记录保留在审计日志中。确定撤销吗？', '撤销金额调整', {
      confirmButtonText: '确认撤销',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    await request(`/api/contracts/${contract.id}/adjustments/${adjustmentId}`, { method: 'DELETE' });
    ElMessage.success('已撤销该笔调整');
    selectedContract.value = await request<ContractDetail>(`/api/contracts/${contract.id}`);
    await loadContracts();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '撤销失败');
  }
}

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}`, ...(options.headers ?? {}) } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? '请求失败');
  return payload as T;
}

async function loadContracts() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize.value) });
    if (query.keyword.trim()) params.set('keyword', query.keyword.trim());
    if (query.statusCode) params.set('statusCode', query.statusCode);
    if (query.customerId) params.set('customerId', query.customerId);
    const result = await request<{ items: Contract[]; total: number }>(`/api/contracts?${params.toString()}`);
    contracts.value = result.items;
    total.value = result.total;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '合同数据加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadCustomers() {
  try {
    const result = await request<{ items: CustomerOption[] }>('/api/customers?page=1&pageSize=100');
    customers.value = result.items;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '客户列表加载失败');
  }
}

async function loadOwners() {
  if (!props.canAssignOwner) return;
  try {
    owners.value = await request<OwnerOption[]>('/api/customers/owners');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '所属销售列表加载失败');
  }
}

async function openDetail(contract: Contract) {
  detailVisible.value = true;
  detailLoading.value = true;
  statusHistory.value = [];
  detailTab.value = 'projects';
  try {
    selectedContract.value = await request<ContractDetail>(`/api/contracts/${contract.id}`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '合同详情加载失败');
    detailVisible.value = false;
  } finally {
    detailLoading.value = false;
  }
}

function resetForm() {
  Object.assign(form, { contractNo: '', customerId: '', ownerId: '', contractType: '', product: '', amount: '', unitPrice: '', itemCount: 1, paymentTerm: '', remark: '', companyName: '', contactName: '', contactPhone: '', contactEmail: '', companyAddress: '', autoGenerateProjects: true, signedAt: '', expiryDate: '', businessStartAt: todayCalendarDate(), legallyDueAt: '', internalSafetyDate: '', statusCode: 'ACTIVE' });
  amountWarning.value = null;
  customFieldValues.value = {};
  editingVersion.value = null;
  editingId.value = null;
  editingRow.value = null;
}

function openCreate() {
  resetForm();
  dialogVisible.value = true;
}

function openEdit(contract: Contract) {
  editingId.value = contract.id;
  editingRow.value = contract;
  Object.assign(form, { contractNo: contract.contractNo, customerId: contract.customerId, ownerId: contract.owner?.id ?? '', contractType: contract.contractType ?? '', product: contract.product ?? '', amount: String(contract.amount), unitPrice: contract.unitPrice === null || contract.unitPrice === undefined ? '' : String(contract.unitPrice), itemCount: contract.itemCount ?? 1, paymentTerm: contract.paymentTerm ?? '', remark: contract.remark ?? '', companyName: contract.companyName ?? '', contactName: contract.contactName ?? '', contactPhone: contract.contactPhone ?? '', contactEmail: contract.contactEmail ?? '', companyAddress: contract.companyAddress ?? '', autoGenerateProjects: false, signedAt: toCalendarDateText(contract.signedAt), expiryDate: toCalendarDateText(contract.expiryDate), businessStartAt: toCalendarDateText(contract.businessStartAt ?? contract.createdAt),
    legallyDueAt: toCalendarDateText(contract.legallyDueAt),
    internalSafetyDate: toCalendarDateText(contract.internalSafetyDate), statusCode: contract.statusCode });
  customFieldValues.value = { ...(contract.customFields ?? {}) };
  editingVersion.value = contract.version;
  dialogVisible.value = true;
}

async function saveContract(openFilesAfterCreate = false) {
  if (!editingId.value && !form.contractNo.trim()) {
    ElMessage.warning('请输入合同编号');
    return;
  }
  if (!editingId.value && !form.customerId) {
    ElMessage.warning('请选择所属客户');
    return;
  }
  if (!form.amount || Number(form.amount) < 0) {
    ElMessage.warning('请输入有效的合同金额');
    return;
  }
  if (!form.businessStartAt) {
    ElMessage.warning('请选择业务起算日');
    return;
  }
  if (!Number.isInteger(Number(form.itemCount)) || Number(form.itemCount) < 1) {
    ElMessage.warning('件数必须是大于等于 1 的整数');
    return;
  }
  saving.value = true;
  try {
    const base = {
      contractType: form.contractType || undefined,
      product: form.product || undefined,
      amount: Number(form.amount),
      unitPrice: form.unitPrice === '' ? undefined : Number(form.unitPrice),
      itemCount: Number(form.itemCount),
      paymentTerm: form.paymentTerm || undefined,
      remark: form.remark || undefined,
      companyName: form.companyName || undefined,
      contactName: form.contactName || undefined,
      contactPhone: form.contactPhone || undefined,
      contactEmail: form.contactEmail || undefined,
      companyAddress: form.companyAddress || undefined,
      ...(props.canAssignOwner && form.ownerId ? { ownerId: form.ownerId } : {}),
      signedAt: form.signedAt || undefined,
      expiryDate: form.expiryDate || undefined,
      businessStartAt: form.businessStartAt || undefined,
      legallyDueAt: form.legallyDueAt || undefined,
      internalSafetyDate: form.internalSafetyDate || undefined,
      customFields: customFieldValues.value,
    };
    if (editingId.value) {
      // 编辑时禁止把件数调到小于已有项目数，避免"改小了但项目还在"的不一致。
      const existingProjects = editingContractProjectCount.value;
      if (Number(form.itemCount) < existingProjects) {
        ElMessage.warning(`该合同已有 ${existingProjects} 个项目，件数不能小于 ${existingProjects}；如需减少请先在项目页删除项目`);
        return;
      }
      // 带上版本号做乐观锁：他人已修改时后端返回 409，提示后重新加载最新数据
      const updated = await request<CreateContractResult>(`/api/contracts/${editingId.value}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...base, version: editingVersion.value ?? 0, statusCode: form.statusCode, statusReason: '在合同编辑中调整状态' }),
      });
      const added = updated.generatedProjectCount ?? 0;
      ElMessage.success(added > 0 ? `合同已更新，并补建 ${added} 个项目` : '合同已更新');
      dialogVisible.value = false;
      resetForm();
      await loadContracts();
      return;
    } else {
      const created = await request<CreateContractResult>('/api/contracts', {
        method: 'POST',
        body: JSON.stringify({ ...base, contractNo: form.contractNo.trim(), customerId: form.customerId, statusCode: form.statusCode, autoGenerateProjects: form.autoGenerateProjects }),
      });
      const generated = created.generatedProjectCount ?? 0;
      ElMessage.success(generated > 0 ? `合同 ${created.contractNo} 已创建，并自动生成 ${generated} 个项目` : `合同 ${created.contractNo} 已创建（未自动生成项目）`);
      // 单价 × 件数 与金额不一致时用服务端算出的文案再提示一次
      if (created.amountWarning) ElMessage.warning(created.amountWarning);
      dialogVisible.value = false;
      resetForm();
      await loadContracts();
      // 合同必须先有 id 才能归属附件；点击“保存并上传附件”时直接打开详情的附件标签。
      if (openFilesAfterCreate && props.canUploadFiles) {
        await openDetail(created);
        detailTab.value = 'files';
      }
      return;
    }
    dialogVisible.value = false;
    resetForm();
    await loadContracts();
  } catch (error) {
    // 乐观锁冲突：重新拉取最新数据让用户确认后再提交
    const handled = await handleConflict(error, async () => {
      await loadContracts();
      if (editingId.value) {
        const fresh = await request<Contract>(`/api/contracts/${editingId.value}`);
        editingVersion.value = fresh.version;
      }
    });
    if (handled) return;
    ElMessage.error(error instanceof Error ? error.message : '合同保存失败');
  } finally {
    saving.value = false;
  }
}

/** 待删除的合同（不为空时显示高危确认弹窗） */
const deletingContract = ref<Contract | null>(null);
const deleteSaving = ref(false);

function removeContract(contract: Contract) {
  // 不再用 ElMessageBox：PRD 7.2 要求"勾选我已知晓风险 + 必填原因"，
  // 而 confirm 弹窗放不下勾选框与原因输入，改由 DangerDeleteDialog 承担。
  deletingContract.value = contract;
}

async function confirmDeleteContract(reason: string) {
  const contract = deletingContract.value;
  if (!contract) return;
  deleteSaving.value = true;
  try {
    await request(`/api/contracts/${contract.id}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
    ElMessage.success('合同已删除，可在「管理系统 → 已删除数据」中恢复');
    deletingContract.value = null;
    await loadContracts();
  } catch (error) {
    // 后端会拒绝"有财务数据"的合同删除并说明原因，这里把原话展示出来
    ElMessage.error(error instanceof Error ? error.message : '合同删除失败');
  } finally {
    deleteSaving.value = false;
  }
}

function handlePageChange(nextPage: number) {
  page.value = nextPage;
  void loadContracts();
}

function handlePageSizeChange(nextSize: number) {
  pageSize.value = nextSize;
  page.value = 1;
  void loadContracts();
}

onMounted(async () => { await Promise.all([loadContracts(), loadCustomers(), loadOwners(), loadStatusOptions(), loadTerminateOptions()]); });
</script>

<template>
  <section class="contract-page">
    <div class="page-heading"><div><p class="eyebrow">系统 A · 合同管理</p><h1>合同</h1><p class="subtitle">合同编号由人工填写；项目按合同编号和件数顺序生成，例如 HT-2026-001-1、HT-2026-001-2。</p></div><el-button type="primary" @click="openCreate">新建合同</el-button></div>
    <el-card shadow="never" class="content-card contract-card">
      <div class="filter-row"><el-input v-model="query.keyword" clearable placeholder="搜索合同编号或客户名称" class="keyword-input" @keyup.enter="page = 1; loadContracts()" /><el-select v-model="query.statusCode" clearable placeholder="合同状态" class="status-input" @change="page = 1; loadContracts()"><el-option v-for="item in contractStatuses" :key="item.code" :label="item.label" :value="item.code" /></el-select><el-select v-model="query.customerId" clearable filterable placeholder="所属客户" class="customer-input" @change="page = 1; loadContracts()"><el-option v-for="customer in customers" :key="customer.id" :label="customer.name" :value="customer.id" /></el-select><el-button @click="page = 1; loadContracts()">查询</el-button><el-button text @click="query.keyword = ''; query.statusCode = ''; query.customerId = ''; page = 1; loadContracts()">重置</el-button><el-button v-if="props.canExport" :loading="exporting" @click="exportData({ keyword: query.keyword, statusCode: query.statusCode, customerId: query.customerId })">导出合同列表</el-button></div>
      <el-table v-loading="loading" :data="contracts" stripe empty-text="暂无合同"><el-table-column label="合同编号" min-width="190"><template #default="scope"><el-button link type="primary" @click="openDetail(scope.row)">{{ scope.row.contractNo }}</el-button></template></el-table-column><el-table-column label="客户" min-width="200"><template #default="scope">{{ scope.row.customer.name }}</template></el-table-column><el-table-column label="不含税金额" width="140"><template #default="scope">¥ {{ Number(scope.row.amount).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</template></el-table-column><el-table-column prop="itemCount" label="件数" width="80" /><el-table-column label="合同类型" width="110"><template #default="scope">{{ optionLabel(contractTypeOptions, scope.row.contractType) }}</template></el-table-column><el-table-column label="到期日" width="130"><template #default="scope">{{ scope.row.expiryDate ? new Date(scope.row.expiryDate).toLocaleDateString('zh-CN') : '未设置' }}</template></el-table-column><el-table-column label="状态" width="100"><template #default="scope"><el-tag size="small" :type="scope.row.statusCode === 'COMPLETED' ? 'success' : scope.row.statusCode === 'TERMINATED' ? 'danger' : 'info'">{{ statusLabel(scope.row.statusCode) }}</el-tag></template></el-table-column><el-table-column label="项目/回款" width="120"><template #default="scope">{{ scope.row._count.projects }} / {{ scope.row._count.paymentAllocations }}</template></el-table-column><CustomFieldColumns :token="props.token" module-key="contract" :rows="contracts" /><el-table-column label="操作" fixed="right" width="190"><template #default="scope"><el-button link type="primary" @click="openDetail(scope.row)">查看详情</el-button><el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button><el-button link type="danger" @click="removeContract(scope.row)">删除</el-button></template></el-table-column></el-table>
      <div class="pagination-row"><el-pagination v-model:current-page="page" v-model:page-size="pageSize" background layout="total, sizes, prev, pager, next" :total="total" @current-change="handlePageChange" @size-change="handlePageSizeChange" /></div>
    </el-card>
    <el-dialog v-model="detailVisible" :title="`合同详情 · ${selectedContract?.contractNo ?? ''}`" width="980px">
      <el-skeleton v-if="detailLoading" :rows="6" animated />
      <template v-else-if="selectedContract">
        <div class="detail-toolbar">
          <el-button
            v-if="selectedContract.statusCode !== 'TERMINATED'"
            type="danger"
            plain
            @click="openTerminate"
          >
            终止合同
          </el-button>
          <el-button type="primary" plain @click="openAdjustment">登记金额调整</el-button>
          <el-button v-if="props.canExport" :loading="exporting" @click="exportData({ contractId: selectedContract.id })">导出本合同</el-button>
          <span class="field-hint">终止与金额调整是敏感操作，分别需要「终止合同」「合同金额调整」权限。</span>
        </div>

        <el-alert
          v-if="selectedContract.termination"
          type="error"
          :closable="false"
          show-icon
          class="termination-alert"
          title="本合同已终止"
        >
          <div class="termination-lines">
            <span>终止日期：{{ new Date(selectedContract.termination.terminatedAt).toLocaleDateString('zh-CN') }}</span>
            <span>终止类型：{{ optionLabel(terminateOptions.terminationType, selectedContract.termination.terminationType) }}</span>
            <span>未完成项目：{{ optionLabel(terminateOptions.unfinishedProjectAction, selectedContract.termination.unfinishedProjectAction) }}</span>
            <span>未回款处理：{{ optionLabel(terminateOptions.unpaidAmountAction, selectedContract.termination.unpaidAmountAction) }}</span>
            <span>操作人：{{ selectedContract.termination.operatedBy ?? '—' }}</span>
            <span class="termination-reason">终止原因：{{ selectedContract.termination.terminationReason }}</span>
          </div>
        </el-alert>

        <el-descriptions :column="3" border>
          <el-descriptions-item label="客户">{{ selectedContract.customer.name }}</el-descriptions-item>
          <el-descriptions-item label="不含税金额">¥ {{ Number(selectedContract.amount).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ statusLabel(selectedContract.statusCode) }}</el-descriptions-item>
          <el-descriptions-item label="合同类型">{{ optionLabel(contractTypeOptions, selectedContract.contractType) }}</el-descriptions-item>
          <el-descriptions-item label="产品">{{ selectedContract.product || '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="单价 × 件数">
            {{ selectedContract.unitPrice ? money(String(selectedContract.unitPrice)) : '未设置' }} × {{ selectedContract.itemCount ?? 1 }}
          </el-descriptions-item>
          <el-descriptions-item label="件数">{{ selectedContract.itemCount ?? 1 }}（已生成 {{ selectedContract.projects.length }} 个项目）</el-descriptions-item>
          <el-descriptions-item label="付款方式">{{ optionLabel(paymentTermOptions, selectedContract.paymentTerm) }}</el-descriptions-item>
          <el-descriptions-item label="负责销售">{{ selectedContract.owner?.displayName ?? '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="公司名称">{{ selectedContract.companyName || '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="联系人">{{ selectedContract.contactName || '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="联系电话">{{ selectedContract.contactPhone || '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="联系人邮箱">{{ selectedContract.contactEmail || '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="公司地址">{{ selectedContract.companyAddress || '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="签订日期">{{ selectedContract.signedAt ? new Date(selectedContract.signedAt).toLocaleDateString('zh-CN') : '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="业务起算日">
            {{ new Date(selectedContract.createdAt).toLocaleDateString('zh-CN') }}
            <span class="field-hint">合同录入、项目绑定生成</span>
          </el-descriptions-item>
          <el-descriptions-item label="到期日">{{ selectedContract.expiryDate ? new Date(selectedContract.expiryDate).toLocaleDateString('zh-CN') : '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="法定截止日">{{ selectedContract.legallyDueAt ? new Date(selectedContract.legallyDueAt).toLocaleDateString('zh-CN') : '未设置' }}</el-descriptions-item>
          <el-descriptions-item label="内部安全日">{{ selectedContract.internalSafetyDate ? new Date(selectedContract.internalSafetyDate).toLocaleDateString('zh-CN') : '按安全天数推算' }}</el-descriptions-item>
          <el-descriptions-item label="备注">{{ selectedContract.remark || '无' }}</el-descriptions-item>
        </el-descriptions>
        <el-row :gutter="16" class="summary-row contract-summary">
          <el-col :span="6"><el-card shadow="never" class="summary-card"><span class="summary-label">合同金额</span><strong>{{ money(selectedContract.totals.contractAmount) }}</strong><small>不含税金额</small></el-card></el-col>
          <el-col :span="6"><el-card shadow="never" class="summary-card"><span class="summary-label">已收款</span><strong>{{ money(selectedContract.totals.collectedAmount) }}</strong><small>其下项目回款汇总</small></el-card></el-col>
          <el-col :span="6">
            <el-card shadow="never" class="summary-card">
              <span class="summary-label">金额调整</span>
              <strong>-{{ money(selectedContract.totals.adjustedAmount) }}</strong>
              <small>退款 / 折扣 / 部分豁免累计（应收净额 {{ money(selectedContract.totals.netReceivable) }}）</small>
            </el-card>
          </el-col>
          <el-col :span="6"><el-card shadow="never" class="summary-card"><span class="summary-label">未收款</span><strong>{{ money(selectedContract.totals.unpaidAmount) }}</strong><small>合同金额 - 已收款 - 金额调整</small></el-card></el-col>
        </el-row>
        <el-row :gutter="16" class="summary-row contract-summary">
          <el-col :span="6"><el-card shadow="never" class="summary-card"><span class="summary-label">成本</span><strong>{{ money(selectedContract.totals.costAmount) }}</strong><small>其下项目成本汇总</small></el-card></el-col>
          <el-col :span="6"><el-card shadow="never" class="summary-card"><span class="summary-label">净收益</span><strong :class="{ 'profit-negative': Number(selectedContract.totals.netProfit) < 0 }">{{ money(selectedContract.totals.netProfit) }}</strong><small>已收款 - 成本</small></el-card></el-col>
        </el-row>

        <el-tabs class="contract-detail-tabs" v-model="detailTab" @tab-change="handleDetailTab">
          <el-tab-pane v-if="props.canViewFiles" label="合同附件" name="files">
            <FileAttachmentPanel :token="props.token" resource-type="Contract" :resource-id="selectedContract.id" title="合同附件" :can-download="props.canDownloadFiles" :can-upload="props.canUploadFiles" :can-delete="props.canDeleteFiles" />
          </el-tab-pane>
          <el-tab-pane label="项目" name="projects">
            <div class="tab-toolbar"><span class="tab-hint">回款与成本在项目详情中登记，点击项目编号进入。</span></div>
            <el-table :data="selectedContract.projects" stripe empty-text="暂无项目">
              <el-table-column label="项目编号" min-width="170"><template #default="scope"><el-button link type="primary" @click="switchToProjects(scope.row.projectNo)">{{ scope.row.projectNo }}</el-button></template></el-table-column>
              <el-table-column prop="projectName" label="项目名称" min-width="200" />
              <el-table-column prop="sequence" label="序号" width="70" />
              <el-table-column label="状态" width="110"><template #default="scope"><span>{{ projectStatusLabel(scope.row.statusCode) }}</span></template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="回款记录" name="payments">
            <div class="tab-toolbar"><span class="tab-hint">回款在合同和项目详情中查看；一笔回款可以分配给多个合同，登记入口仍在项目详情。</span></div>
            <el-table :data="selectedContract.receipts" stripe empty-text="暂无回款">
              <el-table-column label="回款单号" prop="receiptNo" min-width="130" />
              <el-table-column label="本合同分配金额" width="145"><template #default="scope">{{ money(receiptAmountForContract(scope.row)) }}</template></el-table-column>
              <el-table-column label="分摊到项目" min-width="240">
                <template #default="scope">
                  <span v-for="(item, index) in scope.row.allocations" :key="item.project.id">
                    {{ index > 0 ? '；' : '' }}{{ item.project.projectNo }} {{ money(item.amount) }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="回款日期" width="115"><template #default="scope">{{ new Date(scope.row.receivedAt).toLocaleDateString('zh-CN') }}</template></el-table-column>
              <el-table-column label="方式" width="105"><template #default="scope">{{ scope.row.paymentMethod || '未设置' }}</template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="费用信息" name="costs">
            <div class="tab-toolbar"><span class="tab-hint">合同成本由其下项目的成本自动汇总，新增或修改请到对应项目详情。</span></div>
            <el-table :data="selectedContract.costs" stripe empty-text="暂无费用">
              <el-table-column prop="costType" label="费用类型" min-width="130" />
              <el-table-column label="金额" width="130"><template #default="scope">{{ money(scope.row.amount) }}</template></el-table-column>
              <el-table-column label="所属项目" min-width="170">
                <template #default="scope"><el-button link type="primary" @click="switchToProjects(scope.row.project.projectNo)">{{ scope.row.project.projectNo }}</el-button></template>
              </el-table-column>
              <el-table-column label="发生日期" width="115"><template #default="scope">{{ new Date(scope.row.incurredAt).toLocaleDateString('zh-CN') }}</template></el-table-column>
              <el-table-column prop="note" label="备注" min-width="130" />
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="金额调整" name="adjustments">
            <div class="tab-toolbar">
              <span class="tab-hint">退款 / 折扣 / 部分豁免单独记账，不改合同原金额。未收款 = 合同金额 - 已收款 - 累计调整额。</span>
              <el-button size="small" type="primary" @click="openAdjustment">登记调整</el-button>
            </div>
            <el-table :data="selectedContract.adjustments" stripe empty-text="暂无金额调整">
              <el-table-column label="类型" width="110">
                <template #default="scope">{{ optionLabel(adjustTypeOptions, scope.row.adjustType) }}</template>
              </el-table-column>
              <el-table-column label="调整金额" width="130">
                <template #default="scope"><span class="adjust-amount">-{{ money(String(scope.row.amount)) }}</span></template>
              </el-table-column>
              <el-table-column prop="reason" label="原因" min-width="200" />
              <el-table-column label="发生日期" width="120">
                <template #default="scope">{{ new Date(scope.row.occurredAt).toLocaleDateString('zh-CN') }}</template>
              </el-table-column>
              <el-table-column label="经办人" width="120">
                <template #default="scope">{{ scope.row.operator?.displayName ?? '—' }}</template>
              </el-table-column>
              <el-table-column label="操作" width="90" fixed="right">
                <template #default="scope">
                  <el-button link type="danger" @click="removeAdjustment(scope.row.id)">撤销</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="状态变化" name="history">
            <div class="tab-toolbar"><span class="tab-hint">记录合同状态的每次变化：原状态、新状态、原因、操作人与时间，只增不改。</span></div>
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
            <el-empty v-else :description="historyLoading ? '加载中…' : '暂无状态变化记录'" />
          </el-tab-pane>
        </el-tabs>
      </template>
    </el-dialog>
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑合同' : '新建合同'" width="720px" @closed="resetForm">
      <el-form label-position="top" class="contract-form">
        <el-alert
          v-if="!editingId"
          type="info"
          :closable="false"
          show-icon
          title="需要上传合同附件时，请点击“保存并上传附件”；合同创建后会自动打开“合同附件”标签。"
          class="contract-attachment-hint"
        />
        <el-form-item :label="editingId ? '合同编号（创建后不可修改）' : '合同编号'" required>
          <el-input v-model="form.contractNo" :disabled="Boolean(editingId)" maxlength="50" show-word-limit placeholder="请按实际合同填写，例如 HT-2026-001" />
          <span class="field-hint">
            项目编号会按此编号依次生成：{{ form.contractNo.trim() || '合同编号' }}-1、{{ form.contractNo.trim() || '合同编号' }}-2……
            编号不能包含空格；重号会被拒绝。
          </span>
        </el-form-item>
        <el-form-item v-if="!editingId" label="所属客户" required>
          <el-select v-model="form.customerId" filterable placeholder="请选择客户" style="width: 100%">
            <el-option v-for="customer in customers" :key="customer.id" :label="customer.name" :value="customer.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="props.canAssignOwner" label="所属销售" required>
          <el-select v-model="form.ownerId" filterable clearable placeholder="请选择负责销售（留空默认为当前账号）" style="width: 100%">
            <el-option v-for="owner in owners" :key="owner.id" :label="`${owner.displayName}（${owner.username}）`" :value="owner.id" />
          </el-select>
          <span class="field-hint">合同和自动生成的项目都会按此负责人进入对应销售账号的数据范围。</span>
        </el-form-item>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="合同类型">
              <TypeSelector v-model="form.contractType" :token="props.token" module-key="contractType" placeholder="请选择合同类型" @update:model-value="onTypeOrExpiryChange" />
              <span class="field-hint">选项在「管理系统 → 选项配置」中维护；项目会按此类型匹配流程模板。</span>
            </el-form-item>
          </el-col>
          <el-col :span="12"><el-form-item label="产品" required><el-input v-model="form.product" placeholder="例如：发明专利代理服务" /></el-form-item></el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="8">
            <el-form-item label="单价">
              <el-input v-model="form.unitPrice" type="number" min="0" placeholder="可选" />
              <span class="field-hint">填写后与「单价 × 件数」互相校验。</span>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="不含税金额" required>
              <el-input v-model="form.amount" type="number" min="0" placeholder="0.00" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="付款方式">
              <el-select v-model="form.paymentTerm" clearable placeholder="请选择" style="width: 100%">
                <el-option v-for="item in paymentTermOptions" :key="item.code" :label="item.label" :value="item.code" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert
          v-if="localAmountWarning"
          type="warning"
          :closable="false"
          show-icon
          class="amount-warning"
          :title="localAmountWarning + ' 可以继续保存，请确认无误。'"
        />
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="签订日期"><el-date-picker v-model="form.signedAt" type="date" value-format="YYYY-MM-DD" placeholder="选择签订日期" style="width: 100%" @change="onTypeOrExpiryChange" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="合同到期日"><el-date-picker v-model="form.expiryDate" type="date" value-format="YYYY-MM-DD" placeholder="可选" style="width: 100%" /></el-form-item></el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="法定截止日">
              <el-date-picker v-model="form.legallyDueAt" type="date" value-format="YYYY-MM-DD" placeholder="官方/客户要求的最后期限" style="width: 100%" />
              <span class="field-hint">提醒中心据此倒推内部安全日，并提前提醒。</span>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="内部安全日">
              <el-date-picker v-model="form.internalSafetyDate" type="date" value-format="YYYY-MM-DD" placeholder="留空则按安全天数自动推算" style="width: 100%" />
              <span class="field-hint">留空时按「法定截止日 - 安全天数配置」推算。</span>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="业务起算日" required>
          <el-date-picker v-model="form.businessStartAt" type="date" value-format="YYYY-MM-DD" placeholder="请选择业务实际开始日期" style="width: 100%" @change="onTypeOrExpiryChange" />
          <span class="field-hint">由业务人员填写，系统建议法定截止日和内部安全日从此日期计算；历史合同未填写时兼容使用原录入日期。</span>
        </el-form-item>
        <el-form-item label="系统建议截止日（系统算建议值，人工复核确认）">
          <div class="suggestion-block">
            <div class="suggestion-actions">
              <el-button size="small" type="primary" plain :loading="suggesting" @click="applySuggestion">按系统建议值填充</el-button>
              <el-button size="small" text @click="clearSuggestionDates">清空两个日期</el-button>
              <span class="field-hint">只填入日期框，填完仍可自行修改，以你确认为准。</span>
            </div>
            <el-alert
              v-if="suggestion"
              :type="suggestion.cappedByExpiryDate ? 'warning' : 'info'"
              :closable="false"
              show-icon
              class="suggestion-alert"
              :title="suggestion.explanation"
            />
            <span v-else class="field-hint">选择合同类型后会显示建议值说明；时限天数在「管理系统 → 选项配置」中按业务类型维护。</span>
          </div>
        </el-form-item>
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="件数" required><el-input-number v-model="form.itemCount" :min="1" :max="500" :step="1" step-strictly style="width: 100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="合同状态"><el-select v-model="form.statusCode" style="width: 100%"><el-option v-for="item in contractStatuses" :key="item.code" :label="item.label" :value="item.code" /></el-select></el-form-item></el-col>
        </el-row>
        <el-divider content-position="left">联系人信息（合同侧快照）</el-divider>
        <p class="field-hint snapshot-hint">
          留空时取客户当前的联系人信息。合同保存的是签约当时的快照，客户信息日后变更不会改写历史合同。
        </p>
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="公司名称"><el-input v-model="form.companyName" placeholder="留空取客户名称" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="联系人"><el-input v-model="form.contactName" placeholder="留空取客户联系人" /></el-form-item></el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="8"><el-form-item label="联系电话"><el-input v-model="form.contactPhone" placeholder="留空取客户电话" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="联系人邮箱"><el-input v-model="form.contactEmail" placeholder="留空取客户邮箱" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="公司地址"><el-input v-model="form.companyAddress" placeholder="留空取客户地址" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="可选" /></el-form-item>
        <el-form-item v-if="!editingId">
          <div class="auto-generate-row">
            <el-switch v-model="form.autoGenerateProjects" />
            <div class="auto-generate-text">
              <strong>按件数自动生成项目</strong>
              <span>开启后，保存合同时会生成 {{ form.itemCount }} 个项目，编号按“合同编号-序号”排列。</span>
            </div>
          </div>
        </el-form-item>
        <el-form-item v-else>
          <div class="auto-generate-text">
            <strong>件数调整</strong>
            <span>当前已有 {{ editingContractProjectCount }} 个项目。调大件数会自动补建差额项目；调小不能小于已有项目数。</span>
          </div>
        </el-form-item>
        <CustomFieldForm :token="props.token" module-key="contract" v-model="customFieldValues" />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" plain :loading="saving" @click="saveContract(false)">保存</el-button>
        <el-button v-if="!editingId && props.canUploadFiles" type="primary" :loading="saving" @click="saveContract(true)">保存并上传附件</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="terminateVisible" title="终止合同" width="620px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        class="terminate-alert"
        title="终止不可逆。请一次填完下面 5 项信息，终止后会写入状态变化历史与操作日志。"
      />
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="终止日期" required>
              <el-date-picker v-model="terminateForm.terminatedAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="终止类型" required>
              <el-select v-model="terminateForm.terminationType" style="width: 100%">
                <el-option v-for="item in terminateOptions.terminationType" :key="item.code" :label="item.label" :value="item.code" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="终止原因" required>
          <el-input v-model="terminateForm.terminationReason" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="例如：客户业务调整，不再继续申报" />
        </el-form-item>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="未完成项目处理" required>
              <el-select v-model="terminateForm.unfinishedProjectAction" style="width: 100%">
                <el-option v-for="item in terminateOptions.unfinishedProjectAction" :key="item.code" :label="item.label" :value="item.code" />
              </el-select>
              <span class="field-hint">选「项目一并终止」时，其下未完成项目会置为已终止；已完成项目保持完成。</span>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="未回款处理" required>
              <el-select v-model="terminateForm.unpaidAmountAction" style="width: 100%">
                <el-option v-for="item in terminateOptions.unpaidAmountAction" :key="item.code" :label="item.label" :value="item.code" />
              </el-select>
              <span class="field-hint">选「部分豁免」时，请另外到「金额调整」登记具体金额。</span>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="terminateVisible = false">取消</el-button>
        <el-button type="danger" :loading="terminateSaving" @click="submitTerminate">确认终止</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="adjustmentVisible" title="登记合同金额调整" width="560px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="terminate-alert"
        title="单独记账，不改合同原金额。未收款 = 合同金额 - 已收款 - 累计调整额。"
      />
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="调整类型" required>
              <el-select v-model="adjustmentForm.adjustType" style="width: 100%">
                <el-option v-for="item in adjustTypeOptions" :key="item.code" :label="item.label" :value="item.code" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="调整金额（减少应收）" required>
              <el-input v-model="adjustmentForm.amount" type="number" min="0" placeholder="0.00" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="发生日期" required>
          <el-date-picker v-model="adjustmentForm.occurredAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="原因">
          <el-input v-model="adjustmentForm.reason" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="例如：客户取消部分服务" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustmentVisible = false">取消</el-button>
        <el-button type="primary" :loading="adjustmentSaving" @click="submitAdjustment">保存</el-button>
      </template>
    </el-dialog>

    <!-- PRD 7.2 高危删除确认：勾选「我已知晓风险」+ 必填删除原因 -->
    <DangerDeleteDialog
      :model-value="deletingContract !== null"
      title="删除合同"
      :target="deletingContract ? `合同 ${deletingContract.contractNo}` : ''"
      :consequences="'其下未完成的项目、官文、动作记录与申报结果会一并作废；已产生的回款与成本会保留以便对账。'"
      :loading="deleteSaving"
      @update:model-value="(value: boolean) => { if (!value) deletingContract = null; }"
      @confirm="confirmDeleteContract"
    />
  </section>
</template>

<style scoped>
.contract-card {
  min-height: 420px;
}

.contract-detail-tabs {
  margin-top: 20px;
}

.auto-generate-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.auto-generate-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.auto-generate-text strong {
  color: #1f3355;
  font-size: 14px;
}

.auto-generate-text span {
  color: #8b99ad;
  font-size: 12px;
  line-height: 1.6;
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
.detail-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.termination-alert {
  margin-bottom: 14px;
}

.termination-lines {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  font-size: 13px;
  line-height: 1.8;
}

.termination-reason {
  width: 100%;
}

.adjust-amount {
  color: #b91c1c;
}

.amount-warning {
  margin-bottom: 14px;
}

.snapshot-hint {
  display: block;
  margin: -6px 0 12px;
  line-height: 1.7;
}

.terminate-alert {
  margin-bottom: 14px;
}
.suggestion-block {
  width: 100%;
}

.suggestion-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.suggestion-alert {
  margin-top: 8px;
}

.suggestion-alert :deep(.el-alert__title) {
  line-height: 1.7;
  font-size: 12px;
}
.business-start {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.business-start .field-hint {
  flex: 1 1 320px;
  line-height: 1.7;
}
</style>










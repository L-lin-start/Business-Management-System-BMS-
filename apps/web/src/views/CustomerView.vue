<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import CustomFieldColumns from '../components/CustomFieldColumns.vue';
import CustomFieldForm from '../components/CustomFieldForm.vue';
import DangerDeleteDialog from '../components/DangerDeleteDialog.vue';

type Owner = { id: string; username: string; displayName: string };
type Customer = {
  id: string;
  name: string;
  customerType: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  ownerId: string | null;
  customFields?: Record<string, unknown> | null;
  owner: Owner | null;
  _count: { contracts: number };
  updatedAt: string;
};

const props = defineProps<{ token: string }>();
const loading = ref(false);
const saving = ref(false);
const customers = ref<Customer[]>([]);
const owners = ref<Owner[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const query = reactive({ keyword: '', customerType: '', ownerId: '' });
const form = reactive({ name: '', customerType: '', contactName: '', phone: '', email: '', address: '', ownerId: '' });
/** 自定义字段的取值，按系统 B 的字段定义动态渲染 */
const customFieldValues = ref<Record<string, unknown>>({});

/**
 * 字段锁定规则，由服务端下发（见 GET /api/customers/form-policy）。
 * 销售等角色新建客户时「所属销售」锁死为自己、不给选；总经理/系统管理员保持可选。
 * 前端不按角色名硬编码判断，规则只在服务端定义一处。
 */
type OwnerPolicy = { locked: boolean; lockedValue: string | null; lockedLabel: string | null; reason: string };
const ownerPolicy = ref<OwnerPolicy>({ locked: false, lockedValue: null, lockedLabel: null, reason: '' });

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}`, ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? '请求失败');
  return payload as T;
}

async function loadCustomers() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize.value) });
    if (query.keyword.trim()) params.set('keyword', query.keyword.trim());
    if (query.customerType) params.set('customerType', query.customerType);
    if (query.ownerId) params.set('ownerId', query.ownerId);
    const result = await request<{ items: Customer[]; total: number }>(`/api/customers?${params.toString()}`);
    customers.value = result.items;
    total.value = result.total;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '客户数据加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadOwners() {
  try {
    owners.value = await request<Owner[]>('/api/customers/owners');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '负责人列表加载失败');
  }
}

/** 读取字段锁定规则；失败时退回"可自由选择"，但服务端仍会强制校验 */
async function loadFormPolicy() {
  try {
    const policy = await request<{ ownerId: OwnerPolicy }>('/api/customers/form-policy');
    ownerPolicy.value = policy.ownerId;
  } catch {
    ownerPolicy.value = { locked: false, lockedValue: null, lockedLabel: null, reason: '' };
  }
}

function resetForm() {
  Object.assign(form, { name: '', customerType: '', contactName: '', phone: '', email: '', address: '', ownerId: '' });
  customFieldValues.value = {};
  editingId.value = null;
}

function openCreate() {
  resetForm();
  // 锁定时预填为"自己"，让用户看到这条记录会归属给谁
  if (ownerPolicy.value.locked && ownerPolicy.value.lockedValue) {
    form.ownerId = ownerPolicy.value.lockedValue;
  }
  dialogVisible.value = true;
}

function openEdit(customer: Customer) {
  editingId.value = customer.id;
  Object.assign(form, {
    name: customer.name,
    customerType: customer.customerType ?? '',
    contactName: customer.contactName ?? '',
    phone: customer.phone ?? '',
    email: customer.email ?? '',
    address: customer.address ?? '',
    ownerId: customer.ownerId ?? '',
  });
  customFieldValues.value = { ...(customer.customFields ?? {}) };
  dialogVisible.value = true;
}

async function saveCustomer() {
  if (!form.name.trim()) {
    ElMessage.warning('请输入客户名称');
    return;
  }
  saving.value = true;
  try {
    // 锁定时不提交 ownerId：值由服务端权威决定，避免前端缓存了旧规则时把别人的 id 传上去
    const ownerId = ownerPolicy.value.locked ? undefined : (form.ownerId || undefined);
    const body = { ...form, name: form.name.trim(), customerType: form.customerType || undefined, contactName: form.contactName || undefined, phone: form.phone || undefined, address: form.address || undefined, ownerId, customFields: customFieldValues.value };
    if (editingId.value) {
      await request(`/api/customers/${editingId.value}`, { method: 'PATCH', body: JSON.stringify(body) });
      ElMessage.success('客户已更新');
    } else {
      await request('/api/customers', { method: 'POST', body: JSON.stringify(body) });
      ElMessage.success('客户已创建');
    }
    dialogVisible.value = false;
    resetForm();
    await loadCustomers();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '客户保存失败');
  } finally {
    saving.value = false;
  }
}

/** 待删除的客户（不为空时显示 PRD 7.2 的高危确认弹窗） */
const deletingCustomer = ref<Customer | null>(null);
const deleteSaving = ref(false);

function removeCustomer(customer: Customer) {
  deletingCustomer.value = customer;
}

async function confirmDeleteCustomer(reason: string) {
  const customer = deletingCustomer.value;
  if (!customer) return;
  deleteSaving.value = true;
  try {
    await request(`/api/customers/${customer.id}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
    ElMessage.success('客户已删除，可在「管理系统 → 已删除数据」中恢复');
    deletingCustomer.value = null;
    await loadCustomers();
  } catch (error) {
    // 后端会拒绝"名下还有合同"的客户删除并说明原因，这里把原话展示出来
    ElMessage.error(error instanceof Error ? error.message : '客户删除失败');
  } finally {
    deleteSaving.value = false;
  }
}

function handlePageChange(nextPage: number) {
  page.value = nextPage;
  void loadCustomers();
}

function handlePageSizeChange(nextSize: number) {
  pageSize.value = nextSize;
  page.value = 1;
  void loadCustomers();
}

onMounted(async () => {
  await Promise.all([loadCustomers(), loadOwners(), loadFormPolicy()]);
});
</script>

<template>
  <section class="customer-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">系统 A · 客户管理</p>
        <h1>客户</h1>
        <p class="subtitle">统一维护客户基础信息，客户删除采用软删除并保留操作历史。</p>
      </div>
      <el-button type="primary" @click="openCreate">新建客户</el-button>
    </div>

    <el-card shadow="never" class="content-card customer-card">
      <div class="filter-row">
        <el-input v-model="query.keyword" clearable placeholder="搜索客户名称、联系人或电话" class="keyword-input" @keyup.enter="page = 1; loadCustomers()" />
        <el-input v-model="query.customerType" clearable placeholder="客户类型" class="type-input" @keyup.enter="page = 1; loadCustomers()" />
        <el-select v-model="query.ownerId" clearable placeholder="所属销售" class="owner-input" @change="page = 1; loadCustomers()"><el-option v-for="owner in owners" :key="owner.id" :label="owner.displayName" :value="owner.id" /></el-select>
        <el-button @click="page = 1; loadCustomers()">查询</el-button>
        <el-button text @click="query.keyword = ''; query.customerType = ''; query.ownerId = ''; page = 1; loadCustomers()">重置</el-button>
      </div>

      <el-table v-loading="loading" :data="customers" stripe empty-text="暂无客户">
        <el-table-column prop="name" label="客户名称" min-width="210" />
        <el-table-column prop="customerType" label="客户类型" width="130" />
        <el-table-column prop="contactName" label="联系人" width="130" />
        <el-table-column prop="phone" label="联系电话" width="150" />
        <el-table-column label="所属销售" width="140"><template #default="scope">{{ scope.row.owner?.displayName ?? '未分配' }}</template></el-table-column>
        <el-table-column label="合同数" width="100"><template #default="scope">{{ scope.row._count.contracts }}</template></el-table-column>
        <el-table-column label="更新时间" width="180"><template #default="scope">{{ new Date(scope.row.updatedAt).toLocaleDateString('zh-CN') }}</template></el-table-column>
        <CustomFieldColumns :token="props.token" module-key="customer" :rows="customers" />
        <el-table-column label="操作" fixed="right" width="160"><template #default="scope"><el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button><el-button link type="danger" @click="removeCustomer(scope.row)">删除</el-button></template></el-table-column>
      </el-table>
      <div class="pagination-row"><el-pagination v-model:current-page="page" v-model:page-size="pageSize" background layout="total, sizes, prev, pager, next" :total="total" @current-change="handlePageChange" @size-change="handlePageSizeChange" /></div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑客户' : '新建客户'" width="560px" @closed="resetForm">
      <el-form label-position="top"><el-form-item label="客户名称" required><el-input v-model="form.name" placeholder="请输入客户名称" /></el-form-item><el-row :gutter="14"><el-col :span="12"><el-form-item label="客户类型"><el-input v-model="form.customerType" placeholder="例如：企业客户" /></el-form-item></el-col><el-col :span="12"><el-form-item label="联系人"><el-input v-model="form.contactName" /></el-form-item></el-col></el-row><el-row :gutter="14"><el-col :span="12"><el-form-item label="联系电话"><el-input v-model="form.phone" /></el-form-item></el-col><el-col :span="12"><el-form-item label="联系人邮箱"><el-input v-model="form.email" placeholder="官文邮件主收件人来源" /></el-form-item></el-col></el-row><el-row :gutter="14"><el-col :span="12"><el-form-item label="所属销售"><template v-if="ownerPolicy.locked"><el-input :model-value="ownerPolicy.lockedLabel ?? '当前登录人'" disabled /><span class="field-hint">{{ ownerPolicy.reason }}</span></template><el-select v-else v-model="form.ownerId" clearable placeholder="可选" style="width: 100%"><el-option v-for="owner in owners" :key="owner.id" :label="owner.displayName" :value="owner.id" /></el-select></el-form-item></el-col></el-row><el-form-item label="地址"><el-input v-model="form.address" type="textarea" :rows="3" /></el-form-item><CustomFieldForm :token="props.token" module-key="customer" v-model="customFieldValues" /></el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveCustomer">保存</el-button></template>
    </el-dialog>

    <!-- PRD 7.2 高危删除确认：勾选「我已知晓风险」+ 必填删除原因 -->
    <DangerDeleteDialog
      :model-value="deletingCustomer !== null"
      title="删除客户"
      :target="deletingCustomer ? `客户 ${deletingCustomer.name}` : ''"
      consequences="名下若还有未删除的合同会被后端拒绝，需先处理这些合同。"
      :loading="deleteSaving"
      @update:model-value="(value: boolean) => { if (!value) deletingCustomer = null; }"
      @confirm="confirmDeleteCustomer"
    />
  </section>
</template>

<style scoped>
.customer-card {
  min-height: 420px;
}

.type-input {
  width: 160px;
}

.owner-input {
  width: 170px;
}

.field-hint {
  display: block;
  margin-top: 4px;
  color: #909399;
  font-size: 12px;
  line-height: 1.6;
}
</style>






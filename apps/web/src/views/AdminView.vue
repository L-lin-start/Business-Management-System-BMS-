<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import DangerDeleteDialog from '../components/DangerDeleteDialog.vue';
import OptionsAdmin from '../components/OptionsAdmin.vue';
import ReminderConfig from '../components/ReminderConfig.vue';
import ExportConfig from '../components/ExportConfig.vue';
import DeletedRecordsAdmin from '../components/DeletedRecordsAdmin.vue';
import WorkflowAdmin from '../components/WorkflowAdmin.vue';
import FeedbackRoutingConfig from '../components/FeedbackRoutingConfig.vue';

type Department = {
  id: string;
  name: string;
  code: string;
  parentId: string | null;
  managerId: string | null;
  isActive: boolean;
  manager: { id: string; displayName: string } | null;
  _count: { members: number; children: number };
  children: Department[];
};

type User = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  isSystemAdmin: boolean;
  roles: Array<{ id: string; code: string; name: string }>;
  departments: Array<{ id: string; code: string; name: string }>;
};

type Role = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  _count: { users: number; permissions: number };
  permissions: Array<{ permissionId: string; allowed: boolean; dataScope: string }>;
};

type Permission = {
  id: string;
  code: string;
  name: string;
  kind: string;
  resource: string;
  action: string;
  description: string | null;
};

type AuditLog = {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  reason: string | null;
  createdAt: string;
  actor: { username: string; displayName: string } | null;
  actionLabel: string;
  resourceTypeLabel: string;
  resourceDisplayId: string;
};

type FieldDefinition = {
  id: string;
  moduleKey: string;
  fieldKey: string;
  label: string;
  fieldType: string;
  isRequired: boolean;
  isSystem: boolean;
  isListVisible: boolean;
  isSearchable: boolean;
  sortOrder: number;
  config: Record<string, unknown> | null;
  isActive: boolean;
};

const props = defineProps<{ token: string }>();

const activeTab = ref('overview');
const loading = ref(false);
const departments = ref<Department[]>([]);
const users = ref<User[]>([]);
const roles = ref<Role[]>([]);
const permissions = ref<Permission[]>([]);
const auditLogs = ref<AuditLog[]>([]);
const fieldDefinitions = ref<FieldDefinition[]>([]);

const departmentDialog = ref(false);
/** 正在编辑的部门 id；为空表示"新建" */
const editingDepartmentId = ref<string | null>(null);
/** 部门保存中（新建/编辑共用），用于按钮 loading */
const departmentSaving = ref(false);
const userDialog = ref(false);
const roleDialog = ref(false);
const permissionDialog = ref(false);
const fieldDialog = ref(false);
const editingFieldId = ref<string | null>(null);
const departmentForm = reactive({ name: '', parentId: '', managerId: '' });
const userForm = reactive({ username: '', password: '', displayName: '', email: '', phone: '', departmentIds: [] as string[], roleIds: [] as string[] });
const roleForm = reactive({ name: '', description: '' });
const selectedRole = ref<Role | null>(null);
const selectedPermissionIds = ref<string[]>([]);
const selectedDataScope = ref('DEPARTMENT');
const permissionSaving = ref(false);
const fieldForm = reactive({ moduleKey: 'contract', label: '', fieldType: 'TEXT', isRequired: false, isListVisible: true, isSearchable: false, sortOrder: 0 });

/**
 * 修改密码：管理系统 → 用户账号 → 操作列「修改密码」。
 * 新建用户时能设密码，但已有用户没有改密码的入口（忘记密码只能重建账号），这里补上。
 */
const passwordDialog = ref(false);
const passwordTarget = ref<User | null>(null);
const passwordSaving = ref(false);
const passwordForm = reactive({ password: '', confirm: '' });
const fieldModuleFilter = ref('contract');
/** 下拉/多选字段的可选项，一行一个 */
const fieldOptionsText = ref('');

function parseFieldOptions(text: string): string[] {
  return text
    .split('\n')
    .map((item) => item.trim())
    .filter((item, index, list) => item.length > 0 && list.indexOf(item) === index);
}

const fieldTypeOptions = [
  { label: '文本', value: 'TEXT' },
  { label: '数字', value: 'NUMBER' },
  { label: '日期', value: 'DATE' },
  { label: '下拉', value: 'SELECT' },
  { label: '多选', value: 'MULTI_SELECT' },
  { label: '布尔', value: 'BOOLEAN' },
  { label: '附件', value: 'ATTACHMENT' },
  { label: '关联', value: 'RELATION' },
  { label: '人员', value: 'USER' },
];
const fieldModuleOptions = [
  { label: '客户', value: 'customer' },
  { label: '合同', value: 'contract' },
  { label: '项目', value: 'project' },
  { label: '回款（合同附属）', value: 'payment' },
  { label: '费用（合同/项目附属）', value: 'cost' },
  { label: '官文', value: 'official_document' },
  { label: '邮件送达', value: 'mail_delivery' },
  { label: '时限', value: 'deadline' },
  { label: '动作记录', value: 'action_record' },
  { label: '申报结果', value: 'filing_result' },
  { label: '异常场景', value: 'exception' },
];

const flatDepartments = computed(() => {
  const result: Array<Department & { level: number }> = [];
  const walk = (items: Department[], level: number) => {
    for (const item of items) {
      result.push({ ...item, level });
      walk(item.children ?? [], level + 1);
    }
  };
  walk(departments.value, 0);
  return result;
});

const departmentOptions = computed(() => flatDepartments.value.map((item) => ({ id: item.id, name: `${'　'.repeat(item.level)}${item.name}` })));
const activeUsers = computed(() => users.value.filter((user) => user.status === 'ACTIVE'));
const permissionByResource = computed(() => {
  const resourceLabels: Record<string, string> = {
    customer: '客户', contract: '合同', project: '项目', payment: '回款', cost: '成本',
    reminder: '提醒', feedback: '反馈', system: '系统', workflow: '流程', option: '选项', field: '字段',
  };
  const groups = new Map<string, Permission[]>();
  for (const permission of permissions.value) {
    const list = groups.get(permission.resource) ?? [];
    list.push(permission);
    groups.set(permission.resource, list);
  }
  return [...groups.entries()].map(([resource, items]) => [resourceLabels[resource] ?? '其他', items] as [string, Permission[]]);
});

function joinNames(items: Array<{ name: string }>) {
  return items.map((item) => item.name).join('、') || '未分配';
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}`, ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? '请求失败');
  return payload as T;
}

async function loadData() {
  loading.value = true;
  try {
    const [departmentData, userData, roleData, permissionData, auditData, fieldData] = await Promise.all([
      request<Department[]>('/api/admin/departments/tree'),
      request<User[]>('/api/admin/users'),
      request<Role[]>('/api/admin/roles'),
      request<Permission[]>('/api/admin/permissions'),
      request<AuditLog[]>('/api/admin/audit-logs'),
      request<FieldDefinition[]>('/api/admin/field-definitions'),
    ]);
    departments.value = departmentData;
    users.value = userData;
    roles.value = roleData;
    permissions.value = permissionData;
    auditLogs.value = auditData;
    fieldDefinitions.value = fieldData;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '管理数据加载失败');
  } finally {
    loading.value = false;
  }
}

const visibleFieldDefinitions = computed(() => fieldDefinitions.value.filter((field) => field.moduleKey === fieldModuleFilter.value));

/**
 * 新增字段时的默认排序号：该模块现有最大值 + 1（排在最后）。
 *
 * 之前固定写 0，会让新字段直接跳到列表最前面，管理员每次都要手工改。
 * 排序号现在是 1、2、3…的连续值，所以直接 +1。
 */
function nextFieldSortOrder(moduleKey: string) {
  const orders = fieldDefinitions.value.filter((field) => field.moduleKey === moduleKey).map((field) => field.sortOrder);
  return orders.length > 0 ? Math.max(...orders) + 1 : 1;
}

function resetFieldForm() {
  Object.assign(fieldForm, { moduleKey: fieldModuleFilter.value, label: '', fieldType: 'TEXT', isRequired: false, isListVisible: true, isSearchable: false, sortOrder: nextFieldSortOrder(fieldModuleFilter.value) });
  fieldOptionsText.value = '';
  editingFieldId.value = null;
}

/**
 * 新增字段时切换「所属模块」，排序号要跟着换成该模块的下一个值
 * （各模块的排序号是各自独立的，沿用上一个模块的数字会显得莫名其妙）。
 * 编辑已有字段时不动它 —— 那读的是这条记录自己的排序号。
 */
watch(
  () => fieldForm.moduleKey,
  (moduleKey) => {
    if (!editingFieldId.value) fieldForm.sortOrder = nextFieldSortOrder(moduleKey);
  },
);

function openFieldEdit(field: FieldDefinition) {
  editingFieldId.value = field.id;
  Object.assign(fieldForm, { moduleKey: field.moduleKey, label: field.label, fieldType: field.fieldType, isRequired: field.isRequired, isListVisible: field.isListVisible, isSearchable: field.isSearchable, sortOrder: field.sortOrder });
  const options = (field.config as { options?: string[] } | null)?.options;
  fieldOptionsText.value = Array.isArray(options) ? options.join('\n') : '';
  fieldDialog.value = true;
}

async function saveFieldDefinition() {
  if (!fieldForm.label.trim()) {
    ElMessage.warning('请填写字段名称');
    return;
  }
  // 下拉/多选必须给出可选项，否则录入端只能填任意文本
  const isChoiceType = fieldForm.fieldType === 'SELECT' || fieldForm.fieldType === 'MULTI_SELECT';
  const options = parseFieldOptions(fieldOptionsText.value);
  if (isChoiceType && options.length === 0) {
    ElMessage.warning('下拉/多选字段需要填写至少一个可选项（一行一个）');
    return;
  }
  const config = isChoiceType ? { options } : undefined;
  try {
    if (editingFieldId.value) {
      const { moduleKey: _moduleKey, ...updateBody } = fieldForm;
      await request(`/api/admin/field-definitions/${editingFieldId.value}`, { method: 'PATCH', body: JSON.stringify({ ...updateBody, config }) });
      ElMessage.success('字段模板已更新');
    } else {
      await request('/api/admin/field-definitions', { method: 'POST', body: JSON.stringify({ ...fieldForm, config }) });
      ElMessage.success('字段模板已新增');
    }
    fieldDialog.value = false;
    resetFieldForm();
    await loadData();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '字段模板新增失败');
  }
}

async function toggleField(field: FieldDefinition) {
  try {
    if (field.isActive) {
      await request(`/api/admin/field-definitions/${field.id}`, { method: 'DELETE' });
      ElMessage.success('字段已从新业务模板中删除，历史数据不受影响');
    } else {
      await request(`/api/admin/field-definitions/${field.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: true }) });
      ElMessage.success('字段已恢复');
    }
    await loadData();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '字段状态更新失败');
  }
}

function resetDepartmentForm() {
  Object.assign(departmentForm, { name: '', parentId: '', managerId: '' });
  editingDepartmentId.value = null;
}

/** 打开「新建部门」弹窗 */
function openCreateDepartment() {
  resetDepartmentForm();
  departmentDialog.value = true;
}

/** 打开「编辑部门」弹窗，回填当前值 */
function openEditDepartment(department: Department) {
  editingDepartmentId.value = department.id;
  Object.assign(departmentForm, {
    name: department.name,
    parentId: department.parentId ?? '',
    managerId: department.managerId ?? '',
  });
  departmentDialog.value = true;
}

/**
 * 「上级部门」的可选项：编辑时排除自己和自己的所有后代。
 * 否则把部门挂到自己的下级里会形成循环，组织树渲染会无限递归（后端也会拒绝）。
 */
const departmentParentOptions = computed(() => {
  const excluded = new Set<string>();
  if (editingDepartmentId.value) {
    excluded.add(editingDepartmentId.value);
    const collect = (id: string) => {
      for (const item of flatDepartments.value) {
        if (item.parentId === id && !excluded.has(item.id)) {
          excluded.add(item.id);
          collect(item.id);
        }
      }
    };
    collect(editingDepartmentId.value);
  }
  return departmentOptions.value.filter((item) => !excluded.has(item.id));
});

function resetUserForm() {
  Object.assign(userForm, { username: '', password: '', displayName: '', email: '', phone: '', departmentIds: [], roleIds: [] });
}

function resetRoleForm() {
  Object.assign(roleForm, { name: '', description: '' });
}

async function createDepartment() {
  try {
    await request('/api/admin/departments', { method: 'POST', body: JSON.stringify({ ...departmentForm, parentId: departmentForm.parentId || undefined, managerId: departmentForm.managerId || undefined }) });
    ElMessage.success('部门已创建');
    departmentDialog.value = false;
    resetDepartmentForm();
    await loadData();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '部门创建失败');
  }
}

/** 保存部门编辑：改名 / 改上级 / 改负责人 */
async function saveDepartment() {
  const id = editingDepartmentId.value;
  if (!id) return;
  if (!departmentForm.name.trim()) {
    ElMessage.warning('请填写部门名称');
    return;
  }
  departmentSaving.value = true;
  try {
    // parentId 传空串表示"提升为顶层部门"（后端把空串转成 null）
    await request(`/api/admin/departments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: departmentForm.name.trim(),
        parentId: departmentForm.parentId,
        managerId: departmentForm.managerId,
      }),
    });
    ElMessage.success('部门已更新');
    departmentDialog.value = false;
    resetDepartmentForm();
    await loadData();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '部门更新失败');
  } finally {
    departmentSaving.value = false;
  }
}

/**
 * 判断某个部门能否删除，返回不能删的原因（空字符串表示可以删）。
 *
 * 这里把后端的拦截规则在界面上也做一遍，好处是**删除按钮直接置灰并给出原因**，
 * 不用点了才被拒。后端仍然会再校验一次（前端判断只是体验优化）。
 *
 * 注意：**不能因为"没有上级"就禁止删除** —— 组织架构允许多个平级部门（PRD 5.1），
 * 只有同一层级只剩它一个时才拦。所以这里用的是"同级部门数量"，不是"是否根部门"。
 */
function departmentDeleteBlockReason(department: Department): string {
  if (department._count.children > 0) {
    return `该部门下还有 ${department._count.children} 个子部门，请先删除或移走子部门`;
  }
  if (department._count.members > 0) {
    return `该部门下还有 ${department._count.members} 名成员，请先在「用户账号」里把成员改到其它部门`;
  }
  const siblings = flatDepartments.value.filter((item) => item.parentId === department.parentId);
  if (siblings.length <= 1) {
    return department.parentId
      ? '同级只剩这一个部门，请先在同一层级新建一个部门'
      : '这是根层级唯一的部门，请先新建一个平级部门';
  }
  return '';
}

async function removeDepartment(department: Department) {
  const blocked = departmentDeleteBlockReason(department);
  if (blocked) {
    ElMessage.warning(blocked);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确定要删除部门「${department.name}」吗？删除后无法恢复。`,
      '删除部门',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }
  try {
    await request(`/api/admin/departments/${department.id}`, { method: 'DELETE' });
    ElMessage.success(`部门「${department.name}」已删除`);
    await loadData();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '部门删除失败');
  }
}

async function createUser() {
  try {
    await request('/api/admin/users', { method: 'POST', body: JSON.stringify({ ...userForm, email: userForm.email || undefined, phone: userForm.phone || undefined }) });
    ElMessage.success('用户已创建');
    userDialog.value = false;
    resetUserForm();
    await loadData();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '用户创建失败');
  }
}

async function toggleUserStatus(user: User) {
  const willActivate = user.status !== 'ACTIVE';
  try {
    await ElMessageBox.confirm(
      willActivate
        ? `确定要启用用户“${user.displayName}（${user.username}）”吗？`
        : `确定要停用用户“${user.displayName}（${user.username}）”吗？停用后该账号将无法登录，但历史业务数据会保留。`,
      willActivate ? '启用用户' : '停用用户',
      {
        type: willActivate ? 'info' : 'warning',
        confirmButtonText: willActivate ? '确认启用' : '确认停用',
        cancelButtonText: '取消',
      },
    );
    await request(`/api/admin/users/${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: willActivate ? 'ACTIVE' : 'INACTIVE' }),
    });
    ElMessage.success(willActivate ? '用户已启用' : '用户已停用');
    await loadData();
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(error instanceof Error ? error.message : '用户状态更新失败');
  }
}

/** 打开改密码弹窗 */
function openPasswordDialog(user: User) {
  passwordTarget.value = user;
  passwordForm.password = '';
  passwordForm.confirm = '';
  passwordDialog.value = true;
}

/** 待删除的用户账号（不为空时显示高危确认弹窗） */
const deletingUser = ref<User | null>(null);
const deleteUserSaving = ref(false);

function openDeleteUser(user: User) {
  deletingUser.value = user;
}

/**
 * 确认删除用户账号。
 *
 * 删除原因由弹窗保证非空（前端拦一层），后端也会再校验一次 —— 后端才是真正的关口。
 * 后端还会拒绝：删除当前登录账号、删除系统管理员、删到只剩零个管理员。
 */
async function confirmDeleteUser(reason: string) {
  const target = deletingUser.value;
  if (!target) return;
  deleteUserSaving.value = true;
  try {
    await request(`/api/admin/users/${target.id}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
    ElMessage.success('账号已删除，可在「已删除数据」中恢复');
    deletingUser.value = null;
    await loadData();
  } catch (error) {
    // 后端拒绝时会把原因说清楚（例如"系统管理员账号不能删除"），原样展示
    ElMessage.error(error instanceof Error ? error.message : '账号删除失败');
  } finally {
    deleteUserSaving.value = false;
  }
}

/** 保存新密码：与后端一致，最少 8 位；两次输入必须一致 */
async function savePassword() {
  const target = passwordTarget.value;
  if (!target) return;
  if (passwordForm.password.length < 8) {
    ElMessage.warning('密码至少 8 位');
    return;
  }
  if (passwordForm.password !== passwordForm.confirm) {
    ElMessage.warning('两次输入的密码不一致');
    return;
  }
  passwordSaving.value = true;
  try {
    // 只提交 password，避免把弹窗里没有的字段（如 roleIds）一并写回导致角色被清空
    await request(`/api/admin/users/${target.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ password: passwordForm.password }),
    });
    ElMessage.success(`已修改「${target.displayName}（${target.username}）」的密码`);
    passwordDialog.value = false;
    passwordTarget.value = null;
    passwordForm.password = '';
    passwordForm.confirm = '';
    await loadData();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '密码修改失败');
  } finally {
    passwordSaving.value = false;
  }
}

async function createRole() {
  try {
    await request('/api/admin/roles', { method: 'POST', body: JSON.stringify({ ...roleForm, description: roleForm.description || undefined }) });
    ElMessage.success('角色已创建');
    roleDialog.value = false;
    resetRoleForm();
    await loadData();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '角色创建失败');
  }
}

function openPermissionDialog(role: Role) {
  selectedRole.value = role;
  selectedPermissionIds.value = role.permissions.filter((item) => item.allowed).map((item) => item.permissionId);
  selectedDataScope.value = role.permissions.find((item) => item.allowed)?.dataScope ?? 'DEPARTMENT';
  permissionDialog.value = true;
}

async function saveRolePermissions() {
  if (!selectedRole.value) return;
  permissionSaving.value = true;
  try {
    await request(`/api/admin/roles/${selectedRole.value.id}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({
        assignments: selectedPermissionIds.value.map((permissionId) => ({ permissionId, allowed: true, dataScope: selectedDataScope.value })),
      }),
    });
    ElMessage.success('角色权限已保存');
    permissionDialog.value = false;
    await loadData();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '角色权限保存失败');
  } finally {
    permissionSaving.value = false;
  }
}

onMounted(loadData);
</script>

<template>
  <section class="admin-page">
    <div class="page-heading admin-heading">
      <div>
        <p class="eyebrow">系统 B · 权限与配置</p>
        <h1>管理系统</h1>
        <p class="subtitle">维护组织架构、用户、角色与基础权限。所有新增操作均需要系统管理员权限。</p>
      </div>
      <el-button :loading="loading" @click="loadData">刷新数据</el-button>
    </div>

    <el-tabs v-model="activeTab" class="admin-tabs">
      <el-tab-pane label="总览" name="overview">
        <el-row :gutter="16" class="summary-row">
          <el-col :xs="24" :sm="12" :lg="6"><el-card shadow="never" class="summary-card"><span class="summary-label">部门</span><strong>{{ flatDepartments.length }}</strong><small>组织架构节点</small></el-card></el-col>
          <el-col :xs="24" :sm="12" :lg="6"><el-card shadow="never" class="summary-card"><span class="summary-label">用户</span><strong>{{ users.length }}</strong><small>可登录账号</small></el-card></el-col>
          <el-col :xs="24" :sm="12" :lg="6"><el-card shadow="never" class="summary-card"><span class="summary-label">角色</span><strong>{{ roles.length }}</strong><small>授权角色</small></el-card></el-col>
          <el-col :xs="24" :sm="12" :lg="6"><el-card shadow="never" class="summary-card"><span class="summary-label">权限点</span><strong>{{ permissions.length }}</strong><small>基础权限定义</small></el-card></el-col>
        </el-row>
        <el-card shadow="never" class="content-card">
          <template #header><div class="card-header"><span>当前权限模型</span><el-tag type="success" effect="plain">已启用</el-tag></div></template>
          <div class="model-note">系统管理员 → 用户 → 角色 → 权限点，并通过部门关系控制数据范围。后续业务模块接入时，将沿用同一套权限校验与审计记录。</div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="组织架构" name="departments">
        <el-card shadow="never" class="content-card">
          <template #header><div class="card-header"><span>部门管理</span><el-button type="primary" @click="openCreateDepartment">新建部门</el-button></div></template>
          <el-table :data="flatDepartments" stripe empty-text="暂无部门">
            <el-table-column label="部门名称" min-width="220"><template #default="scope"><span :style="{ paddingLeft: `${scope.row.level * 22}px` }">{{ scope.row.level ? '└ ' : '' }}{{ scope.row.name }}</span></template></el-table-column>
            <el-table-column label="负责人" width="150"><template #default="scope">{{ scope.row.manager?.displayName ?? '未设置' }}</template></el-table-column>
            <el-table-column label="成员" width="100"><template #default="scope">{{ scope.row._count.members }}</template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="scope"><el-tag :type="scope.row.isActive ? 'success' : 'info'" size="small">{{ scope.row.isActive ? '启用' : '停用' }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="160" fixed="right">
              <template #default="scope">
                <el-button link type="primary" @click="openEditDepartment(scope.row)">编辑</el-button>
                <el-tooltip
                  :disabled="!departmentDeleteBlockReason(scope.row)"
                  :content="departmentDeleteBlockReason(scope.row)"
                  placement="top"
                >
                  <span>
                    <el-button
                      link
                      type="danger"
                      :disabled="Boolean(departmentDeleteBlockReason(scope.row))"
                      @click="removeDepartment(scope.row)"
                    >
                      删除
                    </el-button>
                  </span>
                </el-tooltip>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="用户账号" name="users">
        <el-card shadow="never" class="content-card">
          <template #header><div class="card-header"><span>用户账号</span><el-button type="primary" @click="userDialog = true">新建用户</el-button></div></template>
          <el-table :data="users" stripe empty-text="暂无用户">
            <el-table-column prop="displayName" label="姓名" min-width="150" />
            <el-table-column prop="username" label="用户名" width="150" />
            <el-table-column label="部门" min-width="180"><template #default="scope">{{ joinNames(scope.row.departments) }}</template></el-table-column>
            <el-table-column label="角色" min-width="180"><template #default="scope">{{ joinNames(scope.row.roles) }}</template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="scope"><el-tag :type="scope.row.status === 'ACTIVE' ? 'success' : 'info'" size="small">{{ scope.row.status === 'ACTIVE' ? '启用' : '停用' }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="260" fixed="right"><template #default="scope"><el-button link :type="scope.row.status === 'ACTIVE' ? 'danger' : 'primary'" @click="toggleUserStatus(scope.row)">{{ scope.row.status === 'ACTIVE' ? '停用' : '启用' }}</el-button><el-button link type="primary" @click="openPasswordDialog(scope.row)">修改密码</el-button><el-button link type="danger" @click="openDeleteUser(scope.row)">删除</el-button></template></el-table-column>
          </el-table>

          <!-- 删除用户：PRD 7.2 高危确认（勾选风险 + 必填原因）。系统管理员账号不允许删除，后端会拒绝并说明原因 -->
          <DangerDeleteDialog
            :model-value="deletingUser !== null"
            title="删除用户账号"
            :target="deletingUser ? `${deletingUser.displayName}（${deletingUser.username}）` : ''"
            consequences="删除后该账号无法登录，且会解除它的角色与部门关联；如需继续使用需重新分配角色并重设密码。管理员可在「已删除数据」中恢复账号。"
            :loading="deleteUserSaving"
            @update:model-value="(value: boolean) => { if (!value) deletingUser = null; }"
            @confirm="confirmDeleteUser"
          />
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="角色权限" name="roles">
        <el-card shadow="never" class="content-card">
          <template #header><div class="card-header"><span>角色列表</span><el-button type="primary" @click="roleDialog = true">新建角色</el-button></div></template>
          <el-table :data="roles" stripe empty-text="暂无角色">
            <el-table-column prop="name" label="角色名称" min-width="170" />
            <el-table-column label="类型" width="120"><template #default="scope"><el-tag :type="scope.row.isSystem ? 'warning' : 'info'" size="small">{{ scope.row.isSystem ? '系统角色' : '自定义角色' }}</el-tag></template></el-table-column>
            <el-table-column label="用户数" width="100"><template #default="scope">{{ scope.row._count.users }}</template></el-table-column>
            <el-table-column label="权限数" width="100"><template #default="scope">{{ scope.row._count.permissions }}</template></el-table-column>
            <el-table-column prop="description" label="说明" min-width="220" />
            <el-table-column label="操作" width="130"><template #default="scope"><el-button link type="primary" :disabled="scope.row.isSystem && scope.row.code === 'SYSTEM_ADMIN'" @click="openPermissionDialog(scope.row)">配置权限</el-button></template></el-table-column>
          </el-table>
        </el-card>
        <el-card shadow="never" class="content-card permission-card">
          <template #header><div class="card-header"><span>权限点清单</span><el-tag type="info" effect="plain">只读预览</el-tag></div></template>
          <div v-for="[resource, items] in permissionByResource" :key="resource" class="permission-group"><strong>{{ resource }}</strong><el-tag v-for="item in items" :key="item.id" size="small" effect="plain">{{ item.name }}</el-tag></div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="模块字段" name="fields">
        <el-card shadow="never" class="content-card">
          <template #header>
            <div class="card-header">
              <span>业务模板字段</span>
              <el-button type="primary" @click="resetFieldForm(); fieldDialog = true">新增字段</el-button>
            </div>
          </template>
          <div class="field-toolbar">
            <el-select v-model="fieldModuleFilter" style="width: 260px">
              <el-option v-for="item in fieldModuleOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <span class="field-hint">这里配置的是系统 A 的模板，不是新增业务数据；「停用」的字段不再出现在录入表单与列表中，仅保留以便恢复。</span>
          </div>
          <el-table :data="visibleFieldDefinitions" stripe empty-text="该模板暂时没有字段">
            <el-table-column label="字段名称" min-width="170">
              <template #default="scope">
                <span :class="{ 'field-disabled': !scope.row.isActive }">{{ scope.row.label }}</span>
                <el-tag v-if="!scope.row.isActive" size="small" type="info" class="field-disabled-tag">已停用</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="类型" width="120"><template #default="scope">{{ fieldTypeOptions.find((item) => item.value === scope.row.fieldType)?.label ?? scope.row.fieldType }}</template></el-table-column>
            <el-table-column label="必填" width="90"><template #default="scope"><el-tag size="small" :type="scope.row.isRequired ? 'warning' : 'info'">{{ scope.row.isRequired ? '是' : '否' }}</el-tag></template></el-table-column>
            <el-table-column label="列表显示" width="100"><template #default="scope">{{ scope.row.isListVisible ? '是' : '否' }}</template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="scope"><el-tag size="small" :type="scope.row.isActive ? 'success' : 'info'">{{ scope.row.isActive ? '启用' : '停用' }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="160"><template #default="scope"><el-button link type="primary" @click="openFieldEdit(scope.row)">编辑</el-button><el-button link :type="scope.row.isActive ? 'danger' : 'primary'" :disabled="scope.row.isSystem && scope.row.isActive" @click="toggleField(scope.row)">{{ scope.row.isActive ? '删除' : '恢复' }}</el-button></template></el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="提醒配置" name="reminders">
        <ReminderConfig :token="props.token" />
      </el-tab-pane>

      <el-tab-pane label="反馈配置" name="feedback">
        <FeedbackRoutingConfig :token="props.token" />
      </el-tab-pane>

      <el-tab-pane label="导出配置" name="export">
        <ExportConfig :token="props.token" />
      </el-tab-pane>

      <!-- PRD 7.1：管理员可查看已删除数据并恢复 -->
      <el-tab-pane label="已删除数据" name="deleted">
        <DeletedRecordsAdmin :token="props.token" />
      </el-tab-pane>

      <el-tab-pane label="选项配置" name="options">
        <OptionsAdmin :token="props.token" />
      </el-tab-pane>

      <el-tab-pane label="流程管理" name="workflows">
        <WorkflowAdmin :token="props.token" />
      </el-tab-pane>

      <el-tab-pane label="操作日志" name="audit">
        <el-card shadow="never" class="content-card">
          <template #header><div class="card-header"><span>操作日志</span><el-tag type="warning" effect="plain">只增不改</el-tag></div></template>
          <el-table :data="auditLogs" stripe empty-text="暂无操作记录">
            <el-table-column label="时间" width="190"><template #default="scope">{{ new Date(scope.row.createdAt).toLocaleString('zh-CN') }}</template></el-table-column>
            <el-table-column label="操作人" width="150"><template #default="scope">{{ scope.row.actor?.displayName ?? '系统' }}</template></el-table-column>
            <el-table-column prop="actionLabel" label="动作" width="150" />
            <el-table-column prop="resourceTypeLabel" label="对象类型" width="150" />
            <el-table-column prop="resourceDisplayId" label="对象" min-width="220" />
            <el-table-column prop="reason" label="备注" min-width="180" />
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-dialog
      v-model="departmentDialog"
      :title="editingDepartmentId ? '编辑部门' : '新建部门'"
      width="480px"
      @closed="resetDepartmentForm"
    >
      <el-form label-position="top">
        <el-form-item label="部门名称" required>
          <el-input v-model="departmentForm.name" placeholder="例如：销售部" />
        </el-form-item>
        <el-form-item label="上级部门">
          <el-select v-model="departmentForm.parentId" clearable placeholder="留空表示顶层部门" style="width: 100%">
            <el-option v-for="item in departmentParentOptions" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
          <span class="field-hint">
            {{ editingDepartmentId ? '可改上级或清空以提升为顶层部门；自己的下级部门不会出现在这里（避免形成循环）。' : '留空即为顶层部门。' }}
          </span>
        </el-form-item>
        <el-form-item label="部门负责人">
          <el-select v-model="departmentForm.managerId" clearable placeholder="可选" style="width: 100%">
            <el-option v-for="item in activeUsers" :key="item.id" :label="item.displayName" :value="item.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="departmentDialog = false">取消</el-button>
        <el-button v-if="editingDepartmentId" type="primary" :loading="departmentSaving" @click="saveDepartment">保存</el-button>
        <el-button v-else type="primary" @click="createDepartment">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="userDialog" title="新建用户" width="520px" @closed="resetUserForm">
      <el-form label-position="top"><el-form-item label="姓名" required><el-input v-model="userForm.displayName" /></el-form-item><el-form-item label="用户名" required><el-input v-model="userForm.username" /></el-form-item><el-form-item label="初始密码" required><el-input v-model="userForm.password" type="password" show-password placeholder="至少 8 位" /></el-form-item><el-row :gutter="12"><el-col :span="12"><el-form-item label="邮箱"><el-input v-model="userForm.email" /></el-form-item></el-col><el-col :span="12"><el-form-item label="联系电话"><el-input v-model="userForm.phone" /></el-form-item></el-col></el-row><el-form-item label="所属部门"><el-select v-model="userForm.departmentIds" multiple clearable style="width: 100%"><el-option v-for="item in departmentOptions" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item><el-form-item label="角色"><el-select v-model="userForm.roleIds" multiple clearable style="width: 100%"><el-option v-for="item in roles" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item></el-form>
      <template #footer><el-button @click="userDialog = false">取消</el-button><el-button type="primary" @click="createUser">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="passwordDialog" title="修改密码" width="460px">
      <el-alert v-if="passwordTarget" type="info" :closable="false" show-icon class="password-target">
        <template #title>
          正在修改「{{ passwordTarget.displayName }}（{{ passwordTarget.username }}）」的密码
        </template>
      </el-alert>
      <el-form label-position="top">
        <el-form-item label="新密码" required>
          <el-input v-model="passwordForm.password" type="password" show-password placeholder="至少 8 位" />
        </el-form-item>
        <el-form-item label="确认新密码" required>
          <el-input v-model="passwordForm.confirm" type="password" show-password placeholder="再输入一次" />
        </el-form-item>
      </el-form>
      <span class="field-hint">修改后该账号下次登录需使用新密码；已登录的会话不受影响（令牌在有效期内仍然可用）。</span>
      <template #footer>
        <el-button @click="passwordDialog = false">取消</el-button>
        <el-button type="primary" :loading="passwordSaving" @click="savePassword">确认修改</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="roleDialog" title="新建角色" width="480px" @closed="resetRoleForm">
      <el-form label-position="top"><el-form-item label="角色名称" required><el-input v-model="roleForm.name" /></el-form-item><el-form-item label="角色说明"><el-input v-model="roleForm.description" type="textarea" :rows="3" /></el-form-item></el-form>
      <template #footer><el-button @click="roleDialog = false">取消</el-button><el-button type="primary" @click="createRole">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="permissionDialog" :title="`配置权限 · ${selectedRole?.name ?? ''}`" width="680px">
      <el-form label-position="top">
        <el-form-item label="数据范围"><el-select v-model="selectedDataScope" style="width: 260px"><el-option label="全部数据" value="ALL" /><el-option label="本部门及下属" value="DEPARTMENT_AND_DESCENDANTS" /><el-option label="本部门" value="DEPARTMENT" /><el-option label="仅本人" value="SELF" /><el-option label="关联数据" value="RELATED" /><el-option label="无数据" value="NONE" /></el-select></el-form-item>
        <el-form-item label="权限点"><el-checkbox-group v-model="selectedPermissionIds" class="permission-checkboxes"><el-checkbox v-for="permission in permissions" :key="permission.id" :label="permission.id">{{ permission.name }}</el-checkbox></el-checkbox-group></el-form-item>
      </el-form>
      <template #footer><el-button @click="permissionDialog = false">取消</el-button><el-button type="primary" :loading="permissionSaving" @click="saveRolePermissions">保存权限</el-button></template>
    </el-dialog>

    <el-dialog v-model="fieldDialog" :title="editingFieldId ? '编辑模板字段' : '新增模板字段'" width="560px" @closed="resetFieldForm">
      <el-form label-position="top">
        <el-row :gutter="14">
          <el-col :span="12"><el-form-item label="所属模块" required><el-select v-model="fieldForm.moduleKey" style="width: 100%"><el-option v-for="item in fieldModuleOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="字段类型" required><el-select v-model="fieldForm.fieldType" style="width: 100%"><el-option v-for="item in fieldTypeOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item></el-col>
        </el-row>
        <el-row :gutter="14">
          <el-col :span="24">
            <el-form-item label="字段名称" required>
              <el-input v-model="fieldForm.label" placeholder="例如：申请号" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item v-if="fieldForm.fieldType === 'SELECT' || fieldForm.fieldType === 'MULTI_SELECT'" label="可选项（一行一个）" required>
          <el-input v-model="fieldOptionsText" type="textarea" :rows="4" placeholder="例如：&#10;华东&#10;华南&#10;华北" />
        </el-form-item>
        <el-row :gutter="14"><el-col :span="8"><el-form-item label="排序"><el-input-number v-model="fieldForm.sortOrder" :min="0" style="width: 100%" /></el-form-item></el-col><el-col :span="8"><el-form-item label="必填"><el-switch v-model="fieldForm.isRequired" /></el-form-item></el-col><el-col :span="8"><el-form-item label="列表显示"><el-switch v-model="fieldForm.isListVisible" /></el-form-item></el-col></el-row>
        <el-form-item label="可搜索"><el-switch v-model="fieldForm.isSearchable" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="fieldDialog = false">取消</el-button><el-button type="primary" @click="saveFieldDefinition">保存字段</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.admin-heading {
  margin-bottom: 18px;
}

/* 标签页头部做成卡片式，与页面其它区块保持一致 */
.admin-tabs :deep(.el-tabs__header) {
  margin: 0 0 20px;
  padding: 0 18px;
  border: 1px solid #e4e9f2;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 1px 2px rgb(16 35 66 / 6%);
}

.admin-tabs :deep(.el-tabs__nav-wrap::after) {
  display: none;
}

.admin-tabs :deep(.el-tabs__item) {
  height: 50px;
  color: #5b6b85;
  font-size: 14px;
}

.admin-tabs :deep(.el-tabs__item.is-active) {
  color: #1d4ed8;
  font-weight: 600;
}

.model-note {
  color: #46587a;
  line-height: 1.9;
}

.permission-card {
  margin-top: 16px;
}

.permission-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid #edf1f5;
}

.permission-group:last-child {
  border-bottom: 0;
}

.permission-group strong {
  min-width: 100px;
  color: #1f3355;
}

.permission-checkboxes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 12px;
}

.field-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
}

.field-hint {
  color: #5b6b85;
  font-size: 13px;
}

.field-key-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.field-key-input {
  flex: 1;
}

.field-key-row + .field-hint {
  display: block;
  margin-top: 4px;
  color: #8b99ad;
  font-size: 12px;
  line-height: 1.6;
}

.field-disabled {
  color: #a8b3c4;
  text-decoration: line-through;
}

.field-disabled-tag {
  margin-left: 8px;
}

/* 修改密码弹窗：目标账号提示与下方说明的间距 */
.password-target {
  margin-bottom: 14px;
}
</style>






<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

type OptionItem = {
  id: string;
  moduleKey: string;
  code: string;
  label: string;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
  isSystem: boolean;
  /** 业务时限天数（PRD 4.7 系统算建议截止日）：仅合同类型使用 */
  timeLimitDays: number | null;
  timeLimitNote: string | null;
};

const props = defineProps<{ token: string }>();

const moduleKey = ref<'contractType' | 'projectType'>('contractType');
const options = ref<OptionItem[]>([]);
const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const form = reactive({ label: '', sortOrder: 1, timeLimitDays: undefined as number | undefined, timeLimitNote: '' });
/** 业务类型未单独配置时限时使用的全局默认值 */
const defaultTimeLimitDays = ref<number>(30);
const savingDefault = ref(false);

const moduleLabel = computed(() => (moduleKey.value === 'contractType' ? '合同类型' : '项目类型'));

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}`, ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? '请求失败');
  return payload as T;
}

async function loadOptions() {
  loading.value = true;
  try {
    options.value = await request<OptionItem[]>(`/api/admin/options/${moduleKey.value}`);
    if (moduleKey.value === 'contractType') await loadTimeLimits();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '选项加载失败');
  } finally {
    loading.value = false;
  }
}

/** 读取全局默认时限（业务类型未单独配置时使用） */
async function loadTimeLimits() {
  try {
    const result = await request<{ defaultTimeLimitDays: number }>('/api/admin/time-limits');
    defaultTimeLimitDays.value = result.defaultTimeLimitDays;
  } catch {
    // 时限配置读取失败不影响选项维护
  }
}

async function saveDefaultTimeLimit() {
  savingDefault.value = true;
  try {
    await request('/api/admin/time-limits/default', {
      method: 'POST',
      body: JSON.stringify({ defaultTimeLimitDays: defaultTimeLimitDays.value }),
    });
    ElMessage.success('已保存默认时限，系统算建议截止日会立即使用该值');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    savingDefault.value = false;
  }
}

/** 新增选项时的默认排序号：当前列表最大值 + 1（排在最后）。 */
function nextSortOrder() {
  const orders = options.value.map((item) => item.sortOrder);
  return orders.length > 0 ? Math.max(...orders) + 1 : 1;
}

function resetForm() {
  Object.assign(form, { label: '', sortOrder: nextSortOrder(), timeLimitDays: undefined, timeLimitNote: '' });
  editingId.value = null;
}

function openCreate() {
  resetForm();
  dialogVisible.value = true;
}

function openEdit(item: OptionItem) {
  editingId.value = item.id;
  Object.assign(form, {
    label: item.label,
    sortOrder: item.sortOrder,
    timeLimitDays: item.timeLimitDays ?? undefined,
    timeLimitNote: item.timeLimitNote ?? '',
  });
  dialogVisible.value = true;
}

const editingSystemOption = computed(() => {
  if (!editingId.value) return false;
  return options.value.find((item) => item.id === editingId.value)?.isSystem === true;
});

async function saveOption() {
  if (!form.label.trim()) {
    ElMessage.warning('请填写显示名称');
    return;
  }
  saving.value = true;
  try {
    if (editingId.value) {
      await request(`/api/admin/options/${moduleKey.value}/${editingId.value}`, {
        method: 'PATCH',
        body: JSON.stringify({
          label: form.label.trim(),
          sortOrder: Number(form.sortOrder) || 0,
          ...(moduleKey.value === 'contractType' ? { timeLimitDays: form.timeLimitDays ?? null, timeLimitNote: form.timeLimitNote } : {}),
        }),
      });
      ElMessage.success('已更新');
    } else {
      const created = await request<OptionItem>(`/api/admin/options/${moduleKey.value}`, {
        method: 'POST',
        body: JSON.stringify({ label: form.label.trim(), sortOrder: Number(form.sortOrder) || 0 }),
      });
      // 新建时如果填了时限，紧接着补一次更新（创建接口不接收时限，避免与选项通用字段耦合过深）
      if (moduleKey.value === 'contractType' && form.timeLimitDays !== undefined) {
        if (created?.id) {
          await request(`/api/admin/options/${moduleKey.value}/${created.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ timeLimitDays: form.timeLimitDays, timeLimitNote: form.timeLimitNote }),
          });
        }
      }
      ElMessage.success('已新增');
    }
    dialogVisible.value = false;
    await loadOptions();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function deleteCustomOption(item: OptionItem) {
  if (item.isSystem || !item.isActive) return;
  try {
    await ElMessageBox.confirm(
      `删除自定义类型「${item.label}」后，新建业务时不能再选择，已使用该类型的历史合同和项目仍会保留。`,
      '确认删除自定义类型',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await request(`/api/admin/options/${moduleKey.value}/${item.id}`, { method: 'DELETE' });
    ElMessage.success('自定义类型已删除');
    await loadOptions();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除自定义类型失败');
  }
}

onMounted(loadOptions);
</script>

<template>
  <el-card shadow="never" class="content-card">
    <template #header>
      <div class="card-header">
        <span>选项配置</span>
        <el-button type="primary" size="small" @click="openCreate">新增{{ moduleLabel }}</el-button>
      </div>
    </template>

    <div class="field-toolbar">
      <el-radio-group v-model="moduleKey" @change="loadOptions">
        <el-radio-button value="contractType">合同类型</el-radio-button>
        <el-radio-button value="projectType">项目类型</el-radio-button>
      </el-radio-group>
      <span class="field-hint">
        {{ moduleLabel }}在系统 A 是下拉选择，不能手工输入；项目会按类型名称匹配同名流程模板。
      </span>
    </div>

    <div v-if="moduleKey === 'contractType'" class="time-limit-bar">
      <span class="time-limit-label">默认业务时限</span>
      <el-input-number v-model="defaultTimeLimitDays" :min="1" :max="3650" size="small" controls-position="right" />
      <span class="field-hint">天。业务类型未单独配置时限时使用该值。</span>
      <el-button size="small" :loading="savingDefault" @click="saveDefaultTimeLimit">保存默认值</el-button>
    </div>

    <el-table v-loading="loading" :data="options" stripe empty-text="暂无选项，点右上角新增">
      <el-table-column prop="label" label="显示名称" min-width="120" />
      <el-table-column prop="sortOrder" label="排序" width="80" />
      <el-table-column v-if="moduleKey === 'contractType'" label="业务时限" width="200">
        <template #default="scope">
          <template v-if="scope.row.timeLimitDays">
            <el-tag size="small" effect="plain">{{ scope.row.timeLimitDays }} 天</el-tag>
            <div class="limit-note">{{ scope.row.timeLimitNote || '无说明' }}</div>
          </template>
          <span v-else class="field-hint">用默认 {{ defaultTimeLimitDays }} 天</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="80">
        <template #default="scope">
          <el-tag size="small" :type="scope.row.isActive ? 'success' : 'info'">{{ scope.row.isActive ? '启用' : '已删除' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="scope">
          <template v-if="scope.row.isSystem">
            <el-tag size="small" type="warning" effect="plain">系统内置</el-tag>
          </template>
          <template v-else-if="scope.row.isActive">
            <el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button>
            <el-button link type="danger" @click="deleteCustomOption(scope.row)">删除</el-button>
          </template>
          <el-tag v-else size="small" type="info" effect="plain">已删除</el-tag>
        </template>
      </el-table-column>
    </el-table>

    <el-alert type="info" :closable="false" show-icon class="option-note"
      title="系统内置类型不可删除；自定义类型删除采用软删除，新建时不能再选择，但已使用该类型的历史合同/项目仍能正确显示。" />

    <el-dialog v-model="dialogVisible" :title="editingId ? `编辑${moduleLabel}` : `新增${moduleLabel}`" width="480px" @closed="resetForm">
      <el-form label-position="top">
        <el-form-item label="显示名称" required>
          <el-input v-model="form.label" :disabled="editingSystemOption" placeholder="例如：专利" />
          <span v-if="editingSystemOption" class="field-hint">系统内置类型名称不可修改，只能维护业务时限和排序。</span>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sortOrder" :min="0" :max="9999" style="width: 100%" />
        </el-form-item>
        <template v-if="moduleKey === 'contractType'">
          <el-form-item label="业务时限天数（系统算建议截止日）">
            <el-input-number v-model="form.timeLimitDays" :min="1" :max="3650" placeholder="留空用默认值" style="width: 100%" />
            <span class="field-hint">留空表示使用默认时限。系统按「签约日 + 该天数」推算建议法定截止日，且不会超过合同到期日。</span>
          </el-form-item>
          <el-form-item label="时限说明">
            <el-input v-model="form.timeLimitNote" maxlength="200" placeholder="例如：发明专利常规周期，按实际局方时限调整" />
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveOption">保存</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.option-note {
  margin-top: 14px;
}

.time-limit-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 14px;
  border: 1px solid #e4e9f2;
  border-radius: 8px;
  background: #f8fafc;
}

.time-limit-label {
  color: #5b6b85;
  font-size: 13px;
  font-weight: 600;
}

.limit-note {
  margin-top: 2px;
  color: #8b99ad;
  font-size: 12px;
  line-height: 1.5;
}
</style>

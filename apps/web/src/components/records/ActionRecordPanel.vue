<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import OptionSelector from '../OptionSelector.vue';
import CustomFieldForm from '../CustomFieldForm.vue';
import CustomFieldColumns from '../CustomFieldColumns.vue';
import { describeError, apiRequest, formatDate, useCustomFieldPresence, useOptionLabels } from './record-utils';

type ActionRecord = {
  id: string;
  projectId: string;
  actionType: string;
  actionAt: string;
  note: string | null;
  operator: { id: string; displayName: string } | null;
  customFields?: Record<string, unknown> | null;
};

/**
 * 动作记录（PRD 4.8）：归属**项目**。
 *
 * PRD 要求「动作类型可自定义」+「必录实际日期」。
 * 动作类型走系统 B 的选项配置；**若一个选项都没配，允许自由输入**，
 * 避免刚上线还没配置时完全无法录入（后端也是这个口径）。
 * 本页面只做「记录事实」，不联动流程节点推进（按业务确认）。
 */
const props = defineProps<{
  token: string;
  projectId: string;
  canManage: boolean;
  canDelete: boolean;
}>();

const items = ref<ActionRecord[]>([]);
const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const form = reactive({ actionType: '', actionAt: '', note: '' });
/** 自定义字段取值：由系统 B 的字段定义驱动（模块 action_record） */
const customFieldValues = ref<Record<string, unknown>>({});
const { hasCustomFields, load: loadCustomFieldPresence } = useCustomFieldPresence(props.token, 'action_record');
const { labelOf, load: loadOptionLabels } = useOptionLabels(props.token, ['actionType']);
/** 动作类型是否一个都没配：没配就让用户直接输入 */
const allowFreeText = ref(false);

async function load() {
  loading.value = true;
  try {
    const result = await apiRequest<{ items: ActionRecord[] }>(
      props.token,
      `/api/records/action-records?projectId=${props.projectId}&pageSize=100`,
    );
    items.value = result.items;
  } catch (error) {
    ElMessage.error(describeError(error, '动作记录加载失败'));
  } finally {
    loading.value = false;
  }
}

/** 检查动作类型是否已配置（未配置时允许自由填写） */
async function checkActionTypeConfigured() {
  try {
    const options = await apiRequest<Array<{ code: string }>>(props.token, '/api/options/list/actionType');
    allowFreeText.value = options.length === 0;
  } catch {
    allowFreeText.value = true;
  }
}

function resetForm() {
  Object.assign(form, { actionType: '', actionAt: '', note: '' });
  customFieldValues.value = {};
}

function openCreate() {
  editingId.value = null;
  resetForm();
  dialogVisible.value = true;
}

function openEdit(row: ActionRecord) {
  editingId.value = row.id;
  Object.assign(form, {
    actionType: row.actionType,
    actionAt: formatDate(row.actionAt),
    note: row.note ?? '',
  });
  customFieldValues.value = { ...(row.customFields ?? {}) };
  dialogVisible.value = true;
}

async function save() {
  if (!form.actionType.trim()) {
    ElMessage.warning('请选择或填写动作类型');
    return;
  }
  if (!form.actionAt) {
    ElMessage.warning('请填写实际日期');
    return;
  }
  saving.value = true;
  try {
    const body = JSON.stringify({
      ...(editingId.value ? {} : { projectId: props.projectId }),
      actionType: form.actionType.trim(),
      actionAt: form.actionAt,
      note: form.note || undefined,
      customFields: customFieldValues.value,
    });
    if (editingId.value) {
      await apiRequest(props.token, `/api/records/action-records/${editingId.value}`, { method: 'PATCH', body });
      ElMessage.success('动作记录已更新');
    } else {
      await apiRequest(props.token, '/api/records/action-records', { method: 'POST', body });
      ElMessage.success('动作记录已登记');
    }
    dialogVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function remove(row: ActionRecord) {
  try {
    const { value } = await ElMessageBox.prompt('请填写删除原因（会写入操作日志）', '删除动作记录', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      inputPlaceholder: '例如：录入错误',
      inputValidator: (text: string) => (text?.trim() ? true : '删除原因必填'),
    });
    await apiRequest(props.token, `/api/records/action-records/${row.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: value }),
    });
    ElMessage.success('已删除');
    await load();
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(error instanceof Error ? error.message : '删除失败');
  }
}

onMounted(async () => {
  await Promise.all([load(), loadOptionLabels(), checkActionTypeConfigured(), loadCustomFieldPresence()]);
});
defineExpose({ reload: load });
</script>

<template>
  <div class="record-panel">
    <div class="tab-toolbar">
      <span class="tab-hint">
        动作记录归属本项目，用于留痕「谁在什么时候做了什么」。实际日期必填；只记录事实，不联动流程推进。
      </span>
      <el-button v-if="props.canManage" type="primary" size="small" @click="openCreate">登记动作</el-button>
    </div>

    <el-table v-loading="loading" :data="items" stripe empty-text="暂无动作记录">
      <el-table-column label="动作类型" min-width="160">
        <template #default="scope">{{ labelOf(scope.row.actionType) }}</template>
      </el-table-column>
      <el-table-column label="实际日期" width="130">
        <template #default="scope">{{ formatDate(scope.row.actionAt) }}</template>
      </el-table-column>
      <el-table-column label="操作人" width="130">
        <template #default="scope">{{ scope.row.operator?.displayName ?? '-' }}</template>
      </el-table-column>
      <el-table-column label="说明" min-width="200"><template #default="scope">{{ scope.row.note || '-' }}</template></el-table-column>
      <CustomFieldColumns :token="props.token" module-key="action_record" :rows="items" />
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="scope">
          <el-button v-if="props.canManage" link type="primary" @click="openEdit(scope.row)">编辑</el-button>
          <el-button v-if="props.canDelete" link type="danger" @click="remove(scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑动作记录' : '登记动作记录'" width="540px">
      <el-form label-position="top">
        <el-row :gutter="12">
          <el-col :span="14">
            <el-form-item label="动作类型" required>
              <OptionSelector
                v-model="form.actionType"
                :token="props.token"
                module-key="actionType"
                :allow-create="allowFreeText"
                :placeholder="allowFreeText ? '未配置选项，可直接输入' : '请选择'"
              />
            </el-form-item>
          </el-col>
          <el-col :span="10">
            <el-form-item label="实际日期" required>
              <el-date-picker v-model="form.actionAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <span v-if="allowFreeText" class="field-hint">
          当前「动作类型」尚未在系统 B 配置选项，这里可以直接输入；建议到「管理系统 → 选项配置」里统一维护。
        </span>
        <el-form-item label="说明">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="例如：已向官方递交申请文件" />
        </el-form-item>
        <el-divider v-if="hasCustomFields" content-position="left">自定义字段</el-divider>
        <CustomFieldForm :token="props.token" module-key="action_record" v-model="customFieldValues" />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.tab-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.tab-hint {
  color: #8b99ad;
  font-size: 12px;
  line-height: 1.7;
}

.field-hint {
  display: block;
  margin: -6px 0 12px;
  color: #909399;
  font-size: 12px;
}
</style>



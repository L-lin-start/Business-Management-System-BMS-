<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import OptionSelector from '../OptionSelector.vue';
import CustomFieldForm from '../CustomFieldForm.vue';
import CustomFieldColumns from '../CustomFieldColumns.vue';
import { describeError, apiRequest, formatDate, useCustomFieldPresence, useOptionLabels } from './record-utils';

type FilingResult = {
  id: string;
  projectId: string;
  resultCode: string;
  recordedAt: string;
  note: string | null;
  recordedBy: { id: string; displayName: string } | null;
  customFields?: Record<string, unknown> | null;
};

/**
 * 申报结果记录（PRD 4.9）：归属**项目**，由相关人员在项目详情页填写。
 * PRD 要求「状态可修改、修改留痕」—— 修改会写审计日志（后端已实现）。
 */
const props = defineProps<{
  token: string;
  projectId: string;
  canManage: boolean;
  canDelete: boolean;
}>();

const items = ref<FilingResult[]>([]);
const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const form = reactive({ resultCode: '', recordedAt: '', note: '' });
/** 自定义字段取值：由系统 B 的字段定义驱动（模块 filing_result） */
const customFieldValues = ref<Record<string, unknown>>({});
const { hasCustomFields, load: loadCustomFieldPresence } = useCustomFieldPresence(props.token, 'filing_result');
const { labelOf, load: loadOptionLabels } = useOptionLabels(props.token, ['filingResult']);

async function load() {
  loading.value = true;
  try {
    const result = await apiRequest<{ items: FilingResult[] }>(
      props.token,
      `/api/records/filing-results?projectId=${props.projectId}&pageSize=100`,
    );
    items.value = result.items;
  } catch (error) {
    ElMessage.error(describeError(error, '申报结果加载失败'));
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  Object.assign(form, { resultCode: '', recordedAt: todayText(), note: '' });
  customFieldValues.value = {};
}

/** 记录日期默认今天（本地日历，避免 UTC 差一天） */
function todayText(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function openCreate() {
  editingId.value = null;
  resetForm();
  dialogVisible.value = true;
}

function openEdit(row: FilingResult) {
  editingId.value = row.id;
  Object.assign(form, {
    resultCode: row.resultCode,
    recordedAt: formatDate(row.recordedAt),
    note: row.note ?? '',
  });
  customFieldValues.value = { ...(row.customFields ?? {}) };
  dialogVisible.value = true;
}

async function save() {
  if (!form.resultCode) {
    ElMessage.warning('请选择申报结果');
    return;
  }
  if (!form.recordedAt) {
    ElMessage.warning('请填写记录日期');
    return;
  }
  saving.value = true;
  try {
    const body = JSON.stringify({
      ...(editingId.value ? {} : { projectId: props.projectId }),
      resultCode: form.resultCode,
      recordedAt: form.recordedAt,
      note: form.note || undefined,
      customFields: customFieldValues.value,
    });
    if (editingId.value) {
      await apiRequest(props.token, `/api/records/filing-results/${editingId.value}`, { method: 'PATCH', body });
      ElMessage.success('申报结果已更新（修改已留痕）');
    } else {
      await apiRequest(props.token, '/api/records/filing-results', { method: 'POST', body });
      ElMessage.success('申报结果已记录');
    }
    dialogVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function remove(row: FilingResult) {
  try {
    const { value } = await ElMessageBox.prompt('请填写删除原因（会写入操作日志）', '删除申报结果记录', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      inputPlaceholder: '例如：录入错误',
      inputValidator: (text: string) => (text?.trim() ? true : '删除原因必填'),
    });
    await apiRequest(props.token, `/api/records/filing-results/${row.id}`, {
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
  await Promise.all([load(), loadOptionLabels(), loadCustomFieldPresence()]);
});
defineExpose({ reload: load });
</script>

<template>
  <div class="record-panel">
    <div class="tab-toolbar">
      <span class="tab-hint">
        申报结果归属本项目，由相关人员在项目详情页填写。状态可修改，修改会留痕。
      </span>
      <el-button v-if="props.canManage" type="primary" size="small" @click="openCreate">记录申报结果</el-button>
    </div>

    <el-table v-loading="loading" :data="items" stripe empty-text="暂无申报结果记录">
      <el-table-column label="申报结果" width="140">
        <template #default="scope">
          <el-tag
            size="small"
            :type="scope.row.resultCode === 'PASSED' ? 'success' : scope.row.resultCode === 'REJECTED' ? 'danger' : 'warning'"
          >
            {{ labelOf(scope.row.resultCode) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="记录日期" width="130">
        <template #default="scope">{{ formatDate(scope.row.recordedAt) }}</template>
      </el-table-column>
      <el-table-column label="记录人" width="130">
        <template #default="scope">{{ scope.row.recordedBy?.displayName ?? '-' }}</template>
      </el-table-column>
      <el-table-column label="说明" min-width="200"><template #default="scope">{{ scope.row.note || '-' }}</template></el-table-column>
      <CustomFieldColumns :token="props.token" module-key="filing_result" :rows="items" />
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="scope">
          <el-button v-if="props.canManage" link type="primary" @click="openEdit(scope.row)">编辑</el-button>
          <el-button v-if="props.canDelete" link type="danger" @click="remove(scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑申报结果' : '记录申报结果'" width="520px">
      <el-form label-position="top">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="申报结果" required>
              <OptionSelector v-model="form.resultCode" :token="props.token" module-key="filingResult" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="记录日期" required>
              <el-date-picker v-model="form.recordedAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="说明">
          <el-input v-model="form.note" type="textarea" :rows="3" placeholder="例如：初审通过，等待下证" />
        </el-form-item>
        <el-divider v-if="hasCustomFields" content-position="left">自定义字段</el-divider>
        <CustomFieldForm :token="props.token" module-key="filing_result" v-model="customFieldValues" />
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
</style>



<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';

type FeedbackItem = {
  id: string;
  feedbackNo: string;
  title: string;
  content: string;
  category: string | null;
  priority: string;
  priorityLabel: string;
  statusCode: string;
  statusLabel: string;
  handlingNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
  createdBy: { id: string; displayName: string; username: string } | null;
  handledBy: { id: string; displayName: string; username: string } | null;
};

const props = defineProps<{ token: string; modelValue: boolean; canManage: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});
const activeTab = ref('submit');
const saving = ref(false);
const loading = ref(false);
const queue = ref<FeedbackItem[]>([]);
const detailVisible = ref(false);
const selected = ref<FeedbackItem | null>(null);
const form = ref({ title: '', content: '', category: '', priority: 'NORMAL' });
const detailForm = ref({ statusCode: 'PENDING', handlingNote: '' });

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}`, ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? '请求失败');
  return payload as T;
}

async function loadQueue() {
  if (!props.canManage) return;
  loading.value = true;
  try {
    const result = await request<{ items: FeedbackItem[] }>('/api/feedback');
    queue.value = result.items;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '反馈队列加载失败');
  } finally {
    loading.value = false;
  }
}

async function submitFeedback() {
  if (!form.value.title.trim() || !form.value.content.trim()) {
    ElMessage.warning('请填写反馈标题和内容');
    return;
  }
  saving.value = true;
  try {
    const result = await request<{ feedbackNo: string }>('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({
        title: form.value.title.trim(),
        content: form.value.content.trim(),
        category: form.value.category.trim() || undefined,
        priority: form.value.priority,
      }),
    });
    ElMessage.success(`反馈已提交，编号：${result.feedbackNo}`);
    form.value = { title: '', content: '', category: '', priority: 'NORMAL' };
    if (props.canManage) await loadQueue();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '反馈提交失败');
  } finally {
    saving.value = false;
  }
}

function openDetail(item: FeedbackItem) {
  selected.value = item;
  detailForm.value = { statusCode: item.statusCode, handlingNote: item.handlingNote ?? '' };
  detailVisible.value = true;
}

async function saveDetail() {
  if (!selected.value) return;
  saving.value = true;
  try {
    await request(`/api/feedback/${selected.value.id}`, { method: 'PATCH', body: JSON.stringify(detailForm.value) });
    ElMessage.success('反馈处理状态已更新');
    detailVisible.value = false;
    await loadQueue();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '反馈更新失败');
  } finally {
    saving.value = false;
  }
}

function statusTagType(status: string) {
  return status === 'RESOLVED' ? 'success' : status === 'CLOSED' ? 'info' : status === 'PROCESSING' ? 'warning' : 'danger';
}

function priorityTagType(priority: string) {
  return priority === 'HIGH' ? 'danger' : priority === 'LOW' ? 'info' : 'warning';
}

watch(() => props.modelValue, (isVisible) => {
  if (isVisible && props.canManage) void loadQueue();
});
</script>

<template>
  <el-dialog v-model="visible" title="意见反馈" width="820px" destroy-on-close>
    <el-tabs v-model="activeTab">
      <el-tab-pane label="提交反馈" name="submit">
        <el-alert type="info" :closable="false" show-icon title="请描述遇到的问题、复现步骤和期望结果，技术人员会在系统内处理。" />
        <el-form label-position="top" class="feedback-form">
          <el-form-item label="反馈标题" required><el-input v-model="form.title" maxlength="100" show-word-limit placeholder="例如：合同附件无法预览" /></el-form-item>
          <el-row :gutter="16">
            <el-col :span="12"><el-form-item label="问题分类"><el-input v-model="form.category" maxlength="50" placeholder="例如：功能问题、数据问题、改进建议" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="紧急程度"><el-select v-model="form.priority" style="width: 100%"><el-option label="低" value="LOW" /><el-option label="普通" value="NORMAL" /><el-option label="高" value="HIGH" /></el-select></el-form-item></el-col>
          </el-row>
          <el-form-item label="反馈内容" required><el-input v-model="form.content" type="textarea" :rows="8" maxlength="5000" show-word-limit placeholder="请填写问题现象、操作步骤和期望结果" /></el-form-item>
        </el-form>
        <div class="feedback-footer"><el-button type="primary" :loading="saving" @click="submitFeedback">提交反馈</el-button></div>
      </el-tab-pane>

      <el-tab-pane v-if="props.canManage" label="处理队列" name="queue">
        <div class="queue-toolbar"><span>只有已配置的反馈接收部门成员可以查看此列表。</span><el-button size="small" :loading="loading" @click="loadQueue">刷新</el-button></div>
        <el-table v-loading="loading" :data="queue" stripe empty-text="暂无反馈">
          <el-table-column prop="feedbackNo" label="编号" width="130" />
          <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
          <el-table-column label="提交人" width="120"><template #default="scope">{{ scope.row.createdBy?.displayName ?? '未知' }}</template></el-table-column>
          <el-table-column label="优先级" width="90"><template #default="scope"><el-tag size="small" :type="priorityTagType(scope.row.priority)">{{ scope.row.priorityLabel }}</el-tag></template></el-table-column>
          <el-table-column label="状态" width="100"><template #default="scope"><el-tag size="small" :type="statusTagType(scope.row.statusCode)">{{ scope.row.statusLabel }}</el-tag></template></el-table-column>
          <el-table-column label="提交时间" width="165"><template #default="scope">{{ new Date(scope.row.createdAt).toLocaleString('zh-CN') }}</template></el-table-column>
          <el-table-column label="操作" width="80" fixed="right"><template #default="scope"><el-button link type="primary" @click="openDetail(scope.row)">处理</el-button></template></el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </el-dialog>

  <el-dialog v-model="detailVisible" title="处理反馈" width="620px">
    <template v-if="selected">
      <el-descriptions :column="2" border>
        <el-descriptions-item label="编号">{{ selected.feedbackNo }}</el-descriptions-item>
        <el-descriptions-item label="提交人">{{ selected.createdBy?.displayName ?? '未知' }}</el-descriptions-item>
        <el-descriptions-item label="标题" :span="2">{{ selected.title }}</el-descriptions-item>
        <el-descriptions-item label="反馈内容" :span="2"><div class="feedback-content">{{ selected.content }}</div></el-descriptions-item>
      </el-descriptions>
      <el-form label-position="top" class="detail-form">
        <el-form-item label="处理状态"><el-select v-model="detailForm.statusCode" style="width: 100%"><el-option label="待处理" value="PENDING" /><el-option label="处理中" value="PROCESSING" /><el-option label="已解决" value="RESOLVED" /><el-option label="已关闭" value="CLOSED" /></el-select></el-form-item>
        <el-form-item label="处理备注"><el-input v-model="detailForm.handlingNote" type="textarea" :rows="4" maxlength="2000" show-word-limit placeholder="记录处理结果或回复内容" /></el-form-item>
      </el-form>
    </template>
    <template #footer><el-button @click="detailVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveDetail">保存处理结果</el-button></template>
  </el-dialog>
</template>

<style scoped>
.feedback-form { margin-top: 18px; }
.feedback-footer { display: flex; justify-content: flex-end; margin-top: 4px; }
.queue-toolbar { display: flex; align-items: center; justify-content: space-between; color: #64748b; font-size: 13px; margin-bottom: 12px; }
.feedback-content { white-space: pre-wrap; line-height: 1.7; max-height: 220px; overflow: auto; }
.detail-form { margin-top: 20px; }
</style>

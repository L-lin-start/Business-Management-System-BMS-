<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

type DepartmentOption = { id: string; name: string; code: string; parentId: string | null };
const props = defineProps<{ token: string }>();
const loading = ref(false);
const saving = ref(false);
const departments = ref<DepartmentOption[]>([]);
const departmentIds = ref<string[]>([]);

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}`, ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? '请求失败');
  return payload as T;
}

async function loadConfig() {
  loading.value = true;
  try {
    const result = await request<{ departments: DepartmentOption[]; departmentIds: string[] }>('/api/admin/feedback-routing');
    departments.value = result.departments;
    departmentIds.value = result.departmentIds;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '反馈接收配置加载失败');
  } finally {
    loading.value = false;
  }
}

async function saveConfig() {
  saving.value = true;
  try {
    await request('/api/admin/feedback-routing', { method: 'POST', body: JSON.stringify({ departmentIds: departmentIds.value }) });
    ElMessage.success(departmentIds.value.length ? '反馈接收部门已保存' : '已清空反馈接收部门');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '反馈接收配置保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(loadConfig);
</script>

<template>
  <el-card v-loading="loading" shadow="never" class="content-card">
    <template #header>
      <div class="card-header"><span>反馈接收配置</span><el-button size="small" type="primary" :loading="saving" @click="saveConfig">保存</el-button></div>
    </template>
    <el-alert type="info" :closable="false" show-icon title="所有登录用户都能提交意见反馈；选中部门的有效成员可以进入处理队列。建议选择技术部，也可以同时选择多个部门。系统管理员始终可以查看和配置。" />
    <el-form label-position="top" class="routing-form">
      <el-form-item label="反馈接收部门">
        <el-select v-model="departmentIds" multiple clearable filterable style="width: 100%" placeholder="请选择负责处理反馈的部门">
          <el-option v-for="item in departments" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <span class="field-hint">部门成员还必须拥有“处理反馈”权限；只配置部门但没有权限的用户不能查看反馈内容。</span>
      </el-form-item>
    </el-form>
    <el-empty v-if="departments.length === 0" description="暂无启用部门，请先在组织架构中创建部门" />
  </el-card>
</template>

<style scoped>
.routing-form { margin-top: 18px; max-width: 680px; }
</style>

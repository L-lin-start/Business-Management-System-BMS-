<script setup lang="ts">
/**
 * 导出配置（PRD 5.10「导出模板、导出字段、导出格式可配」）。
 *
 * 按模块配置两件事：
 *   - 导出格式：CSV / Excel(xlsx)
 *   - 导出字段：勾选哪些列（顺序固定按系统定义，管理员改不了顺序，避免误操作）
 *
 * 配置存后端 `SystemConfig`，因此刷新/重启都不丢；保存即生效（下次导出就用新配置）。
 */
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

type FieldDef = { key: string; header: string; default?: boolean };
type ModuleConfig = {
  module: string;
  label: string;
  available: FieldDef[];
  config: { format: 'csv' | 'xlsx'; fields: string[] };
};

const props = defineProps<{ token: string }>();

const loading = ref(false);
const saving = ref(false);
const modules = ref<ModuleConfig[]>([]);
/** 当前编辑的模块（本地草稿，保存前不落库） */
const drafts = ref<Record<string, { format: 'csv' | 'xlsx'; fields: string[] }>>({});

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}`, ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? `请求失败（HTTP ${response.status}）`);
  return payload as T;
}

async function load() {
  loading.value = true;
  try {
    const data = await request<ModuleConfig[]>('/api/admin/export-configs');
    modules.value = data;
    // 复制一份草稿，编辑期间不直接改服务端数据
    drafts.value = Object.fromEntries(data.map((item) => [item.module, { format: item.config.format, fields: [...item.config.fields] }]));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '导出配置加载失败');
  } finally {
    loading.value = false;
  }
}

/** 勾选/取消一个导出字段 */
function toggleField(moduleKey: string, fieldKey: string, checked: boolean) {
  const draft = drafts.value[moduleKey];
  if (!draft) return;
  draft.fields = checked ? [...draft.fields, fieldKey] : draft.fields.filter((key) => key !== fieldKey);
}

async function save(moduleKey: string) {
  const draft = drafts.value[moduleKey];
  if (!draft) return;
  if (draft.fields.length === 0) {
    // 后端对空字段会回退默认，这里先提醒，避免"以为配了空表"却导出全部字段的困惑
    ElMessage.warning('请至少勾选一个导出字段');
    return;
  }
  saving.value = true;
  try {
    const result = await request<{ format: string; fields: string[] }>(`/api/admin/export-configs/${moduleKey}`, {
      method: 'PUT',
      body: JSON.stringify({ format: draft.format, fields: draft.fields }),
    });
    // 用后端返回值回写，确保界面与真实存储一致（后端会规整非法值）
    drafts.value[moduleKey] = { format: result.format as 'csv' | 'xlsx', fields: [...result.fields] };
    ElMessage.success('导出配置已保存');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <el-card v-loading="loading" shadow="never" class="content-card">
    <template #header>
      <div class="card-header">
        <span>导出配置</span>
        <span class="field-hint">按模块配置导出格式与导出字段；保存后立即对「导出」按钮生效。</span>
      </div>
    </template>

    <el-collapse v-if="modules.length > 0">
      <el-collapse-item v-for="item in modules" :key="item.module" :name="item.module">
        <template #title>
          <span class="export-title">
            {{ item.label }}
            <el-tag size="small" type="info">{{ item.config.format === 'xlsx' ? 'Excel' : 'CSV' }}</el-tag>
            <el-tag size="small">已选 {{ item.config.fields.length }} / {{ item.available.length }} 个字段</el-tag>
          </span>
        </template>

        <div class="export-body">
          <div class="export-row">
            <span class="export-label">导出格式</span>
            <el-radio-group v-model="drafts[item.module]!.format">
              <el-radio value="csv">CSV（通用，Excel 可直接打开）</el-radio>
              <el-radio value="xlsx">Excel（.xlsx，文件更规范）</el-radio>
            </el-radio-group>
          </div>

          <div class="export-row">
            <span class="export-label">导出字段</span>
            <el-checkbox-group
              :model-value="drafts[item.module]!.fields"
              @update:model-value="(value: unknown) => (drafts[item.module]!.fields = (value as string[]))"
            >
              <el-checkbox v-for="field in item.available" :key="field.key" :value="field.key">
                {{ field.header }}
              </el-checkbox>
            </el-checkbox-group>
          </div>

          <div class="export-actions">
            <el-button type="primary" :loading="saving" @click="save(item.module)">保存</el-button>
            <el-button @click="load">重新加载</el-button>
            <span class="field-hint">字段顺序按系统定义固定；取消勾选的字段不会出现在导出文件里。</span>
          </div>
        </div>
      </el-collapse-item>
    </el-collapse>
    <el-empty v-else-if="!loading" description="暂无可配置的导出模块" />
  </el-card>
</template>

<style scoped>
.export-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.export-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 8px 8px;
}

.export-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.export-label {
  width: 76px;
  padding-top: 4px;
  color: #5b6b83;
  font-size: 13px;
  flex: none;
}

.export-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.field-hint {
  color: #8b99ad;
  font-size: 12px;
}
</style>

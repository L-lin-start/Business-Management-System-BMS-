<script setup lang="ts">
/**
 * 已删除数据（PRD 7.1 / 7.2）。
 *
 * > 管理员可查看已删除数据并恢复。
 *
 * 展示各表被软删除的记录：是什么、谁删的、为什么删、什么时候删的，
 * 并允许管理员恢复。恢复会走各业务 Service 的 `restore()`，
 * 因此合同/项目的级联作废会一并回滚。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';

type DeletedRow = {
  resourceType: string;
  resourceLabel: string;
  id: string;
  display: string;
  deletedAt: string | null;
  deleteReason: string | null;
  deletedByName: string | null;
  cascaded: boolean;
};

const props = defineProps<{ token: string }>();

const loading = ref(false);
const restoring = ref(false);
const rows = ref<DeletedRow[]>([]);
const total = ref(0);
const resourceTypes = ref<Record<string, string>>({});
const query = reactive({ resourceType: '', keyword: '', page: 1, pageSize: 50 });

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
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
    if (query.resourceType) params.set('resourceType', query.resourceType);
    if (query.keyword.trim()) params.set('keyword', query.keyword.trim());
    const data = await request<{ items: DeletedRow[]; total: number; resourceTypes: Record<string, string> }>(
      `/api/admin/deleted-records?${params.toString()}`,
    );
    rows.value = data.items;
    total.value = data.total;
    resourceTypes.value = data.resourceTypes;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '已删除数据加载失败');
  } finally {
    loading.value = false;
  }
}

function handleSearch() {
  query.page = 1;
  void load();
}

async function restore(row: DeletedRow) {
  restoring.value = true;
  try {
    await request(`/api/admin/deleted-records/${row.resourceType}/${row.id}/restore`, {
      method: 'POST',
      body: JSON.stringify({ reason: '管理员在已删除数据中恢复' }),
    });
    ElMessage.success(`已恢复${row.resourceLabel}「${row.display}」，其下因级联而作废的子记录也会一并恢复`);
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '恢复失败');
  } finally {
    restoring.value = false;
  }
}

function formatTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <el-card v-loading="loading" shadow="never" class="content-card">
    <template #header>
      <div class="card-header">
        <span>已删除数据</span>
        <span class="field-hint">
          所有删除都是软删除，数据保留在此。恢复合同/项目时，因级联而作废的官文、动作记录等会一并恢复。
        </span>
      </div>
    </template>

    <div class="filter-row">
      <el-select v-model="query.resourceType" clearable placeholder="数据类型" style="width: 160px" @change="handleSearch">
        <el-option v-for="(label, key) in resourceTypes" :key="key" :label="label" :value="key" />
      </el-select>
      <el-input
        v-model="query.keyword"
        clearable
        placeholder="搜索编号或名称"
        style="width: 240px"
        @keyup.enter="handleSearch"
      />
      <el-button @click="handleSearch">查询</el-button>
      <el-button text @click="query.keyword = ''; query.resourceType = ''; handleSearch()">重置</el-button>
      <span class="field-hint">共 {{ total }} 条已删除记录</span>
    </div>

    <el-table :data="rows" stripe empty-text="暂无已删除数据">
      <el-table-column label="类型" width="110">
        <template #default="scope">
          <el-tag size="small" type="info">{{ scope.row.resourceLabel }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="对象" min-width="240" show-overflow-tooltip>
        <template #default="scope">
          <span>{{ scope.row.display }}</span>
          <el-tag v-if="scope.row.cascaded" size="small" type="warning" class="cascade-tag">随父级作废</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="删除原因" min-width="220" show-overflow-tooltip>
        <template #default="scope">
          <span v-if="scope.row.deleteReason">{{ scope.row.deleteReason }}</span>
          <span v-else class="sub-text">未记录（旧数据）</span>
        </template>
      </el-table-column>
      <el-table-column label="删除人" width="120">
        <template #default="scope">
          <span v-if="scope.row.deletedByName">{{ scope.row.deletedByName }}</span>
          <span v-else class="sub-text">—</span>
        </template>
      </el-table-column>
      <el-table-column label="删除时间" width="150">
        <template #default="scope">{{ formatTime(scope.row.deletedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="scope">
          <el-button link type="primary" :loading="restoring" @click="restore(scope.row)">恢复</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.cascade-tag {
  margin-left: 8px;
}

.sub-text {
  color: #a9b4c4;
  font-size: 12px;
}

.field-hint {
  color: #8b99ad;
  font-size: 12px;
}
</style>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';

type CustomFieldDefinition = {
  fieldKey: string;
  label: string;
  fieldType: string;
  isListVisible: boolean;
  sortOrder: number;
  config: { options?: string[] } | null;
};

const props = defineProps<{
  token: string;
  moduleKey: string;
  rows: Array<Record<string, unknown>>;
}>();
const emit = defineEmits<{ loaded: [definitions: CustomFieldDefinition[]] }>();

const columns = ref<CustomFieldDefinition[]>([]);

async function loadFields() {
  try {
    const response = await fetch(`/api/options/fields/${props.moduleKey}`, {
      headers: { Authorization: `Bearer ${props.token}` },
    });
    if (!response.ok) throw new Error('字段定义加载失败');
    const definitions = (await response.json()) as CustomFieldDefinition[];
    columns.value = definitions.filter((item) => item.isListVisible);
    emit('loaded', definitions);
  } catch {
    columns.value = [];
  }
}

function cellValue(row: Record<string, unknown>, key: string) {
  const custom = row.customFields as Record<string, unknown> | null | undefined;
  const value = custom?.[key];
  if (value === undefined || value === null || value === '') return '-';
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '-';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

onMounted(loadFields);
watch(() => props.moduleKey, loadFields);
</script>

<template>
  <el-table-column
    v-for="column in columns"
    :key="column.fieldKey"
    :label="column.label"
    :min-width="column.fieldType === 'DATE' ? 120 : 140"
  >
    <template #default="scope">{{ cellValue(scope.row as Record<string, unknown>, column.fieldKey) }}</template>
  </el-table-column>
</template>

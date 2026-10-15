<script setup lang="ts">
import { onMounted, reactive, watch } from 'vue';

export type CustomFieldDefinition = {
  fieldKey: string;
  label: string;
  fieldType: string;
  isRequired: boolean;
  isListVisible: boolean;
  isSearchable: boolean;
  sortOrder: number;
  config: { options?: string[]; defaultValue?: unknown } | null;
};

const props = defineProps<{
  token: string;
  moduleKey: string;
  modelValue: Record<string, unknown>;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>();

const fields = reactive<CustomFieldDefinition[]>([]);

function applyDefaults(definitions: CustomFieldDefinition[], incoming: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...incoming };
  for (const field of definitions) {
    if (next[field.fieldKey] !== undefined && next[field.fieldKey] !== null) continue;
    if (field.config?.defaultValue !== undefined) next[field.fieldKey] = field.config.defaultValue;
    else if (field.fieldType === 'MULTI_SELECT') next[field.fieldKey] = [];
  }
  return next;
}

async function loadFields() {
  try {
    const response = await fetch(`/api/options/fields/${props.moduleKey}`, {
      headers: { Authorization: `Bearer ${props.token}` },
    });
    if (!response.ok) throw new Error('字段定义加载失败');
    const definitions = (await response.json()) as CustomFieldDefinition[];
    fields.splice(0, fields.length, ...definitions);
    emit('update:modelValue', applyDefaults(definitions, props.modelValue));
  } catch {
    fields.splice(0, fields.length);
  }
}

function updateValue(key: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

onMounted(loadFields);
watch(() => props.moduleKey, loadFields);
</script>

<template>
  <template v-for="field in fields" :key="field.fieldKey">
    <el-form-item :label="field.label" :required="field.isRequired">
      <el-input
        v-if="field.fieldType === 'TEXT'"
        :model-value="(modelValue[field.fieldKey] as string) ?? ''"
        :placeholder="`请输入${field.label}`"
        @update:model-value="updateValue(field.fieldKey, $event)"
      />
      <span v-else-if="field.fieldType === 'ATTACHMENT'" class="field-hint">请在页面的附件区域上传文件</span>
      <el-input
        v-else-if="field.fieldType === 'NUMBER'"
        :model-value="(modelValue[field.fieldKey] as number | string) ?? ''"
        type="number"
        :placeholder="`请输入${field.label}`"
        @update:model-value="updateValue(field.fieldKey, $event)"
      />
      <el-date-picker
        v-else-if="field.fieldType === 'DATE'"
        :model-value="(modelValue[field.fieldKey] as string) ?? ''"
        type="date"
        value-format="YYYY-MM-DD"
        :placeholder="`选择${field.label}`"
        style="width: 100%"
        @update:model-value="updateValue(field.fieldKey, $event)"
      />
      <el-select
        v-else-if="field.fieldType === 'SELECT'"
        :model-value="(modelValue[field.fieldKey] as string) ?? ''"
        clearable
        :placeholder="`请选择${field.label}`"
        style="width: 100%"
        @update:model-value="updateValue(field.fieldKey, $event)"
      >
        <el-option v-for="option in field.config?.options ?? []" :key="option" :label="option" :value="option" />
      </el-select>
      <el-select
        v-else-if="field.fieldType === 'MULTI_SELECT'"
        :model-value="(modelValue[field.fieldKey] as string[]) ?? []"
        multiple
        clearable
        :placeholder="`请选择${field.label}`"
        style="width: 100%"
        @update:model-value="updateValue(field.fieldKey, $event)"
      >
        <el-option v-for="option in field.config?.options ?? []" :key="option" :label="option" :value="option" />
      </el-select>
      <el-switch
        v-else-if="field.fieldType === 'BOOLEAN'"
        :model-value="Boolean(modelValue[field.fieldKey])"
        @update:model-value="updateValue(field.fieldKey, $event)"
      />
      <!-- RELATION / USER 需要额外的数据源，暂按文本录入 -->
      <el-input
        v-else
        :model-value="(modelValue[field.fieldKey] as string) ?? ''"
        :placeholder="`请输入${field.label}（暂按文本录入）`"
        @update:model-value="updateValue(field.fieldKey, $event)"
      />
    </el-form-item>
  </template>
</template>

<style scoped>
.field-hint {
  color: #909399;
  font-size: 13px;
}
</style>

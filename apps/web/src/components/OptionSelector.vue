<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';

type OptionItem = { code: string; label: string };

/**
 * 通用受控选项选择器（附属业务数据用）。
 *
 * 与 `TypeSelector.vue` 的区别：那个只服务合同类型/项目类型（带业务时限等专属逻辑），
 * 这里只做「从系统 B 的选项配置里选一个值」，覆盖官文类型、官文来源、送达状态、
 * 申报结果、动作类型这些附属模块，避免每加一个下拉就复制一份加载逻辑。
 *
 * 取值约定：**存编码、显示中文标签**（与合同类型一致）。
 * 已停用的选项不在列表中，但历史值仍能正确回显（补一条"历史值"避免露出内部编码）。
 */
const props = defineProps<{
  token: string;
  /** 选项模块，对应 StatusDefinition.moduleKey */
  moduleKey: string;
  modelValue: string;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  /** 是否允许自由输入（动作类型未配置任何选项时用）
   *  true 时用 allow-create，用户可直接输入新值 */
  allowCreate?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const options = ref<OptionItem[]>([]);
const loading = ref(false);

async function loadOptions() {
  loading.value = true;
  try {
    const response = await fetch(`/api/options/list/${props.moduleKey}`, {
      headers: { Authorization: `Bearer ${props.token}` },
    });
    if (!response.ok) throw new Error('加载失败');
    options.value = (await response.json()) as OptionItem[];
  } catch {
    options.value = [];
  } finally {
    loading.value = false;
  }
}

/** 历史数据可能用了已停用的选项：补一条占位，避免页面显示成内部编码。 */
function ensureCurrentVisible() {
  if (!props.modelValue) return;
  if (options.value.some((item) => item.code === props.modelValue)) return;
  options.value = [...options.value, { code: props.modelValue, label: `${props.modelValue}（历史值）` }];
}

/** 把编码翻成中文标签供表格展示 */
function labelOf(code: string | null | undefined): string {
  if (!code) return '-';
  return options.value.find((item) => item.code === code)?.label ?? code;
}

defineExpose({ labelOf, reload: loadOptions });

function handleChange(value: string) {
  emit('update:modelValue', value ?? '');
}

onMounted(async () => {
  await loadOptions();
  ensureCurrentVisible();
});

watch(() => props.modelValue, ensureCurrentVisible);
watch(
  () => props.moduleKey,
  async () => {
    await loadOptions();
    ensureCurrentVisible();
  },
);
</script>

<template>
  <el-select
    :model-value="modelValue"
    :placeholder="placeholder ?? '请选择'"
    :clearable="clearable ?? true"
    :disabled="disabled"
    :loading="loading"
    :allow-create="allowCreate"
    filterable
    default-first-option
    style="width: 100%"
    @update:model-value="handleChange"
  >
    <el-option v-for="item in options" :key="item.code" :label="item.label" :value="item.code" />
    <template #empty>
      <div class="option-empty">
        <span>暂无可选项</span>
        <small>请到「管理系统 → 选项配置」中添加</small>
      </div>
    </template>
  </el-select>
</template>

<style scoped>
.option-empty {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 14px;
  color: #8b99ad;
  font-size: 13px;
  text-align: center;
}

.option-empty small {
  color: #a9b4c4;
  font-size: 12px;
}
</style>

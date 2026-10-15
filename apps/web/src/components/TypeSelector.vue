<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';

type OptionItem = { code: string; label: string };

/**
 * 合同类型 / 项目类型选择器。
 * 取值来自系统 B 的选项配置，只能选不能填，避免同一类业务被写成多个名字
 * （否则流程匹配、筛选与统计口径都会乱）。已停用的选项不在列表中，但历史值仍能正确回显。
 */
const props = defineProps<{
  token: string;
  /** 选项模块：contractType（合同类型）/ projectType（项目类型） */
  moduleKey: 'contractType' | 'projectType';
  modelValue: string;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
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

/**
 * 保证当前值在下拉里有一项可匹配，否则 el-select 会直接露出原始字符串。
 *
 * 两类历史值都要兜住：
 *   - 已停用的选项（该类型从选项配置里删了）
 *   - **历史上存成中文标签的值**（早期项目类型存的是「商标」而不是编码）
 *
 * 补的项必须 `code = 当前值`：下拉的 value 现在是 code，
 * 否则选中后回显不出这一项。label 也用原值，这样历史中文标签仍显示中文。
 */
function ensureCurrentVisible() {
  if (!props.modelValue) return;
  if (options.value.some((item) => item.label === props.modelValue || item.code === props.modelValue)) return;
  options.value = [...options.value, { code: props.modelValue, label: props.modelValue }];
}

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
    filterable
    style="width: 100%"
    @update:model-value="handleChange"
  >
    <!--
      `:value` 必须是 **code**，不能是 label。
      系统的口径是「存编码、显示标签」：后端 `assertOptionAllowed()` 返回 `matched.code`，
      数据库里存的也是编码（例如商标 = TRADEMARK）。
      这里以前用 label 当 value，于是「模型值 TRADEMARK」匹配不上「选项值 商标」，
      编辑弹窗就直接把内部编码 TRADEMARK 显示出来（用户反馈的问题）。
    -->
    <el-option v-for="item in options" :key="item.code" :label="item.label" :value="item.code" />
    <template #empty>
      <div class="type-empty">
        <span>暂无可选类型</span>
        <small>请到「管理系统 → 选项配置」中添加</small>
      </div>
    </template>
  </el-select>
</template>

<style scoped>
.type-empty {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 14px;
  color: #8b99ad;
  font-size: 13px;
  text-align: center;
}

.type-empty small {
  color: #a9b4c4;
  font-size: 12px;
}
</style>

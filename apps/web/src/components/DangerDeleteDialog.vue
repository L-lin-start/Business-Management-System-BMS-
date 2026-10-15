<script setup lang="ts">
/**
 * 高危删除确认弹窗（PRD 7.2）。
 *
 * > 删除时弹高危操作提示，必须勾选"我已知晓风险"。
 * > 必须填写删除原因，不允许为空。
 *
 * 抽成独立组件而不是每处写一遍 `ElMessageBox`：现在有 5 处删除入口
 * （合同/项目/客户/回款/成本），弹窗里的校验规则必须完全一致 ——
 * 分散实现迟早会出现"这一处忘了必填原因"。
 *
 * 校验在**前端与后端各做一次**：前端拦截是为了体验，后端才是真正的关口
 * （防止绕过界面直接调接口）。
 */
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  modelValue: boolean;
  /** 弹窗标题，如「删除合同」 */
  title: string;
  /** 说明这一条是什么，如「合同 HT-2026-001」 */
  target: string;
  /** 删除会产生什么后果（各实体不同，由调用方给出） */
  consequences?: string;
  loading?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [reason: string];
}>();

const reason = ref('');
const acknowledged = ref(false);
const touched = ref(false);

// 每次打开重置，避免上一次的输入残留（尤其是勾选状态 —— 残留会导致"没勾也能删"）
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      reason.value = '';
      acknowledged.value = false;
      touched.value = false;
    }
  },
);

const reasonError = computed(() => (touched.value && reason.value.trim().length === 0 ? '请填写删除原因' : ''));
const canSubmit = computed(() => reason.value.trim().length > 0 && acknowledged.value && !props.loading);

function close() {
  emit('update:modelValue', false);
}

function submit() {
  touched.value = true;
  if (!canSubmit.value) return;
  emit('confirm', reason.value.trim());
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="props.title"
    width="520px"
    :close-on-click-modal="false"
    @update:model-value="(value: boolean) => emit('update:modelValue', value)"
  >
    <el-alert type="error" :closable="false" show-icon class="danger-alert">
      <template #title>这是高危操作</template>
      <div class="danger-body">
        <p>即将删除：<strong>{{ props.target }}</strong></p>
        <p v-if="props.consequences">{{ props.consequences }}</p>
        <p>删除后数据会标记为「已删除」，不再出现在列表与统计中；管理员可在「已删除数据」中恢复。</p>
      </div>
    </el-alert>

    <el-form label-position="top" class="danger-form">
      <el-form-item label="删除原因（必填）" :error="reasonError" required>
        <el-input
          v-model="reason"
          type="textarea"
          :rows="3"
          maxlength="200"
          show-word-limit
          placeholder="请说明为什么删除，例如：录入错误、客户取消合作"
          @blur="touched = true"
        />
      </el-form-item>
      <el-form-item>
        <el-checkbox v-model="acknowledged">我已知晓风险</el-checkbox>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="danger" :disabled="!canSubmit" :loading="props.loading" @click="submit">确认删除</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.danger-alert {
  margin-bottom: 16px;
}

.danger-body p {
  margin: 4px 0;
  line-height: 1.7;
}

.danger-form {
  margin-top: 4px;
}
</style>

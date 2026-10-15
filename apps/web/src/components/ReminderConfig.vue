<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';

type ConfigItem = {
  name: string;
  key: string;
  label: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
};

const props = defineProps<{ token: string }>();

const loading = ref(false);
const saving = ref(false);
const items = ref<ConfigItem[]>([]);
const form = reactive<Record<string, number>>({});

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
    items.value = await request<ConfigItem[]>('/api/admin/reminder-config');
    for (const item of items.value) form[item.name] = item.value;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '提醒配置加载失败');
  } finally {
    loading.value = false;
  }
}

async function saveConfig() {
  saving.value = true;
  try {
    const payload = Object.fromEntries(Object.entries(form));
    items.value = await request<ConfigItem[]>('/api/admin/reminder-config', { method: 'POST', body: JSON.stringify(payload) });
    for (const item of items.value) form[item.name] = item.value;
    ElMessage.success('提醒参数已保存，立即生效');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

/** 立即触发一次扫描，验证参数效果 */
async function scanNow() {
  saving.value = true;
  try {
    const result = await request<{ created: number; refreshed: number; cleaned: number; unhandled: number }>('/api/reminders/scan', {
      method: 'POST',
    });
    ElMessage.success(`扫描完成：新增 ${result.created} 条，更新 ${result.refreshed} 条，清理 ${result.cleaned} 条，当前未处理 ${result.unhandled} 条`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '扫描失败');
  } finally {
    saving.value = false;
  }
}

onMounted(loadConfig);
</script>

<template>
  <el-card v-loading="loading" shadow="never" class="content-card">
    <template #header>
      <div class="card-header">
        <span>提醒配置</span>
        <div class="header-actions">
          <el-button size="small" :loading="saving" @click="scanNow">立即扫描一次</el-button>
          <el-button size="small" type="primary" :loading="saving" @click="saveConfig">保存</el-button>
        </div>
      </div>
    </template>

    <el-form label-position="top" class="config-form">
      <el-row :gutter="20">
        <el-col v-for="item in items" :key="item.name" :xs="24" :sm="12">
          <el-form-item :label="item.label">
            <el-input-number v-model="form[item.name]" :min="item.min" :max="item.max" style="width: 100%" />
            <span class="field-hint">
              取值范围 {{ item.min }}–{{ item.max }}，默认 {{ item.defaultValue }}
              <template v-if="item.name === 'scanIntervalMinutes'">；填 0 表示关闭自动扫描（仍可手动扫描）</template>
              <template v-if="item.name === 'retentionDays'">；已处理的提醒超过该天数后自动清理</template>
              <!-- 注意：这里的 `**` 不是 Markdown，会被原样显示成星号，所以文案里不要写它 -->
              <template v-if="item.name === 'safetyMarginDays'">；合同未填内部安全日时按此天数从法定截止日倒推，「系统算建议截止日」用的是同一个值（改这里两处同时生效）</template>
              <template v-if="item.name.startsWith('tier')">；剩余天数 ≤ 该值时升级预警档位</template>
              <template v-if="item.name === 'paymentGraceDays'">；项目全部走完后多少天开始提醒待回款（合同完成条件：项目全部走完 + 钱全部到账）</template>
            </span>
          </el-form-item>
        </el-col>
      </el-row>
    </el-form>

    <el-alert type="info" :closable="false" show-icon
      title="提醒来源：合同法定截止日/到期日、按安全天数推算的内部安全日、项目当前节点按节点时限计算的超期、以及项目全部走完但款未收齐的待回款合同。提醒进入「提前提醒天数」窗口后生成，重复扫描不会产生重复提醒；分级预警按剩余天数自动升级档位。" />
    <el-alert type="success" :closable="false" show-icon class="config-note"
      title="「内部安全日提前天数」同时用于合同表单里的「系统算建议截止日」：系统按签约日 + 业务类型时限推算建议法定截止日，再按本值倒推建议内部安全日。业务类型的时限天数在「选项配置」中维护。" />
  </el-card>
</template>

<style scoped>
.header-actions {
  display: flex;
  gap: 8px;
}

.config-form {
  margin-top: 4px;
}
</style>


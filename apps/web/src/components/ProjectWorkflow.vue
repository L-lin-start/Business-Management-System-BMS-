<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

/** 节点负责人的可读信息，由服务端解析（角色名 + 在职人名） */
type NodeAssignee = {
  assigneeType: string | null;
  assigneeId: string | null;
  roleName: string | null;
  userNames: string[];
  activeUserCount: number;
  label: string;
  /** true = 没配负责人或角色下无人在职，界面需要提醒 */
  unassigned: boolean;
};
type WorkflowNode = {
  code: string;
  name: string;
  sequence: number;
  assigneeType: string | null;
  assigneeId: string | null;
  assignee?: NodeAssignee | null;
  deadlineDays: number | null;
  warningDays: number | null;
  statisticsCode: string;
};
type WorkflowContext = {
  bound: boolean;
  version: { id: string; version: number; status?: string; templateName: string } | null;
  currentNode: WorkflowNode | null;
  nextNode: WorkflowNode | null;
  nodes: WorkflowNode[];
  /** 当前登录人能否推进当前节点；false 时禁用按钮 */
  canTransition?: boolean;
  transitionBlockedReason?: string | null;
};

const props = defineProps<{
  token: string;
  projectId: string;
  /** 来自项目详情的流程上下文，作为初始值，避免重复请求 */
  initial?: WorkflowContext | null;
}>();
const emit = defineEmits<{ changed: [] }>();

const workflow = ref<WorkflowContext | null>(props.initial ?? null);
const loading = ref(false);
const transitioning = ref(false);

const nodeStatus = computed(() => {
  if (!workflow.value?.bound) return 'info';
  if (!workflow.value.currentNode) return 'warning';
  if (workflow.value.currentNode.statisticsCode === 'COMPLETED') return 'success';
  if (workflow.value.currentNode.statisticsCode === 'EXCEPTION') return 'danger';
  return 'primary';
});

const isFinished = computed(() => Boolean(workflow.value?.bound) && !workflow.value?.nextNode && Boolean(workflow.value?.currentNode));

/** 能否推进：服务端下发的判定；旧响应没有该字段时按允许处理，保持向后兼容 */
const canTransition = computed(() => workflow.value?.canTransition !== false);
const blockedReason = computed(() => workflow.value?.transitionBlockedReason ?? '');
/** 当前节点的负责人展示文案 */
const currentAssigneeLabel = computed(() => workflow.value?.currentNode?.assignee?.label ?? '未指定负责人');
/** 当前节点没配负责人时的提醒 */
const currentUnassigned = computed(() => workflow.value?.currentNode?.assignee?.unassigned === true);

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}`, ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? '请求失败');
  return payload as T;
}

async function loadWorkflow() {
  if (!props.projectId) return;
  loading.value = true;
  try {
    workflow.value = await request<WorkflowContext>(`/api/projects/${props.projectId}/transitions`);
  } catch {
    workflow.value = null;
  } finally {
    loading.value = false;
  }
}

/** 推进到下一个节点；原因必填，便于流转记录可追溯 */
async function advance() {
  const next = workflow.value?.nextNode;
  if (!next) {
    ElMessage.info('已经是最后一个节点');
    return;
  }

  let reason = '';
  try {
    const result = await ElMessageBox.prompt(
      `确认从「${workflow.value?.currentNode?.name ?? '未开始'}」推进到「${next.name}」？请填写推进原因，会记入流转记录。`,
      '推进流程节点',
      {
        confirmButtonText: '确认推进',
        cancelButtonText: '取消',
        inputPlaceholder: `例如：${next.name}所需材料已齐备`,
        inputValidator: (value: string) => (value && value.trim().length > 0 ? true : '请填写推进原因'),
      },
    );
    reason = result.value.trim();
  } catch {
    return;
  }

  transitioning.value = true;
  try {
    await request(`/api/projects/${props.projectId}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ toNodeCode: next.code, reason }),
    });
    ElMessage.success(`已推进到「${next.name}」`);
    await loadWorkflow();
    emit('changed');
  } catch (error) {
    const message = error instanceof Error ? error.message : '推进失败';
    if (message.includes('已被他人更新')) {
      ElMessage.warning('该项目已被他人更新，已为你重新加载最新流程状态，请确认后再推进');
      await loadWorkflow();
      emit('changed');
    } else {
      ElMessage.error(message);
    }
  } finally {
    transitioning.value = false;
  }
}

onMounted(() => {
  if (!props.initial) void loadWorkflow();
});
watch(() => props.projectId, () => void loadWorkflow());
watch(
  () => props.initial,
  (value) => {
    if (value) workflow.value = value;
  },
);
</script>

<template>
  <el-card v-loading="loading" shadow="never" class="workflow-card">
    <template #header>
      <div class="card-header">
        <span>流程节点</span>
        <span v-if="workflow?.bound" class="workflow-version">
          {{ workflow.version?.templateName }} · v{{ workflow.version?.version }}
        </span>
        <el-tag v-else type="info" size="small">未绑定流程</el-tag>
      </div>
    </template>

    <template v-if="workflow?.bound">
      <div class="workflow-current">
        <div class="workflow-current-info">
          <span class="workflow-label">当前节点</span>
          <el-tag :type="nodeStatus" effect="dark" size="large">
            {{ workflow.currentNode?.name ?? '尚未进入任何节点' }}
          </el-tag>
          <span v-if="workflow.currentNode?.deadlineDays" class="workflow-hint">
            该节点时限 {{ workflow.currentNode.deadlineDays }} 天
          </span>
          <span class="workflow-label workflow-label-inline">负责人</span>
          <el-tag :type="currentUnassigned ? 'warning' : 'info'" effect="plain" size="small">
            {{ currentAssigneeLabel }}
          </el-tag>
        </div>
        <div class="workflow-action">
          <el-tooltip v-if="!canTransition" :content="blockedReason" placement="top">
            <span>
              <el-button v-if="!isFinished && workflow.nextNode" type="primary" disabled>
                推进到「{{ workflow.nextNode.name }}」
              </el-button>
            </span>
          </el-tooltip>
          <el-button
            v-else-if="!isFinished && workflow.nextNode"
            type="primary"
            :loading="transitioning"
            @click="advance"
          >
            推进到「{{ workflow.nextNode.name }}」
          </el-button>
          <el-tag v-else-if="isFinished" type="success" effect="plain">流程已走完</el-tag>
          <el-button v-else type="primary" :loading="transitioning" @click="advance">开始流程（进入「{{ workflow.nextNode?.name }}」）</el-button>
        </div>
      </div>

      <el-alert
        v-if="!canTransition && blockedReason"
        type="warning"
        :closable="false"
        show-icon
        class="workflow-blocked"
        :title="blockedReason"
      />

      <div class="workflow-steps">
        <div
          v-for="node in workflow.nodes"
          :key="node.code"
          class="workflow-step"
          :class="{
            'is-current': node.code === workflow.currentNode?.code,
            'is-done': workflow.currentNode ? node.sequence < workflow.currentNode.sequence : false,
          }"
        >
          <span class="workflow-step-index">{{ node.sequence }}</span>
          <span class="workflow-step-name">{{ node.name }}</span>
          <span class="workflow-step-assignee" :class="{ 'is-unassigned': node.assignee?.unassigned }">
            {{ node.assignee?.unassigned ? '未指定负责人' : (node.assignee?.label ?? '') }}
          </span>
        </div>
      </div>
      <p class="tab-hint">
        本项目按项目类型「{{ workflow.version?.templateName }}」匹配流程。每个节点由各自的负责人推进，
        节点负责人按角色在系统 B 配置；项目负责人在此可以看到全流程进度与每一步归谁办。
        推进后项目状态会按节点自动同步，并记入「流转记录」。
      </p>
    </template>

    <el-empty v-else description="该项目尚未绑定流程，请在系统 B 配置流程模板后重新创建项目" />
  </el-card>
</template>

<style scoped>
.workflow-card {
  margin-bottom: 18px;
}

.workflow-version {
  margin-left: auto;
  color: #8b99ad;
  font-size: 12px;
  font-weight: 400;
}

.workflow-current {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 4px 0 16px;
}

.workflow-current-info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.workflow-label {
  color: #5b6b85;
  font-size: 13px;
}

.workflow-label-inline {
  margin-left: 8px;
}

.workflow-blocked {
  margin-bottom: 12px;
}

/* 节点上的"归谁办"小字：让项目负责人一眼看到每一步的负责人 */
.workflow-step-assignee {
  padding-left: 8px;
  border-left: 1px solid #e4e9f2;
  color: #909399;
  font-size: 12px;
  white-space: nowrap;
}

.workflow-step-assignee.is-unassigned {
  color: #e6a23c;
}

.workflow-hint {
  color: #8b99ad;
  font-size: 12px;
}

.workflow-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px dashed #e4e9f2;
}

.workflow-step {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 4px 6px;
  border: 1px solid #e4e9f2;
  border-radius: 999px;
  background: #fff;
  color: #8b99ad;
  font-size: 13px;
}

.workflow-step-index {
  display: inline-block;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #eef2f8;
  color: #7b8aa3;
  font-size: 12px;
  line-height: 20px;
  text-align: center;
}

.workflow-step.is-done {
  border-color: #cfe0d8;
  color: #4b7d68;
}

.workflow-step.is-done .workflow-step-index {
  background: #e3f1ea;
  color: #15803d;
}

.workflow-step.is-current {
  border-color: #bcd0f0;
  background: #f2f7ff;
  color: #1d4ed8;
  font-weight: 600;
}

.workflow-step.is-current .workflow-step-index {
  background: #1d4ed8;
  color: #fff;
}
</style>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

type WorkflowNode = {
  id: string;
  code: string;
  name: string;
  nodeType: string;
  sequence: number;
  assigneeType: string | null;
  assigneeId: string | null;
  deadlineDays: number | null;
  warningDays: number | null;
  settings: { statisticsCode?: string } | null;
};
type WorkflowVersion = { id: string; version: number; status: string; publishedAt: string | null };
type WorkflowTemplate = {
  id: string;
  name: string;
  description: string | null;
  /** 预置模板（种子创建）不允许删除；用户自建的为 false */
  isSystem: boolean;
  isActive: boolean;
  versions: Array<WorkflowVersion & { _count?: { nodes: number; projects: number } }>;
};

const props = defineProps<{ token: string }>();

const templates = ref<WorkflowTemplate[]>([]);
const loading = ref(false);
const saving = ref(false);
const selectedTemplateId = ref<string>('');
const versionDetail = ref<{ id: string; version: number; status: string; template: { name: string }; nodes: WorkflowNode[]; _count?: { projects: number } } | null>(null);

const statisticsOptions = ref<Array<{ code: string; label: string }>>([]);
const roleOptions = ref<Array<{ code: string; name: string }>>([]);

const templateDialog = ref(false);
const templateForm = reactive({ name: '', description: '' });
const nodeDialog = ref(false);
const editingNodeId = ref<string | null>(null);
const nodeForm = reactive({
  name: '',
  nodeType: 'MANUAL',
  sequence: 1,
  assigneeType: 'ROLE',
  assigneeId: '',
  deadlineDays: undefined as number | undefined,
  warningDays: undefined as number | undefined,
  statisticsCode: 'IN_PROGRESS',
});

const nodeTypeOptions = [
  { label: '人工', value: 'MANUAL' },
  { label: '自动', value: 'AUTOMATIC' },
  { label: '并行', value: 'PARALLEL' },
  { label: '条件', value: 'CONDITION' },
];

const selectedTemplate = computed(() => templates.value.find((item) => item.id === selectedTemplateId.value) ?? null);
const isDraft = computed(() => versionDetail.value?.status === 'DRAFT');
const currentVersion = computed(() => {
  if (!selectedTemplate.value) return null;
  // 创建“基于当前版本的新版本”后，必须先打开草稿版本，否则页面会继续显示已发布版本，
  // 管理员看不到刚复制出来的节点，也无法新增节点。
  return selectedTemplate.value.versions.find((item) => item.status === 'DRAFT')
    ?? selectedTemplate.value.versions.find((item) => item.status === 'PUBLISHED')
    ?? selectedTemplate.value.versions[0]
    ?? null;
});

/** 切换模板：同时刷新下方节点配置（之前只改了选中项，节点表没跟着变） */
function onTemplateChange(templateId: string) {
  selectedTemplateId.value = templateId;
  void loadVersionDetail();
}

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}`, ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? '请求失败');
  return payload as T;
}

async function loadTemplates() {
  loading.value = true;
  try {
    templates.value = await request<WorkflowTemplate[]>('/api/admin/workflows/templates?moduleKey=project');
    if (!selectedTemplateId.value || !templates.value.some((item) => item.id === selectedTemplateId.value)) {
      selectedTemplateId.value = templates.value[0]?.id ?? '';
    }
    await loadVersionDetail();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '流程模板加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadVersionDetail() {
  const version = currentVersion.value;
  if (!version) {
    versionDetail.value = null;
    return;
  }
  try {
    versionDetail.value = await request(`/api/admin/workflows/versions/${version.id}`);
  } catch (error) {
    versionDetail.value = null;
    ElMessage.error(error instanceof Error ? error.message : '流程版本加载失败');
  }
}

async function loadOptions() {
  try {
    const [statuses, roles] = await Promise.all([
      request<Record<string, Array<{ code: string; label: string }>>>('/api/options/statuses'),
      request<Array<{ code: string; name: string }>>('/api/admin/roles'),
    ]);
    statisticsOptions.value = statuses.project ?? [];
    roleOptions.value = roles.map((item) => ({ code: item.code, name: item.name }));
  } catch {
    statisticsOptions.value = [];
    roleOptions.value = [];
  }
}

function statisticsLabel(code: string | undefined) {
  if (!code) return '未设置';
  return statisticsOptions.value.find((item) => item.code === code)?.label ?? '未知状态';
}

function roleLabel(code: string | null | undefined) {
  if (!code) return '未指定';
  return roleOptions.value.find((item) => item.code === code)?.name ?? '未指定角色';
}

function statusTagType(status: string) {
  if (status === 'PUBLISHED') return 'success';
  if (status === 'DRAFT') return 'warning';
  return 'info';
}

function statusLabel(status: string) {
  if (status === 'PUBLISHED') return '已发布';
  if (status === 'DRAFT') return '草稿';
  return '已锁定';
}

/* ---------------- 模板 ---------------- */

function openCreateTemplate() {
  Object.assign(templateForm, { name: '', description: '' });
  templateDialog.value = true;
}

async function saveTemplate() {
  if (!templateForm.name.trim()) {
    ElMessage.warning('请填写模板名称');
    return;
  }
  saving.value = true;
  try {
    const created = await request<WorkflowTemplate>('/api/admin/workflows/templates', {
      method: 'POST',
      body: JSON.stringify({ moduleKey: 'project', name: templateForm.name.trim(), description: templateForm.description || undefined }),
    });
    ElMessage.success(`模板「${created.name}」已创建，请新建版本并配置节点`);
    templateDialog.value = false;
    selectedTemplateId.value = created.id;
    await loadTemplates();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '模板创建失败');
  } finally {
    saving.value = false;
  }
}

/**
 * 删除流程模板（含其下版本与节点）。
 *
 * 两种情况后端会拒绝并返回原因，前端先做一次预检把提示做得更直白：
 *   - 预置模板（isSystem）不允许删除
 *   - 模板下已有项目在用，不允许删除
 */
async function removeTemplate(row?: WorkflowTemplate) {
  const template = row ?? selectedTemplate.value;
  if (!template) return;

  if (template.isSystem) {
    ElMessage.warning(`「${template.name}」是系统预置模板，不能删除。如需调整节点，请基于它新建版本。`);
    return;
  }
  const boundProjects = template.versions.reduce((sum, item) => sum + (item._count?.projects ?? 0), 0);
  if (boundProjects > 0) {
    ElMessage.warning(`「${template.name}」下已有 ${boundProjects} 个项目在使用该流程，不能删除。`);
    return;
  }
  const nodeCount = template.versions.reduce((sum, item) => sum + (item._count?.nodes ?? 0), 0);
  try {
    await ElMessageBox.confirm(
      `确定要删除流程模板「${template.name}」吗？\n` +
        `将一并删除其下 ${template.versions.length} 个版本、${nodeCount} 个节点。\n` +
        `删除后无法恢复；已绑定该流程的项目不受影响（本次已被阻止，无项目在用）。`,
      '删除流程模板',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }

  saving.value = true;
  try {
    const result = await request<{ name: string; deletedVersions: number; deletedNodes: number }>(
      `/api/admin/workflows/templates/${template.id}`,
      { method: 'DELETE' },
    );
    ElMessage.success(`模板「${result.name}」已删除（${result.deletedVersions} 个版本、${result.deletedNodes} 个节点）`);
    selectedTemplateId.value = '';
    versionDetail.value = null;
    await loadTemplates();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '模板删除失败');
  } finally {
    saving.value = false;
  }
}

/* ---------------- 版本 ---------------- */

async function createVersion(copyFrom?: string) {
  if (!selectedTemplate.value) return;
  try {
    await ElMessageBox.confirm(
      copyFrom
        ? '将复制当前版本的全部节点作为新版本的起点。老项目继续按原版本走，不受影响。'
        : '将创建一个空白版本，需要重新配置节点。',
      '新建流程版本',
      { confirmButtonText: '新建版本', cancelButtonText: '取消', type: 'info' },
    );
  } catch {
    return;
  }
  try {
    const version = await request<{ version: number }>(`/api/admin/workflows/templates/${selectedTemplate.value.id}/versions`, {
      method: 'POST',
      body: JSON.stringify(copyFrom ? { copyFromVersionId: copyFrom } : {}),
    });
    ElMessage.success(`已创建草稿版本 v${version.version}`);
    await loadTemplates();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '新建版本失败');
  }
}

async function publishVersion() {
  if (!versionDetail.value) return;
  try {
    await ElMessageBox.confirm(
      `发布 v${versionDetail.value.version} 后，该模板当前已发布的版本会被锁定；已绑定旧版本的项目继续按旧版本走。确定发布吗？`,
      '发布流程版本',
      { confirmButtonText: '确认发布', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await request(`/api/admin/workflows/versions/${versionDetail.value.id}/publish`, { method: 'POST' });
    ElMessage.success('流程版本已发布');
    await loadTemplates();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '发布失败');
  }
}

/* ---------------- 节点 ---------------- */

function resetNodeForm() {
  Object.assign(nodeForm, {
    name: '',
    nodeType: 'MANUAL',
    sequence: (versionDetail.value?.nodes.length ?? 0) + 1,
    assigneeType: 'ROLE',
    assigneeId: '',
    deadlineDays: undefined,
    warningDays: undefined,
    statisticsCode: 'IN_PROGRESS',
  });
  editingNodeId.value = null;
}

function openCreateNode() {
  resetNodeForm();
  nodeDialog.value = true;
}

function openEditNode(node: WorkflowNode) {
  editingNodeId.value = node.id;
  Object.assign(nodeForm, {
    name: node.name,
    nodeType: node.nodeType,
    sequence: node.sequence,
    assigneeType: node.assigneeType ?? 'ROLE',
    assigneeId: node.assigneeId ?? '',
    deadlineDays: node.deadlineDays ?? undefined,
    warningDays: node.warningDays ?? undefined,
    statisticsCode: node.settings?.statisticsCode ?? 'IN_PROGRESS',
  });
  nodeDialog.value = true;
}

async function saveNode() {
  if (!versionDetail.value) return;
  if (!nodeForm.name.trim()) {
    ElMessage.warning('请填写节点名称');
    return;
  }
  saving.value = true;
  try {
    const body = {
      name: nodeForm.name.trim(),
      nodeType: nodeForm.nodeType,
      sequence: Number(nodeForm.sequence) || 1,
      assigneeType: nodeForm.assigneeType || undefined,
      assigneeId: nodeForm.assigneeId || undefined,
      deadlineDays: nodeForm.deadlineDays ?? undefined,
      warningDays: nodeForm.warningDays ?? undefined,
      statisticsCode: nodeForm.statisticsCode,
    };
    if (editingNodeId.value) {
      await request(`/api/admin/workflows/nodes/${editingNodeId.value}`, { method: 'PATCH', body: JSON.stringify(body) });
      ElMessage.success('节点已更新');
    } else {
      await request(`/api/admin/workflows/versions/${versionDetail.value.id}/nodes`, { method: 'POST', body: JSON.stringify(body) });
      ElMessage.success('节点已新增');
    }
    nodeDialog.value = false;
    await loadVersionDetail();
    await loadTemplates();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '节点保存失败');
  } finally {
    saving.value = false;
  }
}

async function removeNode(node: WorkflowNode) {
  try {
    await ElMessageBox.confirm(`确定删除节点「${node.name}」吗？`, '确认删除', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' });
  } catch {
    return;
  }
  try {
    await request(`/api/admin/workflows/nodes/${node.id}`, { method: 'DELETE' });
    ElMessage.success('节点已删除');
    await loadVersionDetail();
    await loadTemplates();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '节点删除失败');
  }
}

onMounted(async () => {
  await loadOptions();
  await loadTemplates();
});
</script>

<template>
  <div class="workflow-admin" v-loading="loading">
    <el-card shadow="never" class="content-card">
      <template #header>
        <div class="card-header">
          <span>流程模板</span>
          <el-button type="primary" size="small" @click="openCreateTemplate">新建模板</el-button>
        </div>
      </template>

      <div class="field-toolbar">
        <el-select v-model="selectedTemplateId" style="width: 260px" @change="onTemplateChange">
          <el-option v-for="item in templates" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <span class="field-hint">模板名称与项目类型一致时自动匹配；未匹配到的项目使用「通用流程」。</span>
      </div>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="流程节点当前用于项目流程；合同状态由合同业务规则驱动，不在此处新增节点。"
        class="workflow-scope-alert"
      />

      <el-table :data="templates" stripe empty-text="暂无流程模板" @row-click="(row: WorkflowTemplate) => onTemplateChange(row.id)">
        <el-table-column prop="name" label="模板名称" min-width="140" />
        <el-table-column prop="description" label="说明" min-width="280" show-overflow-tooltip />
        <el-table-column label="版本" min-width="220">
          <template #default="scope">
            <el-tag v-for="version in scope.row.versions" :key="version.id" size="small" :type="statusTagType(version.status)" class="version-tag">
              v{{ version.version }} · {{ statusLabel(version.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="scope"><el-tag size="small" :type="scope.row.isActive ? 'success' : 'info'">{{ scope.row.isActive ? '启用' : '停用' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click.stop="onTemplateChange(scope.row.id)">配置节点</el-button>
            <el-tooltip
              :disabled="!scope.row.isSystem"
              content="系统预置模板不能删除；如需调整节点，请基于它新建版本"
              placement="top"
            >
              <span>
                <el-button link type="danger" :disabled="scope.row.isSystem" @click.stop="removeTemplate(scope.row)">删除</el-button>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="selectedTemplate" shadow="never" class="content-card node-card">
      <template #header>
        <div class="card-header">
          <span>
            「{{ selectedTemplate.name }}」节点配置
            <el-tag v-if="versionDetail" size="small" :type="statusTagType(versionDetail.status)" class="version-tag">
              v{{ versionDetail.version }} · {{ statusLabel(versionDetail.status) }}
            </el-tag>
            <el-tag v-else-if="selectedTemplate.versions.length === 0" size="small" type="warning" class="version-tag">尚未创建版本</el-tag>
          </span>
          <div class="header-actions">
            <el-button v-if="selectedTemplate.versions.length === 0" size="small" type="primary" @click="createVersion()">创建第一个版本</el-button>
            <template v-else>
              <el-button size="small" @click="createVersion(versionDetail?.id)">基于当前版本新建版本</el-button>
              <el-button v-if="isDraft" size="small" type="warning" @click="publishVersion">发布该版本</el-button>
              <el-button v-if="isDraft" size="small" type="primary" @click="openCreateNode">新增节点</el-button>
            </template>
          </div>
        </div>
      </template>

      <el-empty v-if="selectedTemplate.versions.length === 0" description="该模板还没有版本，点右上角「创建第一个版本」即可开始配置节点" />

      <template v-else>
        <el-alert v-if="isDraft" type="warning" :closable="false" show-icon class="draft-alert"
          title="当前是草稿版本，可以自由增删改节点；发布后该版本将被锁定，已绑定旧版本的项目继续按旧版本走。" />
        <el-alert v-else type="info" :closable="false" show-icon class="draft-alert"
          title="当前是已发布（或已锁定）版本，节点不可修改。如需调整请点「基于当前版本新建版本」，新版本发布后仅影响新项目。" />

        <el-table :data="versionDetail?.nodes ?? []" stripe empty-text="该版本还没有节点，点右上角「新增节点」开始配置">
          <el-table-column label="顺序" width="70" prop="sequence" />
          <el-table-column prop="name" label="节点名称" min-width="130" />
          <el-table-column label="类型" width="90">
            <template #default="scope">{{ nodeTypeOptions.find((item) => item.value === scope.row.nodeType)?.label ?? '其他' }}</template>
          </el-table-column>
          <el-table-column label="负责人" width="120">
            <template #default="scope">{{ scope.row.assigneeType === 'ROLE' ? roleLabel(scope.row.assigneeId) : (scope.row.assigneeId || '未指定') }}</template>
          </el-table-column>
          <el-table-column label="时限" width="90">
            <template #default="scope">{{ scope.row.deadlineDays ? `${scope.row.deadlineDays} 天` : '未设置' }}</template>
          </el-table-column>
          <el-table-column label="预警" width="90">
            <template #default="scope">{{ scope.row.warningDays ? `提前 ${scope.row.warningDays} 天` : '未设置' }}</template>
          </el-table-column>
          <el-table-column label="节点状态" width="110">
            <template #default="scope">{{ statisticsLabel(scope.row.settings?.statisticsCode) }}</template>
          </el-table-column>
          <el-table-column v-if="isDraft" label="操作" width="130" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="openEditNode(scope.row)">编辑</el-button>
              <el-button link type="danger" @click="removeNode(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <p class="field-hint node-note">
          「节点状态」是该节点对应的统计状态：项目推进到该节点时状态自动同步（例如末节点配「完成」，走完流程后项目即变为已完成）。
        </p>
      </template>
    </el-card>

    <el-dialog v-model="templateDialog" title="新建流程模板" width="520px">
      <el-form label-position="top">
        <el-form-item label="模板名称" required>
          <el-input v-model="templateForm.name" placeholder="例如：专利（与项目类型同名可自动匹配）" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="templateForm.description" type="textarea" :rows="3" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="templateDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveTemplate">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="nodeDialog" :title="editingNodeId ? '编辑流程节点' : '新增流程节点'" width="600px" @closed="resetNodeForm">
      <el-form label-position="top">
        <el-row :gutter="14">
          <el-col :span="24"><el-form-item label="节点名称" required><el-input v-model="nodeForm.name" placeholder="例如：内部审核" /></el-form-item></el-col>
        </el-row>
        <el-row :gutter="14">
          <el-col :span="8"><el-form-item label="顺序" required><el-input-number v-model="nodeForm.sequence" :min="1" style="width: 100%" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="节点类型"><el-select v-model="nodeForm.nodeType" style="width: 100%"><el-option v-for="item in nodeTypeOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="节点状态"><el-select v-model="nodeForm.statisticsCode" style="width: 100%"><el-option v-for="item in statisticsOptions" :key="item.code" :label="item.label" :value="item.code" /></el-select></el-form-item></el-col>
        </el-row>
        <el-row :gutter="14">
          <el-col :span="12"><el-form-item label="负责人角色"><el-select v-model="nodeForm.assigneeId" clearable placeholder="可选" style="width: 100%"><el-option v-for="item in roleOptions" :key="item.code" :label="item.name" :value="item.code" /></el-select></el-form-item></el-col>
          <el-col :span="12">
            <el-form-item label="时限与预警">
              <div class="inline-fields">
                <el-input-number v-model="nodeForm.deadlineDays" :min="1" :max="3650" placeholder="时限(天)" controls-position="right" />
                <el-input-number v-model="nodeForm.warningDays" :min="1" :max="3650" placeholder="提前预警(天)" controls-position="right" />
              </div>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="nodeDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveNode">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.node-card {
  margin-top: 16px;
}

.version-tag {
  margin-left: 8px;
}

.header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.draft-alert {
  margin-bottom: 14px;
}

.node-note {
  display: block;
  margin-top: 12px;
  line-height: 1.7;
}

.inline-fields {
  display: flex;
  gap: 8px;
  width: 100%;
}
</style>

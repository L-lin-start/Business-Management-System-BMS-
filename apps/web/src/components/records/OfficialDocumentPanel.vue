<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import FileAttachmentPanel from '../FileAttachmentPanel.vue';
import OptionSelector from '../OptionSelector.vue';
import CustomFieldForm from '../CustomFieldForm.vue';
import CustomFieldColumns from '../CustomFieldColumns.vue';
import MailDeliveryPanel from './MailDeliveryPanel.vue';
import { describeError, apiRequest, formatDate, useCustomFieldPresence, useOptionLabels } from './record-utils';

type OfficialDocument = {
  id: string;
  projectId: string;
  documentType: string | null;
  documentName: string;
  issuingAuthority: string | null;
  documentNo: string | null;
  issuedAt: string | null;
  deliveredAt: string | null;
  source: string | null;
  needsMailDelivery: boolean;
  note: string | null;
  customFields?: Record<string, unknown> | null;
  /** 列表接口会带出所属项目（待邮件登记视图跨项目时用来标识来源） */
  project?: { id: string; projectNo: string; projectName: string } | null;
  _count?: { mailDeliveries: number };
};

/**
 * 官文管理（PRD 4.5 / 8.5）：归属**项目**。
 *
 * 每个官文行可以展开，里面挂两样东西：
 *   1. 该官文的**附件**（resourceType='OfficialDocument'、resourceId=官文 id）—— 这才是官文扫描件该挂的地方
 *   2. 该官文的**邮件送达登记**（PRD 4.6，从官文出发登记）
 */
const props = defineProps<{
  token: string;
  projectId: string;
  /**
   * 合同上的客户 id：用于取出客户邮箱，作为邮件送达登记的默认收件人。
   * 之所以传 id 而不是直接传邮箱：项目详情接口只返回客户的 id/name（不含 email），
   * 这样可以在面板内用已有的客户接口取，**不必改后端**。
   */
  customerId?: string | null | undefined;
  canManage: boolean;
  canDelete: boolean;
  /** 附件权限与官文编辑权限彼此独立。 */
  canViewFiles: boolean;
  canDownloadFiles: boolean;
  canUploadFiles: boolean;
  canDeleteFiles: boolean;
  /**
   * 是否**实际可以访问本项目的附件**（= 权限点通过 **且** 数据范围通过）。
   * 与 `canViewFiles` 的区别：后者只是"有没有 attachment.read 权限点"。
   * 附件接口还会按数据范围判定，只凭权限点显示附件区会出现
   * "区域能打开、打开就报无权访问"的困惑。父组件会静默探测一次再传结论进来。
   */
  canAccessFiles: boolean;
  /** 邮件送达使用自己的权限点，不能沿用官文权限。 */
  canViewMail: boolean;
  canManageMail: boolean;
  canDeleteMail: boolean;
  /** 进入面板时直接切到「只看待邮件登记」（由首页卡片跳转时传 true） */
  initialNeedsMailOnly?: boolean;
  /**
   * 待邮件登记视图是否**跨项目**。
   *
   * 「超时邮件登记」是公司级指标（首页卡片统计的就是全部项目里待登记的官文），
   * 所以从首页跳进来时必须能看全，而不是只看某一个项目。
   */
  crossProject?: boolean;
}>();

/** 客户邮箱：邮件送达新建时预填，减少手工输入 */
const customerEmail = ref<string | null>(null);

async function loadCustomerEmail() {
  if (!props.customerId) return;
  try {
    const customer = await apiRequest<{ email: string | null }>(props.token, `/api/customers/${props.customerId}`);
    customerEmail.value = customer.email ?? null;
  } catch {
    // 取不到就留空，用户手工填即可（不影响登记功能）
    customerEmail.value = null;
  }
}

const items = ref<OfficialDocument[]>([]);
const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
/** 官文类型/来源存的是编码，表格里要显示中文 */
const { labelOf, load: loadOptionLabels } = useOptionLabels(props.token, ['officialDocumentType', 'officialDocumentSource']);
const form = reactive({
  documentType: '',
  documentName: '',
  issuingAuthority: '',
  documentNo: '',
  issuedAt: '',
  deliveredAt: '',
  source: '',
  needsMailDelivery: false,
  note: '',
});
/**
 * 自定义字段取值：由系统 B 的字段定义驱动（模块 official_document）。
 * 与系统字段分开放，提交时作为 `customFields` 一起发送，后端按字段定义校验。
 */
const customFieldValues = ref<Record<string, unknown>>({});
/** 系统 B 是否给「官文」配了自定义字段（没有就不显示分割线） */
const { hasCustomFields, load: loadCustomFieldPresence } = useCustomFieldPresence(props.token, 'official_document');

/**
 * 只看「需要邮件送达、但还没登记送达」的官文。
 *
 * 这是 PRD 4.6「超时提醒」在界面上的落地入口：首页那张「超时邮件登记」卡片数的就是这个数，
 * 但在此之前**没有任何地方能看到这些官文是哪些**，也就无法去补登记。
 */
/** 只看「需要邮件送达、但尚未登记送达」的官文（PRD 4.6 超时提醒口径） */
const needsMailOnly = ref(Boolean(props.initialNeedsMailOnly));

/**
 * 旧版「按项目」官文附件面板的引用。
 *
 * 工具栏里的「上传官文附件」直接触发它内部的文件选择 —— 复用同一套上传逻辑，
 * 不重复实现。这样即使展开行里的面板被表格裁剪，也始终有一个可见的上传入口。
 */
const legacyAttachmentRef = ref<{ chooseFile?: () => void } | null>(null);

function triggerUpload() {
  legacyAttachmentRef.value?.chooseFile?.();
}

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ pageSize: '100' });
    // 待邮件登记视图跨项目看（company 级指标）；普通视图只看当前项目
    if (!needsMailOnly.value || !props.crossProject) params.set('projectId', props.projectId);
    if (needsMailOnly.value) params.set('needsMailOnly', 'true');
    const result = await apiRequest<{ items: OfficialDocument[] }>(
      props.token,
      `/api/records/official-documents?${params.toString()}`,
    );
    items.value = result.items;
  } catch (error) {
    ElMessage.error(describeError(error, '官文加载失败'));
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  Object.assign(form, {
    documentType: '',
    documentName: '',
    issuingAuthority: '',
    documentNo: '',
    issuedAt: '',
    deliveredAt: '',
    source: '',
    needsMailDelivery: false,
    note: '',
  });
  customFieldValues.value = {};
}

function openCreate() {
  editingId.value = null;
  resetForm();
  dialogVisible.value = true;
}

function openEdit(row: OfficialDocument) {
  editingId.value = row.id;
  Object.assign(form, {
    documentType: row.documentType ?? '',
    documentName: row.documentName,
    issuingAuthority: row.issuingAuthority ?? '',
    documentNo: row.documentNo ?? '',
    issuedAt: row.issuedAt ? formatDate(row.issuedAt) : '',
    deliveredAt: row.deliveredAt ? formatDate(row.deliveredAt) : '',
    source: row.source ?? '',
    needsMailDelivery: row.needsMailDelivery,
    note: row.note ?? '',
  });
  // 回填自定义字段，否则编辑时会丢失（后端 partial 更新下不传即不改，但界面得显示出来）
  customFieldValues.value = { ...(row.customFields ?? {}) };
  dialogVisible.value = true;
}

async function save() {
  if (!form.documentName.trim()) {
    ElMessage.warning('请填写官文名称');
    return;
  }
  saving.value = true;
  try {
    const body = JSON.stringify({
      ...(editingId.value ? {} : { projectId: props.projectId }),
      documentName: form.documentName.trim(),
      documentType: form.documentType || undefined,
      issuingAuthority: form.issuingAuthority || undefined,
      documentNo: form.documentNo || undefined,
      issuedAt: form.issuedAt || undefined,
      deliveredAt: form.deliveredAt || undefined,
      source: form.source || undefined,
      needsMailDelivery: form.needsMailDelivery,
      note: form.note || undefined,
      customFields: customFieldValues.value,
    });
    if (editingId.value) {
      await apiRequest(props.token, `/api/records/official-documents/${editingId.value}`, { method: 'PATCH', body });
      ElMessage.success('官文已更新');
    } else {
      await apiRequest(props.token, '/api/records/official-documents', { method: 'POST', body });
      ElMessage.success('官文已录入');
    }
    dialogVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function remove(row: OfficialDocument) {
  try {
    const { value } = await ElMessageBox.prompt('请填写删除原因（会写入操作日志）', '删除官文', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      inputPlaceholder: '例如：录入错误',
      inputValidator: (text: string) => (text?.trim() ? true : '删除原因必填'),
    });
    await apiRequest(props.token, `/api/records/official-documents/${row.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: value }),
    });
    ElMessage.success('官文已删除');
    await load();
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(error instanceof Error ? error.message : '删除失败');
  }
}

/** 切换「只看待邮件登记」时重新拉取 */
watch(needsMailOnly, () => {
  void load();
});

onMounted(async () => {
  await Promise.all([load(), loadOptionLabels(), loadCustomerEmail(), loadCustomFieldPresence()]);
});
defineExpose({ reload: load });
</script>

<template>
  <div class="record-panel">
    <div class="tab-toolbar">
      <span class="tab-hint">
        {{ needsMailOnly
          ? (props.crossProject
              ? '以下为全部项目中「需要邮件送达、但尚未登记送达」的官文。展开一行即可补登记。'
              : '以下为本项目中「需要邮件送达、但尚未登记送达」的官文。展开一行即可补登记。')
          : '官文归属本项目。展开一行可以维护该官文的附件与邮件送达登记。' }}
      </span>
      <div class="toolbar-actions">
        <el-checkbox v-if="props.canViewMail" v-model="needsMailOnly" size="small">只看待邮件登记</el-checkbox>
        <el-button
          v-if="props.canAccessFiles && props.canUploadFiles"
          size="small"
          @click="triggerUpload"
        >
          上传官文附件
        </el-button>
        <el-button v-if="props.canManage && !needsMailOnly" type="primary" size="small" @click="openCreate">录入官文</el-button>
      </div>
    </div>

    <!-- 展开行里藏了两个功能，给一句明确指引，避免用户以为"没有入口" -->
    <p v-if="props.canViewMail" class="expand-tip">
      登记邮件送达：展开下方任意一条官文（点行首的 ▷），在「邮件送达登记」里点「登记送达」。
    </p>

    <el-collapse v-if="props.canAccessFiles" class="legacy-attachment-collapse">
      <el-collapse-item title="历史未归档官文附件" name="legacy-project-files">
        <p class="legacy-attachment-hint">
          这里保留旧版按项目上传的官文附件，避免历史文件丢失。新附件请展开下方具体官文后上传。
        </p>
        <FileAttachmentPanel
          ref="legacyAttachmentRef"
          :token="props.token"
          resource-type="OfficialDocument"
          :resource-id="props.projectId"
          title="历史未归档官文附件"
          :can-download="props.canDownloadFiles"
          :can-upload="props.canUploadFiles"
          :can-delete="props.canDeleteFiles"
          inline-error
        />
      </el-collapse-item>
    </el-collapse>

    <el-table v-loading="loading" :data="items" stripe empty-text="暂无官文">
      <el-table-column type="expand">
        <template #default="scope">
          <div class="expand-area">
            <!--
              顺序说明：**邮件送达登记放在官文附件之前**。
              这里曾经是附件在前、邮件登记在后，结果展开行里两块大内容叠加，
              邮件送达登记被挤出可视区域且滚不到 —— 用户反复反馈"找不到登记窗口"。
              PRD 4.6 的核心动作就是登记送达，理应比附件更靠前、第一眼就能看到。
            -->
            <MailDeliveryPanel
              v-if="props.canViewMail"
              :token="props.token"
              :official-document-id="scope.row.id"
              :default-email="customerEmail"
              :can-manage="props.canManageMail"
              :can-delete="props.canDeleteMail"
            />
            <div v-if="props.canAccessFiles" class="expand-section">
              <FileAttachmentPanel
                :token="props.token"
                resource-type="OfficialDocument"
                :resource-id="scope.row.id"
                title="官文附件"
                :can-download="props.canDownloadFiles"
                :can-upload="props.canUploadFiles"
                :can-delete="props.canDeleteFiles"
                inline-error
              />
            </div>
            <!-- 两个区都无权限时给一句说明，避免展开后是一片空白让人以为坏了 -->
            <p v-if="!props.canViewMail && !props.canAccessFiles" class="sub-text">
              当前角色没有官文附件与邮件送达的查看权限，请联系系统管理员在「角色权限」中配置。
            </p>
          </div>
        </template>
      </el-table-column>
      <!-- 待邮件登记视图可能跨项目，标出来源项目，便于知道去哪补登记 -->
      <el-table-column v-if="needsMailOnly && props.crossProject" label="所属项目" min-width="170">
        <template #default="scope">
          <span v-if="scope.row.project">{{ scope.row.project.projectNo }}</span>
          <span v-else class="sub-text">-</span>
        </template>
      </el-table-column>
      <el-table-column label="官文名称" prop="documentName" min-width="180" />
      <el-table-column label="官文类型" width="150">
        <template #default="scope">
          <span v-if="scope.row.documentType">{{ labelOf(scope.row.documentType) }}</span>
          <span v-else class="sub-text">未设置</span>
        </template>
      </el-table-column>
      <el-table-column label="来源" width="110">
        <template #default="scope">
          <span v-if="scope.row.source">{{ labelOf(scope.row.source) }}</span>
          <span v-else class="sub-text">-</span>
        </template>
      </el-table-column>
      <el-table-column label="发文机构" prop="issuingAuthority" min-width="150">
        <template #default="scope">{{ scope.row.issuingAuthority || '-' }}</template>
      </el-table-column>
      <el-table-column label="官文编号" prop="documentNo" min-width="140">
        <template #default="scope">{{ scope.row.documentNo || '-' }}</template>
      </el-table-column>
      <el-table-column label="发文日" width="115">
        <template #default="scope">{{ formatDate(scope.row.issuedAt) }}</template>
      </el-table-column>
      <el-table-column label="送达日" width="115">
        <template #default="scope">{{ formatDate(scope.row.deliveredAt) }}</template>
      </el-table-column>
      <el-table-column label="需邮件送达" width="110">
        <template #default="scope">
          <el-tag size="small" :type="scope.row.needsMailDelivery ? 'warning' : 'info'">
            {{ scope.row.needsMailDelivery ? '需要' : '不需要' }}
          </el-tag>
        </template>
      </el-table-column>
      <!-- 系统 B 配置的自定义字段列（模块 official_document） -->
      <CustomFieldColumns :token="props.token" module-key="official_document" :rows="items" />
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="scope">
          <el-button v-if="props.canManage" link type="primary" @click="openEdit(scope.row)">编辑</el-button>
          <el-button v-if="props.canDelete" link type="danger" @click="remove(scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑官文' : '录入官文'" width="640px">
      <el-form label-position="top">
        <el-row :gutter="12">
          <el-col :span="14">
            <el-form-item label="官文名称" required>
              <el-input v-model="form.documentName" placeholder="例如：发明专利审查意见通知书" />
            </el-form-item>
          </el-col>
          <el-col :span="10">
            <el-form-item label="官文类型">
              <OptionSelector v-model="form.documentType" :token="props.token" module-key="officialDocumentType" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="发文机构">
              <el-input v-model="form.issuingAuthority" placeholder="例如：国家知识产权局" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="官文编号">
              <el-input v-model="form.documentNo" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="发文日">
              <el-date-picker v-model="form.issuedAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="送达日">
              <el-date-picker v-model="form.deliveredAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="来源">
              <OptionSelector v-model="form.source" :token="props.token" module-key="officialDocumentSource" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="是否需邮件送达">
          <el-switch v-model="form.needsMailDelivery" />
          <span class="field-hint inline">开启后请在本行展开的「邮件送达登记」里登记实际发送情况。</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" />
        </el-form-item>
        <!-- 系统 B 为「官文」配置的自定义字段 -->
        <el-divider v-if="hasCustomFields" content-position="left">自定义字段</el-divider>
        <CustomFieldForm :token="props.token" module-key="official_document" v-model="customFieldValues" />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/*
 * 展开行里的附件区曾经"看不见上传按钮"。
 *
 * 原因：Element Plus 的 `type="expand"` 内容被放在 `.el-table__expanded-cell` 里，
 * 而外层 `.el-table__body-wrapper` 是 `overflow: hidden`（表格要支持横向滚动）。
 * 当所有列宽之和大于容器宽度时（官文表列多，必然超宽），
 * 展开区右侧的内容 —— 也就是右对齐的那个「上传附件」按钮 —— 会被裁掉。
 * 按钮确实在 DOM 里（权限也确实是 true），只是被裁在可视区域之外。
 *
 * 解决：让展开单元格撑满表格宽度并允许内容溢出，同时把工具栏做成固定可见的一行。
 */
.record-panel :deep(.el-table__expanded-cell) {
  width: 100% !important;
  overflow: visible !important;
}

/* 展开单元格默认 padding 较大，这里收紧并确保内部不换行挤压 */
.record-panel :deep(.el-table__expanded-cell) .expand-area {
  min-width: 0;
}

/*
 * 展开区可滚动。
 *
 * 展开行里同时有「邮件送达登记」和「官文附件」两块内容，高度会超过表格给的空间。
 * 不给滚动的话下面那块会被直接裁掉且无法查看（用户反馈过"找不到邮件送达登记"）。
 * 这里限高 + 允许纵向滚动，保证两块内容都能看到。
 */
.record-panel :deep(.el-table__expanded-cell) .expand-area {
  max-height: 60vh;
  overflow-y: auto;
}

/* 展开行的操作指引 */
.expand-tip {
  margin: 0 0 10px;
  color: #8b99ad;
  font-size: 12px;
  line-height: 1.7;
}

/* 附件工具条：上传按钮始终靠右且不被裁 */
.expand-section :deep(.attachment-toolbar) {
  flex-wrap: wrap;
  row-gap: 8px;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.tab-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.tab-hint {
  color: #8b99ad;
  font-size: 12px;
  line-height: 1.7;
}

.sub-text {
  color: #a9b4c4;
  font-size: 12px;
}

.expand-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 6px 12px 12px;
}

.legacy-attachment-collapse {
  margin-bottom: 14px;
}

.legacy-attachment-hint {
  margin: 0 0 10px;
  color: #8b99ad;
  font-size: 12px;
  line-height: 1.6;
}

.field-hint {
  display: block;
  color: #909399;
  font-size: 12px;
}

.field-hint.inline {
  display: inline;
  margin-left: 10px;
}
</style>




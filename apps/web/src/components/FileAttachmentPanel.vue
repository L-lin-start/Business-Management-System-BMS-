<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

type ResourceType = 'Contract' | 'Project' | 'OfficialDocument';
type FileItem = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy: { displayName: string; username: string } | null;
};

const props = withDefaults(defineProps<{
  token: string;
  resourceType: ResourceType;
  resourceId: string;
  title?: string;
  canDownload?: boolean;
  canUpload?: boolean;
  canDelete?: boolean;
  /**
   * 加载失败时的呈现方式。
   *   false（默认）：弹出全局提示 —— 适合独占整页/整标签的场景（合同附件、项目文件）
   *   true：在面板内显示一行错误 —— 适合嵌在别的内容里的场景（官文展开行），
   *         避免一个附属区块的失败把整个页面的提示条带出来、干扰别的操作
   */
  inlineError?: boolean;
}>(), { title: '附件', canDownload: false, canUpload: false, canDelete: false, inlineError: false });

const files = ref<FileItem[]>([]);
const loading = ref(false);
const uploading = ref(false);
const loadError = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const previewVisible = ref(false);
const previewLoading = ref(false);
const previewKind = ref<'pdf' | 'image' | 'text' | 'docx' | ''>('');
const previewUrl = ref('');
const previewText = ref('');
const previewError = ref('');
const previewTitle = ref('');
const docxContainer = ref<HTMLDivElement | null>(null);

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${props.token}`, ...(options.headers ?? {}) } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    // 带上状态码：403（没权限）与 404（记录不存在）要能一眼分开，否则排查时会被误导
    const message = Array.isArray(payload?.message) ? payload.message.join('；') : payload?.message;
    throw new Error(`${message ?? '请求失败'}（HTTP ${response.status}）`);
  }
  return payload as T;
}

async function loadFiles() {
  if (!props.resourceId) return;
  loading.value = true;
  loadError.value = '';
  try {
    files.value = await request<FileItem[]>(`/api/files/${props.resourceType}/${props.resourceId}`);
  } catch (error) {
    files.value = [];
    const message = error instanceof Error ? error.message : '附件加载失败';
    if (props.inlineError) loadError.value = message;
    else ElMessage.error(message);
  } finally {
    loading.value = false;
  }
}

function chooseFile() {
  fileInput.value?.click();
}

/**
 * 暴露给父组件：让父级工具栏也能放一个「上传附件」按钮，触发同一个文件选择。
 *
 * 场景：附件面板嵌在 Element Plus 的展开行里时，面板自己的按钮可能被表格的
 * 横向滚动容器裁剪（列多时必然超宽），父级提供一个始终可见的入口更稳妥。
 */
defineExpose({ chooseFile, reload: loadFiles });

async function uploadFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  uploading.value = true;
  try {
    const response = await fetch(`/api/files/${props.resourceType}/${props.resourceId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${props.token}` },
      body: formData,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message ?? '上传失败');
    ElMessage.success('附件上传成功');
    await loadFiles();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '附件上传失败');
  } finally {
    uploading.value = false;
  }
}

function detectPreviewKind(file: FileItem) {
  const name = file.originalName.toLowerCase();
  if (file.mimeType === 'application/pdf' || name.endsWith('.pdf')) return 'pdf' as const;
  if (file.mimeType.startsWith('image/')) return 'image' as const;
  if (file.mimeType === 'text/plain' || name.endsWith('.txt')) return 'text' as const;
  if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx')) return 'docx' as const;
  return '';
}

function clearPreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = '';
  previewText.value = '';
  previewError.value = '';
  previewKind.value = '';
  if (docxContainer.value) docxContainer.value.replaceChildren();
}

async function previewFile(file: FileItem) {
  clearPreview();
  previewTitle.value = `预览：${file.originalName}`;
  previewKind.value = detectPreviewKind(file);
  previewVisible.value = true;
  if (!previewKind.value) {
    previewError.value = '该文件格式暂不支持在线预览，请下载后查看。';
    return;
  }
  previewLoading.value = true;
  try {
    const response = await fetch(`/api/files/${file.id}/preview`, { headers: { Authorization: `Bearer ${props.token}` } });
    if (!response.ok) throw new Error('文件读取失败');
    const blob = await response.blob();
    if (previewKind.value === 'text') {
      previewText.value = await blob.text();
    } else if (previewKind.value === 'docx') {
      await nextTick();
      if (!docxContainer.value) throw new Error('Word 预览区域初始化失败');
      const { renderAsync } = await import('docx-preview');
      await renderAsync(blob, docxContainer.value, docxContainer.value, {
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
        renderAltChunks: false,
        useBase64URL: true,
      });
    } else {
      previewUrl.value = URL.createObjectURL(blob);
    }
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : '文件预览失败';
  } finally {
    previewLoading.value = false;
  }
}

async function downloadFile(file: FileItem) {
  try {
    const response = await fetch(`/api/files/${file.id}/download`, { headers: { Authorization: `Bearer ${props.token}` } });
    if (!response.ok) throw new Error('文件读取失败');
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.originalName;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '文件下载失败');
  }
}

async function removeFile(file: FileItem) {
  try {
    await ElMessageBox.confirm(`删除附件「${file.originalName}」？删除后业务页面不再显示，但操作记录会保留。`, '确认删除附件', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' });
  } catch {
    return;
  }
  try {
    await request(`/api/files/${file.id}`, { method: 'DELETE' });
    ElMessage.success('附件已删除');
    await loadFiles();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '附件删除失败');
  }
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

onMounted(loadFiles);
watch(() => [props.resourceType, props.resourceId], loadFiles);
onBeforeUnmount(clearPreview);
</script>

<template>
  <div class="attachment-panel">
    <div class="attachment-toolbar">
      <div>
        <strong>{{ title }}</strong>
        <span class="field-hint">支持 PDF、图片、Office、文本和 ZIP，单个文件默认不超过 20 MB。</span>
      </div>
      <div>
        <input ref="fileInput" class="hidden-file-input" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.doc,.docx,.xls,.xlsx,.zip" @change="uploadFile" />
        <el-button v-if="canUpload" type="primary" size="small" :loading="uploading" @click="chooseFile">上传附件</el-button>
      </div>
    </div>
    <!-- 内联错误：嵌在别的区块里时（如官文展开行）不弹全局提示，避免干扰同屏的其他操作 -->
    <el-alert v-if="loadError" type="warning" :closable="false" show-icon class="attachment-error">
      <template #title>附件暂时无法加载：{{ loadError }}</template>
    </el-alert>
    <el-table v-loading="loading" :data="files" size="small" stripe empty-text="暂无附件">
      <el-table-column label="文件名" min-width="220">
        <template #default="scope"><span class="file-name">{{ scope.row.originalName }}</span></template>
      </el-table-column>
      <el-table-column label="大小" width="100"><template #default="scope">{{ formatSize(scope.row.sizeBytes) }}</template></el-table-column>
      <el-table-column label="上传人" width="120"><template #default="scope">{{ scope.row.uploadedBy?.displayName ?? '系统' }}</template></el-table-column>
      <el-table-column label="上传时间" width="165"><template #default="scope">{{ new Date(scope.row.createdAt).toLocaleString('zh-CN') }}</template></el-table-column>
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="scope">
          <el-button link type="primary" @click="previewFile(scope.row)">预览</el-button>
          <el-button v-if="canDownload" link type="primary" @click="downloadFile(scope.row)">下载</el-button>
          <el-button v-if="canDelete" link type="danger" @click="removeFile(scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-dialog v-model="previewVisible" :title="previewTitle" width="90%" top="3vh" destroy-on-close @closed="clearPreview">
      <div v-loading="previewLoading" class="preview-shell">
        <el-alert v-if="previewError" :title="previewError" type="warning" :closable="false" show-icon />
        <iframe v-else-if="previewKind === 'pdf' && previewUrl" class="preview-frame" :src="previewUrl" title="PDF 文件预览" />
        <img v-else-if="previewKind === 'image' && previewUrl" class="preview-image" :src="previewUrl" :alt="previewTitle" />
        <pre v-else-if="previewKind === 'text'" class="preview-text">{{ previewText }}</pre>
        <div v-show="previewKind === 'docx'" ref="docxContainer" class="docx-container" />
      </div>
      <template #footer><el-button @click="previewVisible = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.attachment-error {
  margin-bottom: 8px;
}

.attachment-panel { margin-top: 16px; }
.attachment-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.attachment-toolbar > div:first-child { display: flex; flex-direction: column; gap: 3px; }
.hidden-file-input { display: none; }
.file-name { word-break: break-all; }
.preview-shell { min-height: 72vh; max-height: 78vh; overflow: auto; background: #f5f7fa; }
.preview-frame { display: block; width: 100%; height: 76vh; border: 0; background: #fff; }
.preview-image { display: block; max-width: 100%; margin: 0 auto; }
.preview-text { min-height: 70vh; margin: 0; padding: 20px; box-sizing: border-box; white-space: pre-wrap; word-break: break-word; background: #fff; }
.docx-container { min-height: 70vh; padding: 16px; box-sizing: border-box; overflow: auto; }
:deep(.docx-wrapper) { padding: 20px; }
</style>


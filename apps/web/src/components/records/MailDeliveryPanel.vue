<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import OptionSelector from '../OptionSelector.vue';
import CustomFieldForm from '../CustomFieldForm.vue';
import CustomFieldColumns from '../CustomFieldColumns.vue';
import { describeError, apiRequest, formatDate, formatDateTime, useCustomFieldPresence } from './record-utils';

type MailDelivery = {
  id: string;
  officialDocumentId: string;
  recipientEmail: string;
  sentAt: string | null;
  statusCode: string;
  note: string | null;
  registeredAt: string;
  sentBy: { id: string; displayName: string } | null;
  registeredBy: { id: string; displayName: string } | null;
  customFields?: Record<string, unknown> | null;
};

/**
 * 邮件送达登记（PRD 4.6 / 8.6）：挂在**官文**下面，不是直接挂项目。
 * 一个官文可以有多条送达记录（例如发给多个收件人、或先失败后重发）。
 */
const props = defineProps<{
  token: string;
  officialDocumentId: string;
  /** 默认收件人邮箱（取客户邮箱），新建时预填，减少手工输入 */
  defaultEmail?: string | null | undefined;
  canManage: boolean;
  canDelete: boolean;
}>();

const items = ref<MailDelivery[]>([]);
const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const form = reactive({ recipientEmail: '', sentAt: '', statusCode: '', note: '' });
/** 编辑时记录原状态；用户只改发送日期而未改状态时，交给后端按日期自动推断。 */
const originalStatusCode = ref('');
const originalSentAt = ref('');
/** 自定义字段取值：由系统 B 的字段定义驱动（模块 mail_delivery） */
const customFieldValues = ref<Record<string, unknown>>({});
const { hasCustomFields, load: loadCustomFieldPresence } = useCustomFieldPresence(props.token, 'mail_delivery');

async function load() {
  loading.value = true;
  try {
    const result = await apiRequest<{ items: MailDelivery[] }>(
      props.token,
      `/api/records/mail-deliveries?officialDocumentId=${props.officialDocumentId}&pageSize=50`,
    );
    items.value = result.items;
  } catch (error) {
    ElMessage.error(describeError(error, '邮件送达记录加载失败'));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editingId.value = null;
  Object.assign(form, { recipientEmail: props.defaultEmail ?? '', sentAt: '', statusCode: '', note: '' });
  originalStatusCode.value = '';
  originalSentAt.value = '';
  customFieldValues.value = {};
  dialogVisible.value = true;
}

function openEdit(row: MailDelivery) {
  editingId.value = row.id;
  Object.assign(form, {
    recipientEmail: row.recipientEmail,
    sentAt: row.sentAt ? formatDate(row.sentAt) : '',
    statusCode: row.statusCode,
    note: row.note ?? '',
  });
  originalStatusCode.value = row.statusCode;
  originalSentAt.value = row.sentAt ? formatDate(row.sentAt) : '';
  customFieldValues.value = { ...(row.customFields ?? {}) };
  dialogVisible.value = true;
}

async function save() {
  if (!form.recipientEmail.trim()) {
    ElMessage.warning('请填写主收件人邮箱');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.recipientEmail.trim())) {
    ElMessage.warning('请输入有效的邮箱地址');
    return;
  }
  saving.value = true;
  try {
    const body = JSON.stringify({
      ...(editingId.value ? {} : { officialDocumentId: props.officialDocumentId }),
      recipientEmail: form.recipientEmail.trim(),
      // 仅在实际修改发送日期时提交；编辑备注时不能把原状态误推断为已发送。
      sentAt: form.sentAt !== originalSentAt.value ? (form.sentAt || undefined) : undefined,
      // 编辑时未改状态不回传旧值，避免改发送日期后仍被旧状态覆盖。
      statusCode: form.statusCode && form.statusCode !== originalStatusCode.value ? form.statusCode : undefined,
      note: form.note || undefined,
      customFields: customFieldValues.value,
    });
    if (editingId.value) {
      await apiRequest(props.token, `/api/records/mail-deliveries/${editingId.value}`, { method: 'PATCH', body });
      ElMessage.success('邮件送达记录已更新');
    } else {
      await apiRequest(props.token, '/api/records/mail-deliveries', { method: 'POST', body });
      ElMessage.success('邮件送达记录已登记');
    }
    dialogVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function remove(row: MailDelivery) {
  try {
    const { value } = await ElMessageBox.prompt('请填写删除原因（会写入操作日志）', '删除邮件送达记录', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      inputPlaceholder: '例如：登记错误',
      inputValidator: (text: string) => (text?.trim() ? true : '删除原因必填'),
    });
    await apiRequest(props.token, `/api/records/mail-deliveries/${row.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: value }),
    });
    ElMessage.success('已删除');
    await load();
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(error instanceof Error ? error.message : '删除失败');
  }
}

onMounted(async () => {
  await Promise.all([load(), loadCustomFieldPresence()]);
});
defineExpose({ reload: load });
</script>

<template>
  <div class="mail-block">
    <div class="mail-toolbar">
      <span class="mail-title">邮件送达登记</span>
      <el-button v-if="props.canManage" size="small" type="primary" plain @click="openCreate">登记送达</el-button>
    </div>

    <el-table v-loading="loading" :data="items" size="small" stripe empty-text="尚未登记邮件送达">
      <el-table-column label="主收件人邮箱" prop="recipientEmail" min-width="200" />
      <el-table-column label="实际发送日期" width="130">
        <template #default="scope">{{ formatDate(scope.row.sentAt) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="scope">
          <el-tag size="small" :type="scope.row.statusCode === 'SENT' ? 'success' : scope.row.statusCode === 'FAILED' ? 'danger' : 'info'">
            {{ scope.row.statusCode === 'SENT' ? '已发送' : scope.row.statusCode === 'FAILED' ? '发送失败' : scope.row.statusCode === 'NOT_REQUIRED' ? '无需发送' : '待发送' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="发送人" width="110">
        <template #default="scope">{{ scope.row.sentBy?.displayName ?? '-' }}</template>
      </el-table-column>
      <el-table-column label="登记人 / 时间" min-width="180">
        <template #default="scope">
          {{ scope.row.registeredBy?.displayName ?? '-' }}
          <span class="sub-text">{{ formatDateTime(scope.row.registeredAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="备注" min-width="140"><template #default="scope">{{ scope.row.note || '-' }}</template></el-table-column>
      <CustomFieldColumns :token="props.token" module-key="mail_delivery" :rows="items" />
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="scope">
          <el-button v-if="props.canManage" link type="primary" @click="openEdit(scope.row)">编辑</el-button>
          <el-button v-if="props.canDelete" link type="danger" @click="remove(scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑邮件送达' : '登记邮件送达'" width="520px">
      <el-form label-position="top">
        <el-form-item label="主收件人邮箱" required>
          <el-input v-model="form.recipientEmail" placeholder="默认取客户联系人邮箱，可修改" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="实际发送日期">
              <el-date-picker v-model="form.sentAt" type="date" value-format="YYYY-MM-DD" placeholder="留空表示尚未发送" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="状态">
              <OptionSelector v-model="form.statusCode" :token="props.token" module-key="mailDeliveryStatus" placeholder="按发送日期自动推断" />
            </el-form-item>
          </el-col>
        </el-row>
        <span class="field-hint">不选状态时：填了发送日期记为「已发送」，没填记为「待发送」。</span>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" />
        </el-form-item>
        <el-divider v-if="hasCustomFields" content-position="left">自定义字段</el-divider>
        <CustomFieldForm :token="props.token" module-key="mail_delivery" v-model="customFieldValues" />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.mail-block {
  padding: 10px 14px 4px;
  background: #fafbfd;
  border-radius: 6px;
}

.mail-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.mail-title {
  color: #5b6b85;
  font-size: 13px;
  font-weight: 600;
}

.sub-text {
  margin-left: 8px;
  color: #a9b4c4;
  font-size: 12px;
}

.field-hint {
  display: block;
  margin: -6px 0 12px;
  color: #909399;
  font-size: 12px;
}
</style>



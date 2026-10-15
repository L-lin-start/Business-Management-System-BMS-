<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';

type LoginResult = {
  accessToken: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    isSystemAdmin: boolean;
    roles: Array<{ code: string; name: string }>;
    departments: Array<{ id: string; name: string; code: string }>;
  };
};

const emit = defineEmits<{
  success: [payload: LoginResult];
}>();

const username = ref('');
const password = ref('');
const loading = ref(false);

async function submit() {
  if (!username.value.trim() || !password.value) {
    ElMessage.warning('请输入用户名和密码');
    return;
  }

  loading.value = true;
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    });
    const payload = (await response.json()) as LoginResult & { message?: string };

    if (!response.ok) {
      throw new Error(payload.message ?? '登录失败');
    }

    emit('success', payload);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '登录失败，请稍后重试');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-panel">
      <div class="login-brand">业务管理系统</div>
      <h1>欢迎登录</h1>
      <p class="login-subtitle">统一业务入口 · 本地开发环境</p>

      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="用户名">
          <el-input
            v-model="username"
            autocomplete="username"
            placeholder="请输入用户名"
            size="large"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="password"
            autocomplete="current-password"
            placeholder="请输入密码"
            size="large"
            type="password"
            show-password
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-button class="login-button" type="primary" size="large" :loading="loading" @click="submit">
          登录
        </el-button>
      </el-form>

      <p class="login-tip">本地开发环境，账号由管理员在「管理系统」中创建。</p>
    </section>
  </main>
</template>

<style scoped>
.login-tip {
  margin: 22px 0 0;
  padding-top: 18px;
  border-top: 1px dashed #e4e9f2;
  color: #8b99ad;
  font-size: 12px;
  line-height: 1.7;
  text-align: center;
}
</style>

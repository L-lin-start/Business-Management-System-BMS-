import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import './styles.css';
import App from './App.vue';

// 说明：Element Plus 的中文语言包在 App.vue 里通过 <el-config-provider :locale="zhCn"> 挂载。
// 不在这里 `use(ElementPlus, { locale })` 的原因：element-plus 2.14.7 的
// `es/locale/lang/zh-cn.d.ts` 与 `ConfigProviderProps['locale']`（Language 类型）
// 定义不一致，直接传会报 TS2769；而 config-provider 的 locale 是运行时属性，不受该差异影响。
// 不指定语言时 Element Plus 会退回英文 —— 日期选择器显示 "October"、下拉显示 "Select"。
createApp(App).use(ElementPlus).mount('#app');

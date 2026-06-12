import { createApp } from 'vue';
import TDesign from 'tdesign-vue-next';
import 'tdesign-vue-next/es/style/index.css';
import './manager.css';
import './manager-vue.css';
import App from './manager-app.vue';

createApp(App).use(TDesign).mount('#app');

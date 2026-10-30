import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import IsolationFixture from './IsolationFixture.vue'
import { userIsolationPlugin } from '../../src/stores/user-isolation'
import '../../src/App.vue'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import '../../src/style.css'

createApp(IsolationFixture).use(createPinia().use(userIsolationPlugin)).use(createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/', component: { render: () => null } }],
})).mount('#app')

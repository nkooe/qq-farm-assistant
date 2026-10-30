import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '../../src/stores/app'
import AdminUsersFixture from './AdminUsersFixture.vue'
import '../../src/App.vue'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import '../../src/style.css'

const app = createApp(AdminUsersFixture).use(createPinia()).use(createRouter({
  history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }],
}))
app.mount('#app')
useAppStore().applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

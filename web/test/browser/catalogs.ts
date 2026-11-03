import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '../../src/stores/app'
import { useUserStore } from '../../src/stores/user'
import { userIsolationPlugin } from '../../src/stores/user-isolation'
import CatalogFixture from './CatalogFixture.vue'
import '../../src/App.vue'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import '../../src/style.css'

const pinia = createPinia()
pinia.use(userIsolationPlugin)
const app = createApp(CatalogFixture).use(pinia).use(createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/', component: { render: () => null } }],
}))
useUserStore().userInfo = { id: 1000, username: 'test-admin', role: 'admin', card: null, accountLimit: -1 }
useAppStore().applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
app.mount('#app')

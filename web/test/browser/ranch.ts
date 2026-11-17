import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '../../src/stores/app'
import { useUserStore } from '../../src/stores/user'
import { userIsolationPlugin } from '../../src/stores/user-isolation'
import RanchFixture from './RanchFixture.vue'
import '../../src/App.vue'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import '../../src/style.css'

const pinia = createPinia().use(userIsolationPlugin)
const router = createRouter({ history: createMemoryHistory(), routes: [
  ...['', '/personal', '/mall', '/strategy'].map(section => ({
    path: `/ranch${section}`, component: { render: () => null }, meta: { ranchSection: section.slice(1) },
  })),
] })
const app = createApp(RanchFixture).use(pinia).use(router)
useUserStore().userInfo = { id: 1000, username: 'test-admin', role: 'admin', card: null, accountLimit: -1 }
useAppStore().applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
await router.push(`/ranch/${new URLSearchParams(location.search).get('page') || 'personal'}`)
app.mount('#app')

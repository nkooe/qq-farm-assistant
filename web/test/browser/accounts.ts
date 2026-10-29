import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '../../src/stores/app'
import AccountsFixture from './AccountsFixture.vue'
import '../../src/App.vue'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import '../../src/style.css'

const app = createApp(AccountsFixture).use(createPinia()).use(createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/', component: { render: () => null } }],
}))
useAppStore().applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
app.mount('#app')

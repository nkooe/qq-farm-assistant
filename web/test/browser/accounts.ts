import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import AccountsFixture from './AccountsFixture.vue'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import '../../src/style.css'

document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)
createApp(AccountsFixture).use(createPinia()).use(createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/', component: { render: () => null } }],
})).mount('#app')

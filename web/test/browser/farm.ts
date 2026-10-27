import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { useAppStore } from '../../src/stores/app'
import '../../src/App.vue'
import FarmFixture from './FarmFixture.vue'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import '../../src/style.css'

const app = createApp(FarmFixture)
app.use(createPinia())
useAppStore().applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
app.mount('#app')

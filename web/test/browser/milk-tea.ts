import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { useAppStore } from '../../src/stores/app'
import MilkTeaFixture from './MilkTeaFixture.vue'
import '../../src/App.vue'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import '../../src/style.css'

const app = createApp(MilkTeaFixture)
app.use(createPinia())
useAppStore().applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
app.mount('#app')

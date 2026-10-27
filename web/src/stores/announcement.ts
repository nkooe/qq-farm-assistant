import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import api from '@/api'
import { useUserStore } from './user'

export interface Announcement {
  enabled: boolean
  title: string
  content: string
  showOnce: boolean
  updatedAt: number
}

export const useAnnouncementStore = defineStore('announcement', () => {
  const user = useUserStore()
  const current = ref<Announcement | null>(null)
  const visible = ref(false)
  const saving = ref(false)
  const seen = new Set<number>()
  let fetching = false

  watch(() => user.token, () => {
    seen.clear()
    current.value = null
    visible.value = false
  })

  async function refresh() {
    if (!user.token || fetching) return
    fetching = true
    const token = user.token
    try {
      const { data } = await api.get('/api/announcement', { skipErrorToast: true } as any)
      if (token !== user.token || !data?.ok) return
      const next = data.data as Announcement & { shouldShow: boolean }
      if (!next.enabled || !next.content) {
        visible.value = false
        current.value = null
        return
      }
      if (!next.shouldShow || seen.has(next.updatedAt)) return
      current.value = next
      visible.value = true
      seen.add(next.updatedAt)
    } catch { /* Retry on the next check without disrupting the current page. */ }
    finally { fetching = false }
  }

  async function acknowledge() {
    if (!current.value || saving.value) return
    saving.value = true
    const version = current.value.updatedAt
    const token = user.token
    try {
      const { data } = await api.post('/api/announcement/read', { updatedAt: version })
      if (!data?.ok) throw new Error(data?.error || '记录已读失败')
      if (token === user.token && current.value?.updatedAt === version) visible.value = false
    } finally { saving.value = false }
  }

  return { current, visible, saving, refresh, acknowledge }
})

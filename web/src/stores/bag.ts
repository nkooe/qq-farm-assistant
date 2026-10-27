import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export const useBagStore = defineStore('bag', () => {
  const allItems = ref<any[]>([])
  const originalItems = ref<any[]>([])
  const loading = ref(false)
  let requestSequence = 0

  function clearBag() {
    requestSequence++
    loading.value = false
    allItems.value = []
    originalItems.value = []
  }

  const items = computed(() => {
    const hiddenIds = new Set([1, 1001, 1002, 1101, 1011, 1012, 3001, 3002])
    return allItems.value.filter((it: any) => !hiddenIds.has(Number(it.id || 0)))
  })

  const dashboardItems = computed(() => {
    const targetIds = new Set([1011, 1012, 3001, 3002])
    return allItems.value.filter((it: any) => targetIds.has(Number(it.id || 0)))
  })

  async function fetchBag(accountId: string) {
    if (!accountId)
      return
    const requestedId = accountId
    const sequence = ++requestSequence
    loading.value = true
    try {
      const res = await api.get('/api/bag', {
        headers: { 'x-account-id': accountId },
      })
      const acc = useAccountStore()
      const curId = String((acc.currentAccountId as { value?: string })?.value ?? acc.currentAccountId ?? '')
      if (curId !== requestedId || sequence !== requestSequence)
        return
      if (res.data.ok && res.data.data) {
        allItems.value = [...(res.data.data.items || []), ...(res.data.data.systemItems || [])]
        originalItems.value = Array.isArray(res.data.data.originalItems) ? res.data.data.originalItems : []
      }
      else if (res.data && res.data.ok === false && res.data.error) {
        allItems.value = []
        originalItems.value = []
      }
    }
    catch (e) {
      const acc = useAccountStore()
      const curId = String((acc.currentAccountId as { value?: string })?.value ?? acc.currentAccountId ?? '')
      if (curId === requestedId && sequence === requestSequence) {
        allItems.value = []
        originalItems.value = []
      }
      console.error(e)
    }
    finally {
      if (sequence === requestSequence) loading.value = false
    }
  }

  async function useItem(accountId: string, itemId: number, count = 1, uid = 0) {
    const res = await api.post('/api/bag/use', { itemId, count, uid }, {
      headers: { 'x-account-id': accountId },
    })
    return res.data
  }

  async function sellItems(accountId: string, items: Array<{ id: number, count: number, uid?: number }>) {
    const res = await api.post('/api/bag/sell', { items }, {
      headers: { 'x-account-id': accountId },
    })
    return res.data
  }

  async function setLocked(accountId: string, uids: number[], locked: boolean) {
    const res = await api.post('/api/bag/lock', { uids, locked }, { headers: { 'x-account-id': accountId } })
    if (!res.data.ok) throw new Error(res.data.error || '锁定操作失败')
    return res.data.data
  }

  return { items, allItems, originalItems, dashboardItems, loading, fetchBag, clearBag, useItem, sellItems, setLocked }
})

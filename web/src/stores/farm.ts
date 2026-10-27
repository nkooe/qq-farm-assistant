import type { SelectedFarmAction, SelectedFarmResult } from '@/utils/farm-selection'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export interface Land {
  id: number
  plantName?: string
  phaseName?: string
  seedImage?: string
  status: string
  matureInSec: number
  needWater?: boolean
  needWeed?: boolean
  needBug?: boolean
  [key: string]: any
}

export const useFarmStore = defineStore('farm', () => {
  const lands = ref<Land[]>([])
  const seeds = ref<any[]>([])
  const summary = ref<any>({})
  const loading = ref(false)
  const snapshotAt = ref(0)
  let landsGeneration = 0
  let seedsGeneration = 0
  const pendingLands = new Map<string, Promise<boolean>>()

  function clearFarmData() {
    landsGeneration++
    seedsGeneration++
    pendingLands.clear()
    loading.value = false
    lands.value = []
    seeds.value = []
    summary.value = {}
    snapshotAt.value = 0
  }

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }

  function fetchLands(accountId: string, options: { force?: boolean } = {}): Promise<boolean> {
    if (!accountId)
      return Promise.resolve(false)
    const requestedId = String(accountId)
    const pending = pendingLands.get(requestedId)
    if (pending && !options.force)
      return pending
    const request = readLands(requestedId)
    pendingLands.set(requestedId, request)
    // Both outcomes clean up without creating an unhandled rejected promise.
    const cleanup = () => {
      if (pendingLands.get(requestedId) === request)
        pendingLands.delete(requestedId)
    }
    void request.then(cleanup, cleanup)
    return request
  }

  async function readLands(requestedId: string) {
    const generation = ++landsGeneration
    loading.value = true
    try {
      const { data } = await api.get('/api/lands', {
        headers: { 'x-account-id': requestedId },
      })
      if (!isCurrentAccount(requestedId) || generation !== landsGeneration)
        return false
      if (data?.ok && Array.isArray(data.data?.lands)) {
        lands.value = data.data.lands || []
        summary.value = data.data.summary || {}
        snapshotAt.value = performance.now()
        return true
      }
      throw new Error(data?.error || '无法读取土地数据')
    }
    catch (error) {
      if (!isCurrentAccount(requestedId) || generation !== landsGeneration)
        return false
      throw error
    }
    finally {
      if (generation === landsGeneration)
        loading.value = false
    }
  }

  async function fetchSeeds(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const generation = ++seedsGeneration
    const { data } = await api.get('/api/seeds', {
      headers: { 'x-account-id': accountId },
    })
    if (!isCurrentAccount(requestedId) || generation !== seedsGeneration)
      return
    if (data && data.ok)
      seeds.value = data.data || []
  }

  async function operate(accountId: string, opType: string) {
    if (!accountId)
      return
    const { data } = await api.post('/api/farm/operate', { opType }, {
      headers: { 'x-account-id': accountId },
    })
    if (!data?.ok)
      throw new Error(data?.error || '农场操作失败')
  }

  async function fertilizeLand(accountId: string, landId: number) {
    if (!accountId)
      return
    const { data } = await api.post('/api/land/fertilize', { landId }, {
      headers: { 'x-account-id': accountId },
    })
    await fetchLands(accountId, { force: true })
    return data
  }

  async function removePlant(accountId: string, landId: number) {
    if (!accountId)
      return
    const { data } = await api.post('/api/land/remove', { landId }, {
      headers: { 'x-account-id': accountId },
    })
    await fetchLands(accountId, { force: true })
    return data
  }

  async function removeAllPlants(accountId: string) {
    if (!accountId)
      return
    const { data } = await api.post('/api/land/remove-all', {}, {
      headers: { 'x-account-id': accountId },
    })
    if (!data?.ok)
      throw new Error(data?.error || '铲除失败')
    return data
  }

  async function operateSelectedLands(accountId: string, action: SelectedFarmAction, landIds: number[]): Promise<SelectedFarmResult> {
    if (!accountId || !landIds.length)
      throw new Error('请先选择账号和土地')
    const { data } = await api.post('/api/farm/selected', { action, landIds: [...landIds] }, {
      headers: { 'x-account-id': accountId },
      timeout: 70000,
      skipErrorToast: true,
    } as any)
    if (!data?.ok || !data.data)
      throw new Error(data?.error || '选地操作失败')
    return data.data
  }

  return { lands, summary, seeds, loading, snapshotAt, clearFarmData, fetchLands, fetchSeeds, operate, fertilizeLand, removePlant, removeAllPlants, operateSelectedLands }
})

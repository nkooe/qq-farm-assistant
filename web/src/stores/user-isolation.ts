import type { PiniaPluginContext } from 'pinia'
import { watch } from 'vue'
import { useAccountStore } from './account'
import { useUserStore } from './user'

// Account selection and user identity have their own storage-aware reset logic.
const unscopedStores = new Set(['user', 'account', 'app', 'toast'])

export function userIsolationPlugin({ store, pinia }: PiniaPluginContext) {
  if (unscopedStores.has(store.$id))
    return
  const initialState = JSON.stringify(store.$state)
  const user = useUserStore(pinia)
  const account = useAccountStore(pinia)
  watch([() => user.token, () => user.userId, () => store.$id === 'announcement' ? '' : account.currentAccountId], () => {
    const state = JSON.parse(initialState)
    store.$patch((current) => {
      for (const key of Object.keys(current))
        current[key] = state[key]
    })
  }, { flush: 'sync' })
}

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { useAccountStore } from '@/stores/account'
import { useUserStore } from '@/stores/user'

export interface CommerceItemDto {
  id: number
  count: number
  name: string
  image: string
  rarity: number
}

export interface PurchaseLimitDto {
  type: number
  bought: number
  max: number
  remaining: number | null
}

export interface MallGoodsDto {
  id: number
  name: string
  type: number
  rewards: CommerceItemDto[]
  price: CommerceItemDto & { balance: number | null }
  originalPrice?: number | null
  isFree: boolean
  limit: PurchaseLimitDto | null
  isLimited: boolean
  discountText: string
  isDiscounted: boolean
  discountEndTime: number
  available: boolean
  purchasable: boolean
  purchaseStatus?: 'available' | 'sold_out' | 'owned' | 'ad_required' | 'share_required' | 'svip_required' | 'unavailable'
  unavailableReason?: string
}

export interface MallCatalogDto {
  shopId?: number
  membership?: { isSvip: boolean, remainingDays: number } | null
  slotType: number
  serverTime: number
  refreshCountdown: number
  currencies: Array<CommerceItemDto & { balanceKnown: boolean }>
  goods: MallGoodsDto[]
}

export interface MysteryShopDto {
  active: boolean
  serverTime: number
  activeTime?: number
  expireTime?: number
  npc: null | {
    id: number
    reward: CommerceItemDto
    price: CommerceItemDto & { balance: number | null }
    originalPrice: number
    unitPrice: number
    unitOriginalPrice: number
    discountPercent: number
  }
}

export const useCommerceStore = defineStore('commerce', () => {
  const account = useAccountStore()
  const user = useUserStore()
  const mall = ref<MallCatalogDto | null>(null)
  const mallLoading = ref(false)
  const purchasingGoodsId = ref<number | null>(null)
  const error = ref('')
  const notice = ref('')
  let requestVersion = 0
  let mallAccountId = ''

  function isCurrent(version: number, accountId: string) {
    return version === requestVersion && String(account.currentAccountId || '') === accountId
  }

  function clearMessages() {
    error.value = ''
    notice.value = ''
  }

  function reset() {
    requestVersion++
    mall.value = null
    mallAccountId = ''
    mallLoading.value = false
    purchasingGoodsId.value = null
    clearMessages()
  }

  async function fetchMall(accountId: string, slotType = 1, propsShop = false) {
    if (purchasingGoodsId.value !== null)
      return
    const id = String(accountId || '').trim()
    if (!id) {
      reset()
      return
    }
    const version = ++requestVersion
    if (mallAccountId !== id || mall.value?.slotType !== slotType || !!mall.value?.shopId !== propsShop)
      mall.value = null
    mallAccountId = id
    mallLoading.value = true
    clearMessages()
    try {
      const response = await api.get(propsShop ? '/api/props-shop' : '/api/game-mall', {
        headers: { 'x-account-id': id },
        params: propsShop ? undefined : { slotType },
        skipErrorToast: true,
      } as any)
      if (!isCurrent(version, id))
        return
      if (!response.data?.ok)
        throw new Error(getApiErrorMessage(response.data, '商城加载失败'))
      const catalog = response.data.data as MallCatalogDto
      if (!isCurrent(version, id))
        return
      mall.value = catalog
    }
    catch (cause: any) {
      if (!isCurrent(version, id))
        return
      error.value = getApiErrorMessage(cause, '商城加载失败')
    }
    finally {
      if (isCurrent(version, id))
        mallLoading.value = false
    }
  }

  async function purchaseMall(accountId: string, goods: MallGoodsDto, count: number) {
    const id = String(accountId || '').trim()
    if (!id || mallLoading.value || purchasingGoodsId.value !== null)
      return false
    const slotType = mall.value?.slotType || 1
    const propsShop = mall.value?.shopId === 4
    const version = requestVersion
    purchasingGoodsId.value = goods.id
    clearMessages()
    try {
      const response = await api.post(propsShop ? '/api/props-shop/purchase' : '/api/game-mall/purchase', {
        goodsId: goods.id,
        expectedPrice: { id: goods.price.id, count: goods.price.count, rewards: goods.rewards.map(item => ({ id: item.id, count: item.count })) },
        ...(propsShop ? { expectedOffer: { price: { id: goods.price.id, count: goods.price.count }, rewards: goods.rewards.map(item => ({ id: item.id, count: item.count })) } } : {}),
        slotType,
        count,
      }, {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!response.data?.ok)
        throw new Error(getApiErrorMessage(response.data, '购买失败'))
      if (!isCurrent(version, id))
        return null
      const catalog = response.data.data.catalog as MallCatalogDto | null
      if (version === requestVersion)
        mall.value = catalog
      const rewards = (response.data.data.purchase?.rewards || [])
        .map((item: CommerceItemDto) => `${item.name} x${item.count}`)
        .join('、')
      notice.value = (rewards ? `购买成功：${rewards}` : '购买成功') + (!catalog ? '；请刷新商城确认最新状态' : '')
      return true
    }
    catch (cause: any) {
      if (!isCurrent(version, id))
        return null
      if (isCurrent(version, id))
        error.value = getApiErrorMessage(cause, '购买失败')
      return false
    }
    finally {
      if (isCurrent(version, id))
        purchasingGoodsId.value = null
    }
  }

  watch([() => account.currentAccountId, () => user.token, () => user.userId], reset, { flush: 'sync' })

  return {
    mall,
    mallLoading,
    purchasingGoodsId,
    error,
    notice,
    reset,
    clearMessages,
    fetchMall,
    purchaseMall,
  }
})

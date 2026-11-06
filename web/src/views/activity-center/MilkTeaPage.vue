<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import api from '@/api'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import ModalOverlay from '@/components/ui/ModalOverlay.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'
import { clampPurchaseCount, purchaseMaxCount } from '@/utils/purchase-count'
import MilkTeaAutomation from './MilkTeaAutomation.vue'
import MilkTeaContent from './MilkTeaContent.vue'

defineEmits<{ back: [] }>()
const { currentAccountId } = storeToRefs(useAccountStore())
const toast = useToastStore()
const mainPage = ref('shop')
const panel = ref<string | null>(null)
const mainState = ref<any>(null)
const panelState = ref<any>(null)
const activeState = computed(() => panel.value ? panelState.value : mainState.value)
const busy = ref(false)
const dialog = ref<any>(null)
const count = ref(1)
const detailElement = ref<HTMLElement | null>(null)
const confirmElement = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null
let sequence = 0
let filters: any = {}
const tabs: Array<[string, string]> = [['shop', '我的店铺'], ['exchange', '兑换商店'], ['work', '我的工作']]
const panelTitles: Record<string, string> = { settings: '店铺设置', upgrade: '店铺升级', fund: '成长基金', workshop: '奶茶工坊', hireList: '好友雇佣', logs: '营业记录', rank: '排行榜', workItems: '工作事项' }
// 列表型弹窗在宽屏下加宽，每一项横向展开成一行
const widePanels = ['upgrade', 'workshop', 'fund']
const mainWallet = computed(() => walletOf(mainState.value))
const panelWallet = computed(() => walletOf(panelState.value))
const periodText = computed(() => {
  if (!mainState.value)
    return ''
  if (mainState.value.settling)
    return '结算期'
  const date = (value: number) => new Date(value * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' })
  return `${date(mainState.value.startTime)} — ${date(mainState.value.endTime)}`
})
const daysLeft = computed(() => {
  if (!mainState.value?.active || mainState.value.settling || !mainState.value.endTime)
    return ''
  const left = Math.ceil((mainState.value.endTime * 1000 - Date.now()) / 86400000)
  return left <= 0 ? '今天结束' : `还剩 ${left} 天`
})
const maxCount = computed(() => {
  const value = dialog.value
  if (!value)
    return 0
  const goods = value.action === 'exchange' ? activeState.value?.goods?.find((item: any) => item.id === value.input.goodsId) : null
  if (value.action === 'exchange' && (!goods?.available || !activeState.value?.active))
    return 0
  return purchaseMaxCount({
    cap: value.quantity ? value.max : 1,
    limitRemaining: goods?.remaining,
    costs: (value.costs || []).map((cost: any) => ({
      id: cost.uid ? `fruit:${cost.uid}` : cost.id,
      count: Number(cost.count),
      balance: cost.uid ? activeState.value?.fruits?.find((fruit: any) => fruit.uid === cost.uid && !fruit.locked)?.count : activeState.value?.balances?.[cost.id],
    })),
  })
})
const insufficient = computed(() => !!dialog.value && maxCount.value < 1)
watch(maxCount, () => setCount(count.value))
const boostEstimate = computed(() => {
  const shop = activeState.value?.shop
  if (!shop || dialog.value?.action !== 'boost')
    return null
  let remaining = Number(shop.boost_cups_per_use || 0) * count.value
  let token = 0
  let coin = 0
  for (const recipe of [...(activeState.value.recipes || [])].filter(v => v.unlocked).sort((a, b) => Number(!!b.is_advanced) - Number(!!a.is_advanced) || Number(b.token_price) - Number(a.token_price) || Number(a.recipe_id) - Number(b.recipe_id))) {
    const cups = Math.min(remaining, recipe.is_advanced ? Number(shop.drink_cups?.[recipe.recipe_id] || 0) : remaining)
    token += Number(recipe.boostTokenPrice || 0) * cups
    coin += Number(shop.boost_coin_price?.[recipe.recipe_id] || 0) * cups
    remaining -= cups
  }
  return { cups: Number(shop.boost_cups_per_use || 0) * count.value - remaining, token, coin }
})

function walletOf(value: any) {
  if (!value)
    return []
  return [
    { id: 1041, name: '奶茶券' },
    { id: 1042, name: '宣传喇叭' },
    ...(value.balances?.[1004] !== undefined ? [{ id: 1004, name: '钻石' }] : []),
  ].map(item => ({ ...item, count: Number(value.balances?.[item.id] || 0), image: `/game-config/seed_images_named/seed_images/${item.id}.png` }))
}
function rewardsText(values: any[]) {
  return (values || []).map(v => `${v.name} ×${v.count}`).join('、')
}
function select(value: any) {
  dialog.value = value
  setCount(1)
}
function setCount(value: number) {
  count.value = clampPurchaseCount(value, maxCount.value)
}
async function request(action = '', input: any = {}) {
  const account = String(currentAccountId.value || '')
  if (!account || busy.value)
    return
  const target = panel.value === 'workItems' ? 'work' : panel.value || mainPage.value
  const version = ++sequence
  busy.value = true
  try {
    const options = { headers: { 'x-account-id': account }, skipErrorToast: true } as any
    const response = action ? await api.post(`/api/activities/milk-tea/${action}`, input, options) : await api.get('/api/activities/milk-tea', { ...options, params: { ...filters, page: target } })
    if (version !== sequence)
      return
    if (!response.data?.ok)
      throw new Error(response.data?.error || '活动请求失败')
    const data = response.data.data
    const next = action ? data.activity : data
    if (next && next.id !== '2026110101')
      throw new Error('活动回包不匹配')
    if (action) {
      dialog.value = null
      const message = rewardsText(data.rewards) || (action === 'craft' ? `制作成功：${Object.values(data.result.crafted_cups || {}).reduce((a: number, b) => a + Number(b), 0)}杯` : '操作成功')
      if (data.refreshRequired)
        toast.warning(`${message}。请刷新确认最新进度`)
      else toast.success(message)
    }
    if (panel.value)
      panelState.value = next
    else mainState.value = next
  }
  catch (error: any) {
    if (version === sequence) {
      toast.error(error?.response?.data?.error || error?.message || '请求失败')
      if (action) {
        dialog.value = null
        if (panel.value)
          panelState.value = null
        else mainState.value = null
      }
    }
  }
  finally {
    if (version === sequence)
      busy.value = false
  }
}
function navigate(target: string) {
  if (busy.value)
    return
  filters = {}
  if (tabs.some(([key]) => key === target)) {
    panel.value = null
    mainPage.value = target
    mainState.value = null
  }
  else {
    panel.value = target
    panelState.value = null
  }
  void request()
}
function closePanel() {
  if (busy.value)
    return
  panel.value = null
  panelState.value = null
  filters = {}
  void request()
}
function reload(input: any = {}) {
  filters = { ...filters, ...input }
  void request()
}
function confirm() {
  if (!dialog.value || busy.value || insufficient.value || count.value < 1 || count.value > maxCount.value)
    return
  void request(dialog.value.action, { ...dialog.value.input, count: count.value, expectedCosts: dialog.value.costs })
}
watch([panel, dialog], async ([nextPanel, nextDialog], [oldPanel, oldDialog]) => {
  if ((nextPanel || nextDialog) && !oldPanel && !oldDialog)
    returnFocus = document.activeElement as HTMLElement
  await nextTick()
  if (nextDialog)
    confirmElement.value?.focus()
  else if (nextPanel)
    detailElement.value?.focus()
  else if (returnFocus?.isConnected)
    returnFocus.focus()
})
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab')
    return
  const container = event.currentTarget as HTMLElement
  const targets = [...container.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length)
  const first = targets[0]
  const last = targets[targets.length - 1]
  if (!first || (event.shiftKey && (document.activeElement === first || document.activeElement === container)) || (!event.shiftKey && document.activeElement === last)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
  }
}
watch(currentAccountId, () => {
  sequence++
  busy.value = false
  mainState.value = null
  panelState.value = null
  panel.value = null
  dialog.value = null
  mainPage.value = 'shop'
  filters = {}
  void request()
}, { immediate: true })
onUnmounted(() => sequence++)
</script>

<template>
  <div class="milk-shell">
    <div class="tea-page" :inert="!!(panel || dialog)">
      <header class="tea-head">
        <div class="tea-head__lead">
          <NButton secondary circle title="返回活动列表" aria-label="返回活动列表" @click="$emit('back')">
            <template #icon>
              <span class="i-carbon-arrow-left" />
            </template>
          </NButton>
          <div class="tea-head__title">
            <h2>奶茶热销中</h2>
            <p v-if="mainState">
              <span class="i-carbon-calendar" aria-hidden="true" />{{ periodText }}
              <span v-if="daysLeft" class="tea-head__badge">{{ daysLeft }}</span>
              <span v-else-if="!mainState.active" class="tea-head__badge is-ended">已结束</span>
            </p>
          </div>
        </div>
        <NButton secondary circle :loading="busy" title="刷新活动数据" aria-label="刷新活动数据" @click="request()">
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </header>

      <div class="tea-toolbar">
        <NTabs :value="mainPage" type="segment" class="tea-toolbar__tabs" aria-label="奶茶活动页面" @update:value="navigate">
          <NTab v-for="[key, label] in tabs" :key="key" :name="key" :disabled="busy">
            {{ label }}
          </NTab>
        </NTabs>
        <ul v-if="mainWallet.length" class="tea-wallet" aria-label="活动道具余额">
          <li v-for="item in mainWallet" :key="item.id" :title="item.name">
            <img :src="item.image" :alt="item.name"><b>{{ item.count.toLocaleString() }}</b>
          </li>
        </ul>
      </div>

      <main class="tea-scroll">
        <div class="tea-body">
          <MilkTeaAutomation :snapshot="mainState?.automation" />
          <MilkTeaContent v-if="mainState" :key="mainPage" :state="mainState" :page="mainPage" :busy="busy" @navigate="navigate" @operation="request" @confirmation="select" @reload="reload" />
          <div v-else class="empty">
            <span>{{ !currentAccountId ? '请先选择账号' : busy ? '正在加载…' : '暂未获取到活动数据' }}</span><button v-if="currentAccountId && !busy" @click="request()">
              重新加载
            </button>
          </div>
        </div>
      </main>
    </div>
    <ModalOverlay :show="!!panel" :title="panelTitles[panel || ''] || '活动详情'" :busy="busy" @close="closePanel">
      <template v-if="panel">
        <section ref="detailElement" class="tea-detail" :class="{ 'tea-detail--wide': widePanels.includes(panel) }" role="dialog" aria-modal="true" :aria-label="panelTitles[panel]" :inert="!!dialog" tabindex="-1" @keydown="trapFocus" @keydown.esc="closePanel">
          <header>
            <h2>{{ panelTitles[panel] }}</h2>
            <div v-if="panelWallet.length" class="tea-wallet tea-wallet--dialog" aria-label="活动道具余额">
              <span v-for="item in panelWallet" :key="item.id" class="tea-wallet__chip" :title="item.name">
                <img :src="item.image" alt=""><span>{{ item.name }}</span><b>{{ item.count.toLocaleString() }}</b>
              </span>
            </div>
            <button class="close" aria-label="关闭" :disabled="busy" @click="closePanel">
              <span class="i-carbon-close" />
            </button>
          </header>
          <div class="detail-scroll">
            <MilkTeaContent v-if="panelState" :key="panel" :state="panelState" :page="panel" :busy="busy" @navigate="navigate" @operation="request" @confirmation="select" @reload="reload" /><div v-else class="empty">
              <span>{{ busy ? '正在加载…' : '暂未获取到活动数据' }}</span><button v-if="!busy" @click="request()">
                重新加载
              </button>
            </div>
          </div>
        </section>
      </template>
    </ModalOverlay>
    <ModalOverlay :show="!!dialog" :title="dialog?.title || '确认操作'" :busy="busy" @close="dialog = null">
      <template v-if="dialog">
        <section ref="confirmElement" class="tea-dialog" role="dialog" aria-modal="true" :aria-label="dialog.title" tabindex="-1" @keydown="trapFocus" @keydown.esc="!busy && (dialog = null)">
          <header>
            <h2>{{ dialog.title }}</h2><button class="close" aria-label="关闭" :disabled="busy" @click="dialog = null">
              <span class="i-carbon-close" />
            </button>
          </header>
          <div class="confirmation-body">
            <p v-if="dialog.description">
              {{ dialog.description }}
            </p>
            <div v-if="dialog.rewards?.length" class="reward-list">
              <span v-for="reward in dialog.rewards" :key="reward.id"><CommerceItemImage :src="reward.image" :alt="reward.name" size="sm" />{{ reward.name }} ×{{ reward.count * count }}</span>
            </div>
            <div v-if="dialog.quantity" class="quantity">
              <button :disabled="busy || count <= 1" @click="setCount(count - 1)">
                −
              </button><input :value="count" aria-label="数量" inputmode="numeric" :disabled="busy || maxCount === 0" @input="setCount(Number(($event.target as HTMLInputElement).value))"><button :disabled="busy || count >= maxCount" @click="setCount(count + 1)">
                +
              </button><button :disabled="busy || maxCount === 0" @click="setCount(maxCount)">
                最大
              </button>
            </div>
            <p v-if="dialog.input.name">
              {{ dialog.input.name }}
            </p>
            <div v-if="boostEstimate" class="estimate">
              <strong>预计收益 · {{ boostEstimate.cups }}杯</strong><span>奶茶券 ×{{ boostEstimate.token }}</span><span v-if="boostEstimate.coin">金币 ×{{ boostEstimate.coin }}</span>
            </div>
            <div v-for="cost in dialog.costs" :key="String(cost.id) + (cost.uid || '')" class="row">
              <span>{{ cost.name }}</span><strong>×{{ cost.count * count }}</strong>
            </div><p v-if="insufficient" class="error">
              数量不足
            </p>
          </div>
          <footer>
            <button :disabled="busy" @click="dialog = null">
              取消
            </button><button class="primary" :disabled="busy || insufficient" @click="confirm">
              {{ busy ? '处理中…' : '确认' }}
            </button>
          </footer>
        </section>
      </template>
    </ModalOverlay>
  </div>
</template>

<style scoped>
.tea-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px 16px;
  padding: 14px 4px 12px;
  border-bottom: 1px solid var(--ui-border);
}

.tea-head__lead {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}

.tea-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 16px;
}

.tea-toolbar__tabs {
  width: 360px;
}

.tea-head__title {
  min-width: 0;
  flex: 1;
}

.tea-head__title h2 {
  margin: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tea-head__title p {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 3px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.tea-head__badge {
  padding: 0 7px;
  border-radius: 999px;
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}

.tea-head__badge.is-ended {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.tea-wallet {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tea-wallet li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 12px 2px 3px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-surface);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.tea-wallet img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

.tea-wallet b {
  color: var(--ui-ink);
  font-weight: 600;
}

.tea-wallet--compact {
  gap: 6px;
}

.tea-wallet--compact li {
  padding-right: 10px;
  font-size: 12px;
}

.tea-wallet--compact img {
  width: 20px;
  height: 20px;
}

.milk-shell,
.tea-page {
  min-width: 0;
}
.tea-page {
  display: flex;
  flex-direction: column;
  container: tea-page / inline-size;
  color: var(--ui-ink);
}
.tea-scroll {
  padding: 16px 0 32px;
}
.tea-body {
  display: grid;
  min-width: 0;
  gap: 20px;
}
.tea-body > :deep(.tea-automation) {
  margin: 0;
}
.tea-body > :deep(.tea-content) {
  width: 100%;
  padding: 0;
}
.tea-wallet li {
  list-style: none;
}
.tea-detail,
.tea-dialog {
  display: flex;
  position: relative;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: min(88dvh, 960px);
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 18px;
  background: var(--ui-surface);
  color: var(--ui-ink);
  box-shadow: 0 20px 60px #0004;
}
.tea-detail--wide {
  width: min(960px, 100%);
}
.tea-detail > header,
.tea-dialog > header {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
  padding: 18px 54px 16px 20px;
  border-bottom: 1px solid var(--ui-border);
}
.tea-detail h2,
.tea-dialog h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}
.tea-wallet--dialog {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}
.tea-wallet__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
}
.tea-wallet__chip img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}
.close {
  position: absolute;
  top: 12px;
  right: 12px;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: var(--ui-surface-soft);
  color: var(--ui-muted);
}
.close span {
  width: 20px;
  height: 20px;
}
.detail-scroll {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 16px 20px 20px;
  overflow: hidden;
}
.detail-scroll > :deep(.tea-content) {
  min-height: 0;
}
.tea-dialog {
  width: min(440px, 100%);
}
.confirmation-body {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 16px 20px;
}
.confirmation-body > p {
  margin: 0 0 12px;
}
.tea-dialog footer {
  display: flex;
  flex-shrink: 0;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--ui-border);
}
.tea-dialog footer button,
.quantity button,
.empty button {
  min-height: 40px;
  padding: 0 16px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  color: var(--ui-ink);
  background: var(--ui-surface-soft);
}
.tea-dialog footer button.primary {
  background: var(--ui-primary);
  color: #fff;
  border-color: var(--ui-primary);
}
button,
input {
  font: inherit;
}
button {
  cursor: pointer;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
button:focus-visible,
input:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
.empty {
  display: grid;
  place-items: center;
  gap: 16px;
  padding: 48px 16px;
  color: var(--ui-muted);
}
.quantity {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}
.quantity button {
  flex-shrink: 0;
  padding: 0 12px;
}
.quantity input {
  width: 0;
  min-width: 0;
  flex: 1;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-surface-soft);
  color: var(--ui-ink);
  text-align: center;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
}
.reward-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.reward-list > span {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 10px;
  background: var(--ui-surface-soft);
  font-size: 13px;
}
.estimate {
  display: grid;
  gap: 6px;
  margin: 12px 0;
  padding: 12px;
  background: var(--ui-primary-soft);
  border-radius: 12px;
  font-size: 13px;
}
.error {
  color: var(--ui-danger);
}
@media (max-width: 600px) {
  .tea-toolbar__tabs {
    width: 100%;
  }
  .tea-wallet {
    justify-content: flex-start;
  }
  .tea-wallet--dialog {
    margin-left: 0;
  }
  .tea-detail > header {
    flex-direction: column;
    align-items: flex-start;
  }
  .detail-scroll {
    padding: 12px;
  }
}
</style>

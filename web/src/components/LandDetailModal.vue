<script setup lang="ts">
import type { Land } from '@/stores/farm'
import { computed } from 'vue'
import ModalOverlay from '@/components/ui/ModalOverlay.vue'

const props = defineProps<{ land: Land | null, player?: Record<string, any>, connected: boolean }>()
defineEmits<{ close: [] }>()
const info = computed(() => props.land?.landInfo)
const title = computed(() => `土地 #${props.land?.id ?? ''} 详情`)
const rows = [
  { key: 'yieldBonus', name: '产量加成' },
  { key: 'growthReduction', name: '生长时间缩短' },
  { key: 'expBonus', name: '经验加成' },
  { key: 'mutantMultiplier', name: '变异加成' },
  { key: 'resonanceBonus', name: '共鸣经验加成' },
]
function bonus(level: any, key: string) {
  if (!level || !Number.isFinite(level[key]))
    return '待同步'
  return key === 'mutantMultiplier' ? `${level[key]} 倍` : `${level[key]}%`
}
function integer(value: unknown): bigint | null {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    return null
  return /^\d+$/.test(String(value)) ? BigInt(String(value)) : null
}
function balance(cost: any) {
  const key = ({ 1001: 'gold', 1002: 'coupon', 1005: 'goldBean' } as Record<string, string>)[cost.id]
  const owned = props.connected && key ? integer(props.player?.[key]) : null
  const required = integer(cost.count)
  if (required === null)
    return '费用待同步'
  if (owned === null)
    return '余额待同步'
  return owned >= required ? '余额充足' : `还缺 ${(required - owned).toLocaleString('zh-CN')}`
}
</script>

<template>
  <ModalOverlay :show="!!land" :title="title" @close="$emit('close')">
    <section class="land-detail">
      <header>
        <h2>{{ title }}</h2><button type="button" aria-label="关闭土地详情" @click="$emit('close')">
          关闭
        </button>
      </header>
      <template v-if="info">
        <div class="level-comparison">
          <div><img v-if="info.current?.image" :src="info.current.image" alt="" width="64" height="64"><strong>{{ info.current?.name || '未解锁' }}</strong></div>
          <span aria-hidden="true">→</span>
          <div><img v-if="info.next?.image" :src="info.next.image" alt="" width="64" height="64"><strong>{{ info.mode === 'max' ? '已达最高等级' : info.next?.name || '下一等级待同步' }}</strong></div>
        </div>
        <table aria-label="土地加成对比">
          <thead>
            <tr>
              <th scope="col">
                土地加成
              </th><th scope="col">
                当前
              </th><th v-if="info.next" scope="col">
                {{ info.mode === 'unlock' ? '解锁后' : '升级后' }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.key">
              <th scope="row">
                {{ row.name }}
              </th><td>{{ bonus(info.current, row.key) }}</td><td v-if="info.next">
                {{ bonus(info.next, row.key) }}
              </td>
            </tr>
          </tbody>
        </table>
        <template v-if="info.mode !== 'max'">
          <h3>{{ info.mode === 'unlock' ? '解锁条件' : '升级条件' }}</h3>
          <p v-if="info.needLevel !== null">
            角色等级 {{ info.needLevel }} <span>{{ connected && player?.level != null ? `(当前 ${player.level} 级)` : '（等级待同步）' }}</span>
          </p>
          <p v-if="info.prerequisite">
            前置土地 #{{ info.prerequisite.landId }}：{{ connected ? info.prerequisite.met ? '已解锁' : '未解锁' : '待同步' }}
          </p>
          <ul v-if="info.costs?.length" aria-label="所需资源">
            <li v-for="cost in info.costs" :key="cost.id">
              <span>{{ cost.name }} ×{{ cost.count === null ? '待同步' : BigInt(cost.count).toLocaleString('zh-CN') }}</span><span>{{ balance(cost) }}</span>
            </li>
          </ul>
          <p v-if="info.unknown || info.costs?.some((cost: any) => cost.count === null)" class="notice">
            部分条件尚未同步，请刷新土地后核对。
          </p>
          <p class="notice">
            {{ !connected ? '账号未连接，条件待同步。' : info.serverAllowed ? '服务端已允许此操作。' : '服务端尚未允许此操作。' }} 实际条件与费用以游戏服务端为准。
          </p>
        </template>
      </template>
      <p v-else class="notice">
        土地详情尚未同步，请刷新土地后重试。
      </p>
    </section>
  </ModalOverlay>
</template>

<style scoped>
.land-detail {
  width: min(480px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  overflow-y: auto;
  padding: 20px;
  border: 1px solid var(--theme-border);
  border-radius: 16px;
  background: var(--ui-surface);
  color: var(--theme-text);
  font-size: 14px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h2 {
  margin: 0;
  font-size: 18px;
}
h3 {
  margin: 20px 0 8px;
  font-size: 15px;
}
button {
  min-width: 44px;
  min-height: 44px;
  border-radius: 8px;
  padding: 8px;
  background: var(--theme-card-bg);
  color: var(--theme-text);
  cursor: pointer;
}
button:focus-visible {
  outline: 3px solid var(--theme-primary);
  outline-offset: 2px;
}
.level-comparison {
  display: flex;
  justify-content: space-around;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
}
.level-comparison > div {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  text-align: center;
}
img {
  object-fit: contain;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th,
td {
  padding: 10px 4px;
  border-bottom: 1px solid var(--theme-border);
  text-align: right;
}
th:first-child {
  text-align: left;
}
ul {
  list-style: none;
  padding: 0;
}
li {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 0;
  border-bottom: 1px solid var(--theme-border);
}
.notice {
  line-height: 1.7;
  opacity: 0.8;
}
</style>

<script setup lang="ts">
import type { RefreshWxCodesJob } from '@/stores/account'
import AccountHealthPanel from '@/components/AccountHealthPanel.vue'
import AccountModal from '@/components/AccountModal.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { getPlatformClass, getPlatformLabel, hasPendingAccountRecovery } from '@/stores/account'

defineProps<{
  accounts: any[]
  accountsLoading: boolean
  accountsError: string
  currentAccountId: string | number | null | undefined
  userIsAdmin: boolean
  stoppedAccountsCount: number
  isAddAccountDisabled: boolean
  addAccountDisabledReason: string
  isAccountOpsDisabled: boolean
  showModal: boolean
  editingAccount: any
  showDeleteConfirm: boolean
  deleteLoading: boolean
  accountToDelete: any
  showClearStoppedConfirm: boolean
  clearStoppedLoading: boolean
  clearStoppedMessage: string
  refreshWxCodesLoading: boolean
  refreshWxCodesProgress: RefreshWxCodesJob | null
  refreshWxCodesPollWarning: string
  defaultPlanApplyingId: string
}>()

const emit = defineEmits<{
  add: []
  clearStopped: []
  refreshWxCodes: []
  retryRefresh: []
  select: [account: any]
  toggle: [account: any]
  settings: [account: any]
  applyDefaultPlan: [account: any]
  edit: [account: any]
  delete: [account: any]
  saved: []
  refresh: [accountId: string]
  closeModal: []
  closeDeleteConfirm: []
  confirmDelete: []
  closeClearStoppedConfirm: []
  confirmClearStopped: []
}>()

function accountAvatar(acc: any) {
  const direct = String(acc?.avatar || acc?.avatarUrl || acc?.avatar_url || '').trim()
  if (direct)
    return direct
  const qq = String(acc?.uin || acc?.qq || '').trim()
  if (/^\d+$/.test(qq))
    return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`
  return ''
}

function refreshProgressPercent(job: RefreshWxCodesJob | null) {
  if (!job || job.total <= 0)
    return 0
  return Math.min(100, Math.round((job.completed / job.total) * 100))
}

function runtimeLabel(acc: any) {
  const labels: Record<string, string> = { online: '在线', starting: '启动中', reconnecting: '等待重连', stopping: '停止中', failed: '连接失败', stopped: '已停止' }
  return labels[acc.runtimeState] || (acc.running ? '运行中' : '状态未知')
}

function canStop(acc: any) {
  return acc.running || acc.runtimeState === 'starting' || hasPendingAccountRecovery(acc)
}

function refreshStateLabel(job: RefreshWxCodesJob | null, loading: boolean, warning: string) {
  if (warning.includes('登录状态'))
    return '等待重新登录'
  if (!job)
    return warning ? '等待重连' : loading ? '正在提交任务' : '状态未知'
  if (job.state === 'queued')
    return '排队中'
  if (job.state === 'running')
    return '正在刷新'
  if (job.state === 'failed')
    return '任务异常中止'
  if (job.state === 'interrupted')
    return '服务重启，任务已中断'
  return job.failed > 0 ? '已完成，部分账号失败' : '全部完成'
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h3 class="text-lg text-gray-900 font-bold max-sm:text-base dark:text-gray-100">
        账号管理
      </h3>
      <div class="flex flex-wrap gap-2">
        <BaseButton
          variant="outline"
          size="sm"
          :loading="refreshWxCodesLoading"
          :disabled="accountsLoading || accounts.length === 0"
          @click="emit('refreshWxCodes')"
        >
          <div class="i-carbon-renew mr-2" />
          <span class="hidden sm:inline">{{ refreshWxCodesLoading ? '刷新任务进行中' : userIsAdmin ? '刷新全部微信 Code' : '刷新我的微信 Code' }}</span>
          <span class="sm:hidden">{{ refreshWxCodesLoading ? '刷新中' : '刷新Code' }}</span>
        </BaseButton>
        <BaseButton
          v-if="userIsAdmin"
          variant="secondary"
          size="sm"
          :disabled="stoppedAccountsCount === 0"
          @click="emit('clearStopped')"
        >
          <div class="i-carbon-trash-can mr-2" />
          <span class="hidden sm:inline">一键清理</span>
          <span class="sm:hidden">清理</span>
          ({{ stoppedAccountsCount }})
        </BaseButton>
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="isAddAccountDisabled"
          :title="addAccountDisabledReason"
          @click="emit('add')"
        >
          <div class="i-carbon-add mr-2" />
          添加账号
        </BaseButton>
      </div>
    </div>

    <p v-if="accountsError" class="break-words text-sm text-amber-800 dark:text-amber-300" role="status">
      {{ accountsError }}
    </p>

    <section
      v-if="refreshWxCodesLoading || refreshWxCodesProgress || refreshWxCodesPollWarning"
      class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
      :aria-busy="refreshWxCodesLoading"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 flex flex-wrap items-center gap-2">
          <div
            class="i-carbon-renew shrink-0 text-base"
            :class="refreshWxCodesLoading ? 'animate-spin text-blue-600 dark:text-blue-400' : 'text-gray-500'"
            aria-hidden="true"
          />
          <h4 class="text-gray-900 font-semibold dark:text-gray-100">
            微信 Code 刷新任务
          </h4>
          <span class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-200">
            {{ refreshStateLabel(refreshWxCodesProgress, refreshWxCodesLoading, refreshWxCodesPollWarning) }}
          </span>
        </div>
        <span v-if="refreshWxCodesProgress" class="text-sm text-gray-600 tabular-nums dark:text-gray-300">
          {{ refreshWxCodesProgress.completed }} / {{ refreshWxCodesProgress.total }}
        </span>
      </div>

      <template v-if="refreshWxCodesProgress">
        <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {{ refreshStateLabel(refreshWxCodesProgress, refreshWxCodesLoading, refreshWxCodesPollWarning) }}，进度 {{ refreshWxCodesProgress.completed }} / {{ refreshWxCodesProgress.total }}，成功 {{ refreshWxCodesProgress.success }}，失败 {{ refreshWxCodesProgress.failed }}，跳过 {{ refreshWxCodesProgress.skipped }}{{ refreshWxCodesProgress.currentAccount ? `，当前账号 ${refreshWxCodesProgress.currentAccount.name}` : '' }}
        </p>
        <div
          class="mt-3 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"
          role="progressbar"
          :aria-valuenow="refreshProgressPercent(refreshWxCodesProgress)"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="`Code 刷新进度 ${refreshProgressPercent(refreshWxCodesProgress)}%`"
        >
          <div
            class="h-full rounded-full bg-blue-600 transition-[width] duration-200 dark:bg-blue-400"
            :style="{ width: `${refreshProgressPercent(refreshWxCodesProgress)}%` }"
          />
        </div>

        <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-300">
          <span>成功 <strong class="text-green-700 tabular-nums dark:text-green-400">{{ refreshWxCodesProgress.success }}</strong></span>
          <span>失败 <strong class="text-red-700 tabular-nums dark:text-red-400">{{ refreshWxCodesProgress.failed }}</strong></span>
          <span>跳过 <strong class="tabular-nums">{{ refreshWxCodesProgress.skipped }}</strong></span>
        </div>
        <p v-if="refreshWxCodesProgress.currentAccount" class="mt-2 truncate text-sm text-gray-700 dark:text-gray-200">
          当前账号：{{ refreshWxCodesProgress.currentAccount.name }}
        </p>
        <p v-else-if="refreshWxCodesLoading" class="mt-2 text-sm text-gray-500 dark:text-gray-400">
          任务已提交，正在等待服务端开始处理。
        </p>

        <details v-if="refreshWxCodesProgress.results.length" class="mt-3 border-t border-gray-100 pt-3 dark:border-gray-700">
          <summary class="min-h-11 cursor-pointer select-none py-2 text-sm text-gray-700 font-medium dark:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
            查看账号结果（{{ refreshWxCodesProgress.results.length }}）
          </summary>
          <ul class="pt-1 text-sm space-y-1.5">
            <li
              v-for="result in refreshWxCodesProgress.results"
              :key="result.accountId"
              class="grid grid-cols-[16px_minmax(0,1fr)] min-w-0 items-start gap-x-2 gap-y-1 py-1 sm:grid-cols-[16px_minmax(0,1fr)_minmax(0,2fr)]"
            >
              <span
                class="mt-1 shrink-0"
                :class="result.ok ? 'i-carbon-checkmark-filled text-green-600 dark:text-green-400' : 'i-carbon-warning-filled text-red-600 dark:text-red-400'"
                aria-hidden="true"
              />
              <span class="min-w-0 break-words text-gray-700 dark:text-gray-200">{{ result.name }}</span>
              <span v-if="!result.ok" class="col-start-2 min-w-0 break-all text-red-700 sm:col-start-3 dark:text-red-400">失败：{{ result.error || '刷新失败' }}</span>
              <span v-else class="col-start-2 text-gray-500 sm:col-start-3 dark:text-gray-400">成功</span>
            </li>
          </ul>
        </details>
        <p v-if="refreshWxCodesProgress.error" class="mt-3 text-sm text-red-700 dark:text-red-400" role="alert">
          {{ refreshWxCodesProgress.error }}
        </p>
        <BaseButton
          v-if="!refreshWxCodesLoading && refreshWxCodesProgress.retryableAccountIds?.length"
          variant="outline"
          size="sm"
          class="mt-3"
          @click="emit('retryRefresh')"
        >
          重试失败或未执行账号（{{ refreshWxCodesProgress.retryableAccountIds.length }}）
        </BaseButton>
        <p v-if="refreshWxCodesProgress.uncertainAccount" class="mt-2 break-words text-sm text-amber-800 dark:text-amber-300">
          {{ refreshWxCodesProgress.uncertainAccount.name }} 的结果未确认，已从重试名单排除；请先核对该账号状态。
        </p>
      </template>

      <p v-if="refreshWxCodesPollWarning" class="mt-3 flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300" role="status">
        <span class="i-carbon-warning-alt mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          {{ refreshWxCodesPollWarning }}<template v-if="refreshWxCodesPollWarning.includes('登录状态')">。重新登录后回到设置页，将继续查询同一任务。</template><template v-else-if="refreshWxCodesPollWarning.includes('提交结果未确认')">。系统会使用同一请求号重试，不会重复发起刷新。</template><template v-else>。任务继续由服务端处理，页面会自动重试查询进度。</template>
        </span>
      </p>
    </section>

    <div v-if="accountsLoading && accounts.length === 0" class="py-8 text-center text-gray-500">
      <div i-svg-spinners-90-ring-with-bg class="mb-2 inline-block text-2xl" />
      <div>加载中...</div>
    </div>

    <div v-else-if="accounts.length === 0" class="rounded-lg bg-white py-12 text-center shadow dark:bg-gray-800">
      <div i-carbon-user-avatar class="mb-4 inline-block text-4xl text-gray-400" />
      <p class="mb-4 text-gray-500">
        暂无账号
      </p>
      <BaseButton
        variant="text"
        size="sm"
        :disabled="isAddAccountDisabled"
        :title="addAccountDisabledReason"
        @click="emit('add')"
      >
        立即添加
      </BaseButton>
    </div>

    <div v-else class="grid grid-cols-1 gap-4 lg:grid-cols-3 sm:grid-cols-2 xl:grid-cols-4">
      <div
        v-for="acc in accounts"
        :key="acc.id"
        class="cursor-pointer border rounded-lg bg-white p-3 shadow transition-all duration-200 dark:bg-gray-800 sm:p-4"
        :class="String(currentAccountId) === String(acc.id)
          ? 'ring-2'
          : 'border-transparent'"
        :style="String(currentAccountId) === String(acc.id)
          ? { borderColor: 'var(--theme-primary)', backgroundColor: 'rgba(var(--theme-primary-rgb, 59, 130, 246), 0.1)' }
          : {}"
        @click="emit('select', acc)"
      >
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div class="min-w-0 flex flex-1 items-center gap-3">
            <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-100 sm:h-12 sm:w-12 dark:bg-gray-700">
              <img v-if="accountAvatar(acc)" :src="accountAvatar(acc)" class="h-full w-full object-cover">
              <div v-else class="i-carbon-user text-xl text-gray-400 sm:text-2xl" />
            </div>
            <div class="min-w-0 flex-1">
              <h4 class="truncate text-base font-bold sm:text-lg">
                {{ acc.name || acc.nick || acc.id }}
              </h4>
              <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
                <span
                  v-if="acc.platform"
                  class="rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight"
                  :class="getPlatformClass(acc.platform)"
                >
                  {{ getPlatformLabel(acc.platform) }}
                </span>
                <span class="truncate text-xs text-gray-500 sm:text-sm">
                  {{ acc.uin || '未绑定' }}
                </span>
              </div>
            </div>
          </div>
          <div class="flex items-center justify-end gap-2 sm:flex-col sm:items-end">
            <span class="flex items-center gap-1 text-xs text-gray-500 sm:hidden">
              <div class="h-2 w-2 rounded-full" :class="acc.running ? 'bg-green-500' : 'bg-gray-300'" />
              {{ runtimeLabel(acc) }}
            </span>
            <BaseButton
              variant="secondary"
              size="sm"
              class="min-w-20 whitespace-nowrap border rounded-full shadow-sm transition-all duration-500 ease-in-out active:scale-95"
              :class="canStop(acc) ? 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 focus:ring-red-500 active:border-red-300 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/30 dark:focus:ring-red-500 dark:active:border-red-700' : 'border-green-200 bg-green-50 text-green-600 hover:bg-green-100 focus:ring-green-500 active:border-green-300 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/30 dark:focus:ring-green-500 dark:active:border-green-700'"
              :disabled="!canStop(acc) && isAccountOpsDisabled"
              :title="!canStop(acc) && isAccountOpsDisabled ? '账号已到期，无法启动账号' : ''"
              @click="emit('toggle', acc)"
            >
              <div :class="canStop(acc) ? 'i-carbon-stop-filled' : 'i-carbon-play-filled'" class="mr-1" />
              {{ hasPendingAccountRecovery(acc) ? '取消恢复' : canStop(acc) ? '停止' : '启动' }}
            </BaseButton>
          </div>
        </div>

        <AccountHealthPanel v-if="acc.platform === 'qq' || acc.yybOpenid || hasPendingAccountRecovery(acc)" :account="acc" class="mt-3" />

        <div class="mt-3 flex items-center justify-between border-t border-gray-100 pt-3 sm:mt-4 dark:border-gray-700 sm:pt-4">
          <div class="hidden items-center gap-2 text-sm text-gray-500 sm:flex">
            <span class="flex items-center gap-1">
              <div class="h-2 w-2 rounded-full" :class="acc.running ? 'bg-green-500' : 'bg-gray-300'" />
              {{ runtimeLabel(acc) }}
            </span>
          </div>

          <div class="flex flex-1 justify-end gap-1 sm:flex-initial sm:gap-2">
            <BaseButton
              :data-testid="`apply-default-plan-${acc.id}`"
              variant="ghost"
              class="min-h-[36px] min-w-[36px] !p-2"
              :loading="defaultPlanApplyingId === String(acc.id)"
              :disabled="!!defaultPlanApplyingId"
              title="应用默认方案"
              @click="emit('applyDefaultPlan', acc)"
            >
              <div v-if="defaultPlanApplyingId !== String(acc.id)" i-carbon-document-import />
            </BaseButton>
            <BaseButton
              variant="ghost"
              class="min-h-[36px] min-w-[36px] !p-2"
              title="设置"
              @click="emit('settings', acc)"
            >
              <div i-carbon-settings />
            </BaseButton>
            <BaseButton
              variant="ghost"
              class="min-h-[36px] min-w-[36px] !p-2"
              title="编辑"
              @click="emit('edit', acc)"
            >
              <div i-carbon-edit />
            </BaseButton>
            <BaseButton
              variant="ghost"
              class="min-h-[36px] min-w-[36px] text-red-500 !p-2 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300"
              title="删除"
              @click="emit('delete', acc)"
            >
              <div i-carbon-trash-can />
            </BaseButton>
          </div>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <AccountModal
        :show="showModal"
        :edit-data="editingAccount"
        @close="emit('closeModal')"
        @saved="emit('saved')"
        @refresh="(accountId: string) => emit('refresh', accountId)"
      />

      <ConfirmModal
        :show="showDeleteConfirm"
        :loading="deleteLoading"
        title="删除账号"
        :message="accountToDelete ? `确定要删除账号 ${accountToDelete.name || accountToDelete.id} 吗?` : ''"
        confirm-text="删除"
        type="danger"
        @close="!deleteLoading && emit('closeDeleteConfirm')"
        @cancel="!deleteLoading && emit('closeDeleteConfirm')"
        @confirm="emit('confirmDelete')"
      />

      <ConfirmModal
        :show="showClearStoppedConfirm"
        :loading="clearStoppedLoading"
        title="一键清理已停止账号"
        :message="clearStoppedMessage"
        confirm-text="确认清理"
        type="danger"
        @close="!clearStoppedLoading && emit('closeClearStoppedConfirm')"
        @cancel="!clearStoppedLoading && emit('closeClearStoppedConfirm')"
        @confirm="emit('confirmClearStopped')"
      />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import type { EditForm, UserInfo } from '@/composables/useAdminUsers'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import ModalOverlay from '@/components/ui/ModalOverlay.vue'

defineProps<{
  users: UserInfo[]
  filteredUsers: UserInfo[]
  usersLoading: boolean
  currentUserId: number | null
  currentUsername: string
  activeUsersCount: number
  expiredUsersCount: number
  adminUsersCount: number
  renewUserLoading: boolean
  editLoading: boolean
  selectedUserIds: Set<number>
  allVisibleUsersSelected: boolean
  someVisibleUsersSelected: boolean
  selectableUserCount: number
  deleteSelectedUsersLoading: boolean
}>()

defineEmits<{
  clearExpired: []
  refresh: []
  openRenewUser: [user: UserInfo]
  openEditUser: [user: UserInfo]
  toggleUserStatus: [user: UserInfo]
  deleteUser: [user: UserInfo]
  renewUser: []
  editUser: []
  toggleSelectUser: [userId: number]
  toggleSelectAllUsers: []
  clearUserSelection: []
  deleteSelectedUsers: []
}>()

const showRenewUserModal = defineModel<boolean>('showRenewUserModal', { required: true })
const userSearchQuery = defineModel<string>('userSearchQuery', { required: true })
const pendingRenewUser = defineModel<UserInfo | null>('pendingRenewUser', { required: true })
const renewUserCardCode = defineModel<string>('renewUserCardCode', { required: true })
const showEditModal = defineModel<boolean>('showEditModal', { required: true })
const editForm = defineModel<EditForm>('editForm', { required: true })

function closeRenewUserModal() {
  showRenewUserModal.value = false
  pendingRenewUser.value = null
  renewUserCardCode.value = ''
}

const statusLabels: Record<UserInfo['accessStatus'], string> = {
  normal: '正常', banned: '已封禁', expired: '已到期', card_required: '待激活', deleting: '清理中',
}

function isPermanent(user: UserInfo) {
  return user.role === 'admin' || user.card?.isPermanent === true || user.card?.days === -1 || user.card?.durationValue === -1
}

function dateParts(timestamp: number) {
  const date = new Date(timestamp)
  return {
    iso: date.toISOString(),
    date: date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    time: date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }
}
</script>

<template>
  <section class="user-management" aria-label="用户管理">
    <div class="user-section-header">
      <div>
        <h3 class="text-lg font-bold">用户管理</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">管理用户、账号额度与访问权限</p>
      </div>
      <div class="user-header-actions">
        <span class="user-current-account">当前账号 <strong>{{ currentUsername }}</strong></span>
        <BaseButton variant="outline" size="sm" class="min-h-11" :disabled="!expiredUsersCount || usersLoading" @click="$emit('clearExpired')">
          清理到期用户
        </BaseButton>
        <BaseButton variant="primary" size="sm" class="min-h-11" :loading="usersLoading" @click="$emit('refresh')">刷新</BaseButton>
      </div>
    </div>

    <div class="user-stat-grid">
      <div class="user-stat"><span>用户总数</span><strong>{{ users.length }}<small>人</small></strong></div>
      <div class="user-stat" data-testid="active-user-count"><span>正常用户</span><strong>{{ activeUsersCount }}<small>人</small></strong></div>
      <div class="user-stat"><span>管理员</span><strong>{{ adminUsersCount }}<small>人</small></strong></div>
      <div class="user-stat" :class="{ 'has-expired': expiredUsersCount > 0 }"><span>已到期</span><strong>{{ expiredUsersCount }}<small>人</small></strong></div>
    </div>

    <div class="user-list-shell">
      <div class="user-list-toolbar">
        <div class="user-search">
          <BaseInput v-model="userSearchQuery" label="搜索用户" type="search" placeholder="搜索 ID 或用户名" clearable />
        </div>
        <span class="user-result-count">共 {{ users.length }} 人<span v-if="userSearchQuery.trim()"> · 找到 {{ filteredUsers.length }} 人</span></span>
      </div>

      <div class="user-selection-bar">
        <label class="user-mobile-select">
          <input type="checkbox" :checked="allVisibleUsersSelected" :indeterminate="someVisibleUsersSelected && !allVisibleUsersSelected" :disabled="!selectableUserCount || usersLoading || deleteSelectedUsersLoading" aria-label="选择当前列表普通用户" @change="$emit('toggleSelectAllUsers')">
          选择当前列表
        </label>
        <span role="status" class="user-selection-count">已选 <strong>{{ selectedUserIds.size }}</strong> 人</span>
        <template v-if="selectedUserIds.size">
          <button type="button" class="user-toolbar-button" :disabled="deleteSelectedUsersLoading" @click="$emit('clearUserSelection')">取消选择</button>
          <button type="button" class="user-toolbar-button danger" :disabled="deleteSelectedUsersLoading" @click="$emit('deleteSelectedUsers')">删除所选</button>
        </template>
      </div>

      <div v-if="usersLoading" class="user-list-empty" role="status">
        <span class="i-svg-spinners-90-ring-with-bg text-2xl" aria-hidden="true" />
        <p>正在加载用户…</p>
      </div>
      <div v-else class="user-table-wrap">
        <table class="user-table" aria-label="用户列表">
          <colgroup><col class="col-select"><col class="col-id"><col class="col-name"><col class="col-role"><col class="col-quota"><col class="col-date"><col class="col-date"><col class="col-status"><col class="col-actions"></colgroup>
          <thead>
            <tr>
              <th scope="col" class="user-check-cell">
                <label class="user-check-label">
                  <input type="checkbox" :checked="allVisibleUsersSelected" :indeterminate="someVisibleUsersSelected && !allVisibleUsersSelected" :disabled="!selectableUserCount || deleteSelectedUsersLoading" aria-label="全选当前列表普通用户" @change="$emit('toggleSelectAllUsers')">
                </label>
              </th>
              <th scope="col">ID</th><th scope="col">用户名</th><th scope="col">角色</th><th scope="col">额度</th>
              <th scope="col">注册时间</th><th scope="col">到期时间</th><th scope="col">状态</th><th scope="col" class="user-action-heading">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in filteredUsers" :key="user.id" :data-user-id="user.id" :class="{ 'is-selected': selectedUserIds.has(user.id) }">
              <td class="user-check-cell">
                <label class="user-check-label" :title="user.role === 'admin' ? '管理员账号不参与批量操作' : `选择 ${user.username}`">
                  <input type="checkbox" :checked="selectedUserIds.has(user.id)" :disabled="user.role === 'admin' || user.id === currentUserId || deleteSelectedUsersLoading" :aria-label="`选择用户 ${user.username}（ID ${user.id}）`" @change="$emit('toggleSelectUser', user.id)">
                </label>
              </td>
              <td class="user-id" data-label="ID">{{ user.id }}</td>
              <td class="user-name" data-label="用户名"><span>{{ user.username }}</span><span v-if="user.id === currentUserId" class="user-self-label">当前</span></td>
              <td data-label="角色"><span class="user-role" :class="{ 'is-admin': user.role === 'admin' }">{{ user.role === 'admin' ? '管理员' : '用户' }}</span></td>
              <td class="user-quota" data-label="额度"><template v-if="user.role === 'admin'"><span class="user-unlimited">无限制</span></template><template v-else><strong>{{ user.accountLimit }}</strong><small>个账号</small></template></td>
              <td class="user-date" data-label="注册时间"><time :datetime="dateParts(user.createdAt).iso"><span>{{ dateParts(user.createdAt).date }}</span><small>{{ dateParts(user.createdAt).time }}</small></time></td>
              <td class="user-date" data-label="到期时间">
                <span v-if="isPermanent(user)" class="user-permanent">永久有效</span>
                <time v-else-if="user.card?.expiresAt" :datetime="dateParts(user.card.expiresAt).iso" :class="{ 'is-expired': user.accessStatus === 'expired' }"><span>{{ dateParts(user.card.expiresAt).date }}</span><small>{{ dateParts(user.card.expiresAt).time }}</small></time>
                <span v-else class="text-gray-500 dark:text-gray-400">未设置</span>
              </td>
              <td data-label="状态"><span class="user-status" :data-status="user.accessStatus">{{ statusLabels[user.accessStatus] }}</span></td>
              <td class="user-actions-cell" data-label="操作">
                <div class="user-row-actions">
                  <button v-if="user.role !== 'admin' && user.accessStatus !== 'deleting'" type="button" class="user-row-button renew" @click="$emit('openRenewUser', user)">续费</button>
                  <button v-if="user.accessStatus !== 'deleting'" type="button" class="user-row-button edit" @click="$emit('openEditUser', user)">编辑</button>
                  <button v-if="user.role !== 'admin' && user.accessStatus !== 'deleting'" type="button" class="user-row-button" :class="user.card?.enabled === false ? 'renew' : 'ban'" @click="$emit('toggleUserStatus', user)">{{ user.card?.enabled === false ? '解封' : '封禁' }}</button>
                  <button v-if="user.role !== 'admin' && user.id !== currentUserId" type="button" class="user-row-button danger" @click="$emit('deleteUser', user)">{{ user.accessStatus === 'deleting' ? '重试删除' : '删除' }}</button>
                </div>
              </td>
            </tr>
            <tr v-if="!filteredUsers.length" class="user-empty-row"><td colspan="9"><div class="user-list-empty"><span class="i-carbon-user-multiple text-3xl text-gray-400" aria-hidden="true" /><p>{{ userSearchQuery.trim() ? '没有找到匹配的用户' : '暂无用户' }}</p><button v-if="userSearchQuery.trim()" type="button" class="user-toolbar-button" @click="userSearchQuery = ''">清空搜索</button></div></td></tr>
          </tbody>
        </table>
      </div>
      <div class="user-list-footer"><span>已显示 {{ filteredUsers.length }} 位用户</span><span>管理员账号不参与批量操作</span></div>
    </div>

    <ModalOverlay
      :show="showRenewUserModal"
      title="用户续费"
      :busy="renewUserLoading"
      @close="closeRenewUserModal"
    >
      <div class="ui-dialog-panel max-w-md w-full">
        <h2 class="ui-dialog-header text-lg font-bold">
          用户续费：{{ pendingRenewUser?.username }}
        </h2>

        <div class="ui-dialog-body space-y-4">
          <div class="rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:bg-gray-900/40 dark:text-gray-300">
            填写卡密，为此用户续费。
          </div>

          <BaseInput
            v-model="renewUserCardCode"
            label="续费卡密"
            type="text"
            placeholder="输入卡密编码"
          />
        </div>

        <div class="ui-dialog-footer">
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="renewUserLoading"
            @click="closeRenewUserModal"
          >
            取消
          </BaseButton>
          <BaseButton
            variant="primary"
            size="sm"
            :loading="renewUserLoading"
            @click="$emit('renewUser')"
          >
            下一步
          </BaseButton>
        </div>
      </div>
    </ModalOverlay>

    <ModalOverlay
      :show="showEditModal"
      title="编辑用户"
      :busy="editLoading"
      @close="showEditModal = false"
    >
      <div class="ui-dialog-panel max-w-lg w-full">
        <header class="ui-dialog-header">
          <h2 class="text-lg font-bold">编辑用户</h2>
          <button type="button" class="ui-dialog-close" aria-label="关闭编辑用户" :disabled="editLoading" @click="showEditModal = false">
            <span class="i-carbon-close text-xl" />
          </button>
        </header>
        <div class="ui-dialog-body space-y-4">
          <div class="rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:bg-gray-900/40 dark:text-gray-300">
            用户名创建后固定；可重置密码、调整时长与账号额度。
          </div>

          <div class="border border-gray-200 rounded-xl p-4 space-y-3 dark:border-gray-700">
            <div class="text-sm text-gray-900 font-semibold dark:text-gray-100">
              基本信息
            </div>
            <div>
              <label class="mb-1 block text-sm text-gray-700 font-medium dark:text-gray-300">
                用户名
              </label>
              <BaseInput
                :model-value="editForm.newUsername"
                disabled
              />
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                用户名是固定身份标识，删除后永久停用。
              </p>
            </div>
            <div>
              <label class="mb-1 block text-sm text-gray-700 font-medium dark:text-gray-300">
                新密码
              </label>
              <BaseInput
                v-model="editForm.password"
                type="password"
                placeholder="输入新密码（留空则不修改）"
              />
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                至少 6 位，含字母与数字等两类字符。
              </p>
            </div>
          </div>

          <div class="grid gap-3 md:grid-cols-2">
            <div class="border border-gray-200 rounded-xl p-4 dark:border-gray-700">
              <div class="text-sm text-gray-900 font-semibold dark:text-gray-100">
                账号额度
              </div>
              <BaseInput
                v-model.number="editForm.accountLimit"
                type="number"
                min="1"
                label="可添加账号数"
                placeholder="可添加的账号数量"
              />
              <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
                普通用户最多可添加的农场账号数量。
              </p>
            </div>
            <div class="border border-gray-200 rounded-xl p-4 dark:border-gray-700">
              <div class="text-sm text-gray-900 font-semibold dark:text-gray-100">
                时效设置
              </div>
              <div class="mt-3 flex items-center gap-3">
                <input
                  v-model="editForm.isPermanent"
                  type="checkbox"
                  class="border-gray-300 rounded text-blue-600 focus:ring-blue-500"
                >
                <span class="text-sm text-gray-600 dark:text-gray-400">永久有效</span>
              </div>
              <input
                v-if="!editForm.isPermanent"
                v-model="editForm.expiresAt"
                type="datetime-local"
                class="mt-3 w-full border border-gray-200 rounded-lg bg-white px-3 py-2 text-sm dark:border-gray-600 focus:border-blue-500 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
            </div>
          </div>
        </div>
        <div class="ui-dialog-footer">
          <BaseButton variant="secondary" size="sm" :disabled="editLoading" @click="showEditModal = false">
            取消
          </BaseButton>
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="editLoading"
            @click="$emit('editUser')"
          >
            {{ editLoading ? '保存中...' : '保存' }}
          </BaseButton>
        </div>
      </div>
    </ModalOverlay>
  </section>
</template>
<style scoped>
.user-management { display: grid; gap: 20px; color: var(--theme-text); min-width: 0; }
.user-section-header, .user-header-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.user-current-account { color: var(--muted-text); font-size: 13px; margin-right: 4px; }
.user-current-account strong { margin-left: 6px; color: var(--theme-text); }
.user-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.user-stat { display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--theme-border); border-radius: 14px; background: var(--surface-1); padding: 16px 20px; }
.user-stat > span { font-size: 13px; color: var(--muted-text); }
.user-stat strong { font-size: 26px; font-weight: 650; line-height: 1.2; font-variant-numeric: tabular-nums; }
.user-stat small { margin-left: 6px; font-size: 12px; font-weight: 400; color: var(--muted-text); }
.user-stat.has-expired strong { color: #b45309; }
.user-list-shell { border: 1px solid var(--theme-border); border-radius: 16px; background: var(--surface-1); overflow: hidden; min-width: 0; }
.user-list-toolbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; padding: 20px 20px 12px; }
.user-search { width: min(100%, 360px); }
.user-result-count { color: var(--muted-text); font-size: 13px; padding-bottom: 13px; white-space: nowrap; }
.user-selection-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; min-height: 48px; padding: 0 20px 8px; }
.user-selection-count { color: var(--muted-text); font-size: 13px; margin-right: 8px; }
.user-selection-count strong { color: var(--theme-primary); font-variant-numeric: tabular-nums; }
.user-mobile-select { display: none; }
.user-toolbar-button, .user-row-button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; border-radius: 7px; padding: 6px 10px; font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: background-color 160ms; }
.user-toolbar-button { color: var(--theme-text); background: var(--surface-2); }
.user-toolbar-button:hover { background: var(--surface-3); }
.user-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
.user-table .col-select { width: 4%; }.col-id { width: 6%; }.col-name { width: 15%; }.col-role { width: 7%; }.col-quota { width: 8%; }.col-date { width: 14%; }.col-status { width: 9%; }.col-actions { width: 23%; }
.user-table th { background: var(--surface-2); padding: 13px 12px; border-top: 1px solid var(--theme-border); border-bottom: 1px solid var(--theme-border); font-size: 12px; font-weight: 600; color: var(--muted-text); white-space: nowrap; }
.user-table td { padding: 16px 12px; border-bottom: 1px solid var(--theme-border); vertical-align: middle; }
.user-table tbody tr { transition: background-color 160ms; }
.user-table tbody tr:hover { background: color-mix(in srgb, var(--theme-primary) 4%, transparent); }
.user-table tbody tr.is-selected { background: color-mix(in srgb, var(--theme-primary) 8%, transparent); }
.user-table tbody tr:last-child td { border-bottom: 0; }
.user-table .user-check-cell { padding: 0 2px 0 10px; width: 44px; }
.user-check-label { display: inline-flex; align-items: center; justify-content: center; width: 40px; min-height: 44px; cursor: pointer; }
.user-check-label:has(input:disabled) { cursor: not-allowed; }
.user-management input[type="checkbox"] { width: 17px; height: 17px; accent-color: var(--theme-primary); cursor: inherit; border-radius: 4px; }
.user-id { color: var(--muted-text); font-size: 13px; font-variant-numeric: tabular-nums; }
.user-name { font-weight: 600; overflow-wrap: anywhere; }
.user-self-label { display: inline-block; margin-left: 8px; padding: 1px 5px; border-radius: 4px; background: var(--surface-3); color: var(--muted-text); font-size: 10px; font-weight: 400; vertical-align: middle; }
.user-role { display: inline-flex; padding: 3px 9px; border-radius: 6px; background: var(--surface-3); color: var(--theme-text); font-size: 12px; white-space: nowrap; }
.user-role.is-admin { background: #f3e8ff; color: #7e22ce; }
.user-quota { font-variant-numeric: tabular-nums; white-space: nowrap; }
.user-quota strong { font-weight: 600; }.user-quota small { font-size: 11px; color: var(--muted-text); margin-left: 4px; }
.user-unlimited, .user-permanent { color: var(--muted-text); font-size: 13px; white-space: nowrap; }
.user-date time { display: inline-flex; flex-direction: column; gap: 3px; font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 13px; }
.user-date time small { font-size: 11px; color: var(--muted-text); }
.user-date time.is-expired, .user-date time.is-expired small { color: #b45309; }
.user-status { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 999px; font-size: 12px; line-height: 1.5; font-weight: 500; white-space: nowrap; }
.user-status::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.user-status[data-status="normal"] { color: #047857; background: #ecfdf5; }
.user-status[data-status="banned"] { color: #b91c1c; background: #fef2f2; }
.user-status[data-status="expired"] { color: #b45309; background: #fffbeb; }
.user-status[data-status="card_required"], .user-status[data-status="deleting"] { color: #475569; background: #f1f5f9; }
.user-action-heading { text-align: right; }.user-row-actions { display: flex; justify-content: flex-end; gap: 2px; }
.user-row-button { min-height: 40px; padding: 6px 8px; }.user-row-button:hover { background: var(--surface-3); }
.renew { color: #047857; }.edit { color: #1d4ed8; }.ban { color: #a16207; }.danger { color: #b91c1c; }
.user-list-footer { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 20px; font-size: 12px; color: var(--muted-text); border-top: 1px solid var(--theme-border); background: var(--surface-2); }
.user-list-empty { display: flex; min-height: 200px; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--muted-text); }
.user-toolbar-button:focus-visible, .user-row-button:focus-visible, .user-check-label input:focus-visible, .user-mobile-select input:focus-visible { outline: 2px solid var(--theme-primary); outline-offset: 3px; }
.user-toolbar-button:disabled { opacity: .5; cursor: not-allowed; }
.dark .user-management { color-scheme: dark; }
.dark .user-role.is-admin { background: #3b2356; color: #e9d5ff; }
.dark .user-status[data-status="normal"] { color: #6ee7b7; background: #123f35; }
.dark .user-status[data-status="banned"] { color: #fca5a5; background: #4c252b; }
.dark .user-status[data-status="expired"] { color: #fcd34d; background: #46351b; }
.dark .user-status[data-status="card_required"], .dark .user-status[data-status="deleting"] { color: #cbd5e1; background: #334155; }
.dark .renew { color: #6ee7b7; }.dark .edit { color: #93c5fd; }.dark .ban { color: #fcd34d; }.dark .danger { color: #fca5a5; }
.dark .user-date time.is-expired, .dark .user-date time.is-expired small, .dark .user-stat.has-expired strong { color: #fcd34d; }
@media (max-width: 1100px) {
  .user-table, .user-table tbody { display: block; width: 100%; }
  .user-table thead, .user-table colgroup { display: none; }
  .user-table-wrap { padding: 0 16px 16px; }
  .user-table tbody { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .user-table tbody tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 12px; position: relative; border: 1px solid var(--theme-border); border-radius: 12px; padding: 18px; align-content: start; }
  .user-table td { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 0; border: 0; min-width: 0; }
  .user-table td[data-label]::before { content: attr(data-label); color: var(--muted-text); font-size: 11px; font-weight: 400; }
  .user-table .user-check-cell { position: absolute; top: 8px; right: 8px; padding: 0; }
  .user-table td.user-id { grid-column: 1 / -1; padding-right: 44px; }
  .user-table td.user-id { flex-direction: row; align-items: center; }
  .user-table td.user-id::before { display: inline; content: 'ID'; font-size: 11px; }
  .user-table td.user-name { grid-column: 1 / -1; flex-direction: row; align-items: center; flex-wrap: wrap; padding-right: 30px; font-size: 17px; margin-top: -10px; }
  .user-table td.user-name::before { display: none; }
  .user-self-label { margin-left: 0; }.user-table td.user-quota { display: block; }.user-table td.user-quota::before { display: block; margin-bottom: 6px; }
  .user-table .user-actions-cell { grid-column: 1 / -1; padding-top: 12px; border-top: 1px solid var(--theme-border); }.user-table td.user-actions-cell::before { display: none; }
  .user-row-actions { justify-content: flex-start; gap: 8px; flex-wrap: wrap; }.user-row-button { min-height: 44px; padding: 8px 12px; background: var(--surface-2); }
  .user-mobile-select { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 13px; margin-right: auto; cursor: pointer; }
  .user-toolbar-button { min-height: 44px; }.user-selection-bar { padding-bottom: 12px; }
  .user-table .user-empty-row { grid-column: 1 / -1; display: block; }.user-table .user-empty-row td { display: block; }
}
@media (max-width: 640px) {
  .user-management { gap: 16px; }.user-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }.user-stat { padding: 14px 16px; }.user-stat strong { font-size: 24px; }
  .user-current-account { display: none; }.user-header-actions { gap: 8px; }.user-section-header { align-items: flex-start; }
  .user-list-toolbar { padding: 16px 16px 8px; flex-wrap: wrap; gap: 8px; }.user-search { width: 100%; }.user-result-count { padding: 0; }
  .user-selection-bar { padding: 0 16px 12px; gap: 4px; }.user-selection-count { margin-right: 0; }
  .user-table tbody { grid-template-columns: minmax(0, 1fr); }.user-table-wrap { padding: 0 12px 12px; }
  .user-list-footer { padding: 12px 16px; font-size: 11px; }
}
@media (prefers-reduced-motion: reduce) { .user-table tbody tr, .user-toolbar-button, .user-row-button { transition: none; } }
</style>

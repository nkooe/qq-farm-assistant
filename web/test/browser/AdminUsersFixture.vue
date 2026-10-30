<script setup lang="ts">
import { onMounted, reactive } from 'vue'
import AdminUserPanel from '../../src/components/admin/AdminUserPanel.vue'
import AdminUserConfirmModals from '../../src/components/admin/AdminUserConfirmModals.vue'
import { useAdminUsers } from '../../src/composables/useAdminUsers'
import { useUserStore } from '../../src/stores/user'
import ToastContainer from '../../src/components/ToastContainer.vue'
import AdminPanel from '../../src/views/AdminPanel.vue'

useUserStore().userInfo = { id: 1000, username: 'admin', role: 'admin', card: null, accountLimit: 2 }
const state = reactive(useAdminUsers())
const fullAdmin = new URLSearchParams(location.search).has('full')
onMounted(() => { if (!fullAdmin) void state.fetchUsers() })
</script>
<template>
  <main class="mx-auto min-w-0 w-full max-w-7xl px-3 py-6 sm:px-6">
    <AdminPanel v-if="fullAdmin" />
    <AdminUserPanel v-else
      v-bind="state" :selectable-user-count="state.selectableUsers.length"
      v-model:show-renew-user-modal="state.showRenewUserModal" v-model:pending-renew-user="state.pendingRenewUser"
      v-model:renew-user-card-code="state.renewUserCardCode" v-model:show-edit-modal="state.showEditModal"
      v-model:edit-form="state.editForm" v-model:user-search-query="state.userSearchQuery"
      @clear-expired="state.openClearExpiredUsersConfirm" @refresh="state.fetchUsers"
      @open-renew-user="state.openRenewUserModal" @open-edit-user="state.openEditModal"
      @toggle-user-status="state.requestToggleUserStatus" @delete-user="state.requestDeleteUser"
      @renew-user="state.requestRenewUser" @edit-user="state.handleEdit"
      @toggle-select-user="state.toggleSelectUser" @toggle-select-all-users="state.toggleSelectAllUsers"
      @clear-user-selection="state.clearUserSelection" @delete-selected-users="state.requestDeleteSelectedUsers"
    />
    <AdminUserConfirmModals
      v-if="!fullAdmin"
      v-bind="state"
      v-model:show-toggle-user-status-confirm="state.showToggleUserStatusConfirm" v-model:pending-toggle-user="state.pendingToggleUser"
      v-model:show-delete-user-confirm="state.showDeleteUserConfirm" v-model:pending-delete-user="state.pendingDeleteUser"
      v-model:show-renew-user-confirm="state.showRenewUserConfirm" v-model:pending-renew-user="state.pendingRenewUser"
      v-model:show-clear-expired-users-confirm="state.showClearExpiredUsersConfirm"
      v-model:show-edit-user-confirm="state.showEditUserConfirm" v-model:selected-user="state.selectedUser"
      v-model:show-delete-selected-users-confirm="state.showDeleteSelectedUsersConfirm"
      @toggle-user-status="state.confirmToggleUserStatus" @delete-user="state.confirmDeleteUser"
      @renew-user="state.confirmRenewUser" @clear-expired-users="state.confirmClearExpiredUsers"
      @edit-user="state.confirmEditUser" @delete-selected-users="state.confirmDeleteSelectedUsers"
    />
    <ToastContainer />
  </main>
</template>

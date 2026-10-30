import type { UserCard } from '@/stores/user'
import { computed, ref, watch } from 'vue'
import api from '@/api'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

export interface UserInfo {
  id: number
  username: string
  role: string
  createdAt: number
  accessStatus: 'normal' | 'banned' | 'expired' | 'card_required' | 'deleting'
  card: UserCard | null
  accountLimit: number
}

export interface EditForm {
  newUsername: string
  password: string
  accountLimit: number
  expiresAt: string
  isPermanent: boolean
}

function formatDateTimeLocal(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

export function useAdminUsers() {
  const userStore = useUserStore()
  const toast = useToastStore()

  const showDeleteUserConfirm = ref(false)
  const pendingDeleteUser = ref<UserInfo | null>(null)
  const deleteUserLoading = ref(false)
  const showRenewUserModal = ref(false)
  const showRenewUserConfirm = ref(false)
  const pendingRenewUser = ref<UserInfo | null>(null)
  const renewUserCardCode = ref('')
  const renewUserLoading = ref(false)
  const showToggleUserStatusConfirm = ref(false)
  const pendingToggleUser = ref<UserInfo | null>(null)
  const toggleUserStatusLoading = ref(false)
  const showClearExpiredUsersConfirm = ref(false)
  const clearExpiredUsersLoading = ref(false)
  const showEditUserConfirm = ref(false)
  const selectedUserIds = ref<Set<number>>(new Set())
  const pendingDeleteUsers = ref<UserInfo[]>([])
  const showDeleteSelectedUsersConfirm = ref(false)
  const deleteSelectedUsersLoading = ref(false)
  const deleteSelectedUsersError = ref('')

  const users = ref<UserInfo[]>([])
  const usersLoading = ref(false)
  const userSearchQuery = ref('')
  const showEditModal = ref(false)
  const selectedUser = ref<UserInfo | null>(null)
  const editForm = ref<EditForm>({
    newUsername: '',
    password: '',
    accountLimit: 2,
    expiresAt: '',
    isPermanent: false,
  })
  const editLoading = ref(false)

  const currentUserId = computed(() => userStore.userId)
  const currentUsername = computed(() => userStore.username)
  const activeUsersCount = computed(() =>
    users.value.filter(user => user.role !== 'admin' && user.accessStatus === 'normal').length,
  )
  const expiredUsersCount = computed(() =>
    users.value.filter(user => user.role !== 'admin' && user.card?.expiresAt && user.card.expiresAt < Date.now()).length,
  )
  const adminUsersCount = computed(() =>
    users.value.filter(user => user.role === 'admin').length,
  )
  const filteredUsers = computed(() => {
    const query = userSearchQuery.value.trim().toLowerCase()
    if (!query)
      return users.value

    return users.value.filter(user => (String(user.id).includes(query) || user.username.toLowerCase().includes(query)))
  })
  const selectableUsers = computed(() => filteredUsers.value.filter(user => user.role !== 'admin' && user.id !== currentUserId.value))
  const selectedUsers = computed(() => users.value.filter(user => selectedUserIds.value.has(user.id)))
  const allVisibleUsersSelected = computed(() => selectableUsers.value.length > 0 && selectableUsers.value.every(user => selectedUserIds.value.has(user.id)))
  const someVisibleUsersSelected = computed(() => selectableUsers.value.some(user => selectedUserIds.value.has(user.id)))
  function clearUserSelection() { selectedUserIds.value = new Set() }
  function toggleSelectUser(userId: number) {
    if (!selectableUsers.value.some(user => user.id === userId)) return
    const next = new Set(selectedUserIds.value)
    if (next.has(userId)) next.delete(userId)
    else next.add(userId)
    selectedUserIds.value = next
  }
  function toggleSelectAllUsers() {
    selectedUserIds.value = allVisibleUsersSelected.value ? new Set() : new Set(selectableUsers.value.map(user => user.id))
  }
  watch(userSearchQuery, clearUserSelection)
  watch(users, () => {
    const allowed = new Set(users.value.filter(user => user.role !== 'admin' && user.id !== currentUserId.value).map(user => user.id))
    selectedUserIds.value = new Set([...selectedUserIds.value].filter(id => allowed.has(id)))
  })

  async function fetchUsers() {
    usersLoading.value = true
    try {
      const result = await userStore.getAllUsers()
      if (result.ok) {
        users.value = result.data
      }
      else {
        toast.error(result.error || '获取用户列表失败')
      }
    }
    catch (e: any) {
      toast.error(e.message || '获取用户列表失败')
    }
    finally {
      usersLoading.value = false
    }
  }

  function requestToggleUserStatus(user: UserInfo) {
    pendingToggleUser.value = user
    showToggleUserStatusConfirm.value = true
  }

  async function confirmToggleUserStatus() {
    if (!pendingToggleUser.value)
      return

    toggleUserStatusLoading.value = true
    try {
      const user = pendingToggleUser.value
      const wasBanned = user.card?.enabled === false
      const updates: Partial<UserCard> = { enabled: wasBanned }
      const result = await userStore.updateUser(user.id, updates, {
        confirmed: true,
      })
      if (result.ok) {
        toast.success(wasBanned ? '用户已解封' : '用户已封禁')
        showToggleUserStatusConfirm.value = false
        pendingToggleUser.value = null
        await fetchUsers()
      }
      else {
        toast.error(result.error || '操作失败')
      }
    }
    catch (e: any) {
      toast.error(e.message || '操作失败')
    }
    finally {
      toggleUserStatusLoading.value = false
    }
  }

  function requestDeleteUser(user: UserInfo) {
    pendingDeleteUser.value = user
    showDeleteUserConfirm.value = true
  }

  function requestDeleteSelectedUsers() {
    pendingDeleteUsers.value = selectedUsers.value.filter(user => user.role !== 'admin' && user.id !== currentUserId.value)
    if (!pendingDeleteUsers.value.length) return
    deleteSelectedUsersError.value = ''
    showDeleteSelectedUsersConfirm.value = true
  }

  async function confirmDeleteSelectedUsers() {
    if (deleteSelectedUsersLoading.value || !pendingDeleteUsers.value.length) return
    deleteSelectedUsersLoading.value = true
    deleteSelectedUsersError.value = ''
    const failed: UserInfo[] = []
    let deleted = 0
    try {
      for (const user of pendingDeleteUsers.value) {
        try {
          const result = await userStore.deleteUser(user.id, { confirmed: true })
          if (!result.ok) throw new Error(result.error || '删除失败')
          deleted++
          selectedUserIds.value.delete(user.id)
          users.value = users.value.filter(item => item.id !== user.id)
        }
        catch (error: any) {
          failed.push(user)
          deleteSelectedUsersError.value = error?.response?.data?.error || error?.message || '删除失败'
        }
      }
      if (deleted) toast.success(`已删除 ${deleted} 个用户及其全部数据`)
      pendingDeleteUsers.value = failed
      if (failed.length) deleteSelectedUsersError.value = `${failed.length} 个用户未删除：${deleteSelectedUsersError.value}。可重试下列用户。`
      else showDeleteSelectedUsersConfirm.value = false
      await fetchUsers()
    }
    finally { deleteSelectedUsersLoading.value = false }
  }

  async function confirmDeleteUser() {
    if (!pendingDeleteUser.value)
      return

    deleteUserLoading.value = true
    try {
      const result = await userStore.deleteUser(pendingDeleteUser.value.id, {
        confirmed: true,
      })
      if (result.ok) {
        toast.success('用户删除成功')
        showDeleteUserConfirm.value = false
        pendingDeleteUser.value = null
        await fetchUsers()
      }
      else {
        toast.error(result.error || '删除用户失败')
      }
    }
    catch (e: any) {
      toast.error(e.message || '删除用户失败')
    }
    finally {
      deleteUserLoading.value = false
    }
  }

  function openRenewUserModal(user: UserInfo) {
    pendingRenewUser.value = user
    renewUserCardCode.value = ''
    showRenewUserModal.value = true
  }

  function requestRenewUser() {
    if (!pendingRenewUser.value)
      return

    if (!renewUserCardCode.value.trim()) {
      toast.warning('请输入续费卡密')
      return
    }

    showRenewUserConfirm.value = true
  }

  async function confirmRenewUser() {
    if (!pendingRenewUser.value)
      return

    const cardCode = renewUserCardCode.value.trim()
    if (!cardCode) {
      toast.warning('请输入续费卡密')
      return
    }

    renewUserLoading.value = true
    try {
      const result = await userStore.renewUser(pendingRenewUser.value.id, cardCode, {
        confirmed: true,
      })
      if (result.ok) {
        toast.success('用户续费成功')
        showRenewUserConfirm.value = false
        showRenewUserModal.value = false
        pendingRenewUser.value = null
        renewUserCardCode.value = ''
        await fetchUsers()
      }
      else {
        toast.error(result.error || '用户续费失败')
      }
    }
    catch (e: any) {
      toast.error(e?.response?.data?.error || e?.message || '用户续费失败')
    }
    finally {
      renewUserLoading.value = false
    }
  }

  function openClearExpiredUsersConfirm() {
    if (expiredUsersCount.value === 0) {
      toast.warning('当前没有可清理的到期用户')
      return
    }

    showClearExpiredUsersConfirm.value = true
  }

  async function confirmClearExpiredUsers() {
    clearExpiredUsersLoading.value = true
    try {
      const result = await userStore.clearExpiredUsers({
        confirmed: true,
      })
      if (result.ok) {
        const deletedCount = Number(result.deletedCount || 0)
        toast.success(deletedCount > 0 ? `已清理 ${deletedCount} 个到期用户` : '没有需要清理的到期用户')
        showClearExpiredUsersConfirm.value = false
        await fetchUsers()
      }
      else {
        toast.error(result.error || '清理到期用户失败')
      }
    }
    catch (e: any) {
      toast.error(e.message || '清理到期用户失败')
    }
    finally {
      clearExpiredUsersLoading.value = false
    }
  }

  function openEditModal(user: UserInfo) {
    selectedUser.value = user
    editForm.value = {
      newUsername: user.username,
      password: '',
      accountLimit: user.accountLimit || 2,
      expiresAt: user.card?.expiresAt ? formatDateTimeLocal(user.card.expiresAt) : '',
      isPermanent: user.card?.days === -1,
    }
    showEditModal.value = true
  }

  async function handleEdit() {
    if (!selectedUser.value)
      return

    showEditUserConfirm.value = true
  }

  async function confirmEditUser() {
    if (!selectedUser.value)
      return

    editLoading.value = true
    try {
      const expiresAtValue = editForm.value.isPermanent
        ? null
        : (editForm.value.expiresAt ? new Date(editForm.value.expiresAt).getTime() : null)

      const updateData: Record<string, any> = {
        accountLimit: editForm.value.accountLimit,
        expiresAt: expiresAtValue,
        isPermanent: editForm.value.isPermanent,
        confirmed: true,
      }

      if (editForm.value.newUsername && editForm.value.newUsername !== selectedUser.value.username)
        updateData.newUsername = editForm.value.newUsername

      if (editForm.value.password)
        updateData.password = editForm.value.password

      const res = await api.post(`/api/admin/users/${selectedUser.value.id}/edit`, updateData)

      if (res.data.ok) {
        toast.success('用户信息已更新')
        showEditUserConfirm.value = false
        showEditModal.value = false
        await fetchUsers()
      }
      else {
        toast.error(res.data.error || '更新失败')
      }
    }
    catch (e: any) {
      toast.error(e?.response?.data?.error || e?.message || '更新失败')
    }
    finally {
      editLoading.value = false
    }
  }

  return {
    selectedUserIds,
    selectedUsers,
    selectableUsers,
    allVisibleUsersSelected,
    someVisibleUsersSelected,
    clearUserSelection,
    toggleSelectUser,
    toggleSelectAllUsers,
    pendingDeleteUsers,
    showDeleteSelectedUsersConfirm,
    deleteSelectedUsersLoading,
    deleteSelectedUsersError,
    requestDeleteSelectedUsers,
    confirmDeleteSelectedUsers,
    showDeleteUserConfirm,
    pendingDeleteUser,
    deleteUserLoading,
    showRenewUserModal,
    showRenewUserConfirm,
    pendingRenewUser,
    renewUserCardCode,
    renewUserLoading,
    showToggleUserStatusConfirm,
    pendingToggleUser,
    toggleUserStatusLoading,
    showClearExpiredUsersConfirm,
    clearExpiredUsersLoading,
    showEditUserConfirm,
    users,
    usersLoading,
    userSearchQuery,
    filteredUsers,
    showEditModal,
    selectedUser,
    editForm,
    editLoading,
    currentUsername,
    currentUserId,
    activeUsersCount,
    expiredUsersCount,
    adminUsersCount,
    fetchUsers,
    requestToggleUserStatus,
    confirmToggleUserStatus,
    requestDeleteUser,
    confirmDeleteUser,
    openRenewUserModal,
    requestRenewUser,
    confirmRenewUser,
    openClearExpiredUsersConfirm,
    confirmClearExpiredUsers,
    openEditModal,
    handleEdit,
    confirmEditUser,
  }
}

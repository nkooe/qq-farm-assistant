<script setup lang="ts">
import ConfirmModal from '@/components/ConfirmModal.vue'

const props = defineProps<{
  systemConfigSaving: boolean
  loginLinksSaving: boolean
}>()

const emit = defineEmits<{
  resetSystem: []
  saveSystem: []
  resetLoginLinks: []
}>()

const showResetSystemConfirm = defineModel<boolean>('showResetSystemConfirm', { required: true })
const showSaveSystemConfirm = defineModel<boolean>('showSaveSystemConfirm', { required: true })
const showResetLoginLinksConfirm = defineModel<boolean>('showResetLoginLinksConfirm', { required: true })

function closeSystemResetConfirm() {
  if (!props.systemConfigSaving)
    showResetSystemConfirm.value = false
}

function closeSystemSaveConfirm() {
  if (!props.systemConfigSaving)
    showSaveSystemConfirm.value = false
}

function closeLoginLinksResetConfirm() {
  if (!props.loginLinksSaving)
    showResetLoginLinksConfirm.value = false
}

</script>

<template>
  <ConfirmModal
    :show="showResetSystemConfirm"
    title="确认重置系统配置"
    message="确定要将系统配置恢复为默认值吗？这会立即覆盖当前的服务器地址、客户端版本、平台与系统设置。"
    type="danger"
    :loading="systemConfigSaving"
    confirm-text="确认重置"
    cancel-text="取消"
    @confirm="emit('resetSystem')"
    @close="closeSystemResetConfirm"
    @cancel="closeSystemResetConfirm"
  />

  <ConfirmModal
    :show="showSaveSystemConfirm"
    title="确认保存系统配置"
    message="确定要保存当前系统配置吗？保存后会立刻影响服务器地址、客户端版本、平台和系统参数。"
    type="danger"
    :loading="systemConfigSaving"
    confirm-text="确认保存"
    cancel-text="取消"
    @confirm="emit('saveSystem')"
    @close="closeSystemSaveConfirm"
    @cancel="closeSystemSaveConfirm"
  />

  <ConfirmModal
    :show="showResetLoginLinksConfirm"
    title="确认恢复登录页默认设置"
    message="确定要恢复登录页默认设置吗？自定义图标、标题、提示语、购买链接和QQ群链接都会被覆盖，已上传的本地图标也会被删除。"
    type="danger"
    :loading="loginLinksSaving"
    confirm-text="确认恢复"
    cancel-text="取消"
    @confirm="emit('resetLoginLinks')"
    @close="closeLoginLinksResetConfirm"
    @cancel="closeLoginLinksResetConfirm"
  />

</template>

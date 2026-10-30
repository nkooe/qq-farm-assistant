import { StorageSerializers, useStorage } from '@vueuse/core'
import axios from 'axios'
import { useToastStore } from '@/stores/toast'

const tokenRef = useStorage('admin_token', '')
const accountIdRef = useStorage('current_account_id', '')
const accountOwnerRef = useStorage<number | null>('current_account_owner', null, undefined, { serializer: StorageSerializers.object })
const userInfoRef = useStorage<{ id?: number } | null>('user_info', null, undefined, {
  serializer: StorageSerializers.object,
})

const api = axios.create({
  baseURL: '/',
  timeout: 20000,
})

interface RequestIdentity {
  farmIdentity?: { token: string, userId: number | null }
}

function isStaleRequest(config: RequestIdentity | undefined) {
  const identity = config?.farmIdentity
  return identity && (identity.token !== tokenRef.value || identity.userId !== (userInfoRef.value?.id ?? null))
}

let lastNetworkToastAt = 0
function showNetworkToast(message: string) {
  const now = Date.now()
  if (now - lastNetworkToastAt < 5000)
    return
  lastNetworkToastAt = now
  useToastStore().error(message)
}

api.interceptors.request.use((config) => {
  ;(config as typeof config & RequestIdentity).farmIdentity = {
    token: tokenRef.value,
    userId: userInfoRef.value?.id ?? null,
  }
  if (/^\/api\/(activity-center|activities|solar-calendar|illustrated\/snapshot|illustrated\/claim)/.test(config.url || ''))
    config.timeout = Math.max(config.timeout || 0, 180000)
  const token = tokenRef.value
  if (token) {
    config.headers['x-admin-token'] = token
  }
  const accountId = accountOwnerRef.value === userInfoRef.value?.id ? accountIdRef.value : ''
  if (accountId && !config.headers['x-account-id']) {
    config.headers['x-account-id'] = accountId
  }
  return config
}, error => Promise.reject(error))

api.interceptors.response.use((response) => {
  if (isStaleRequest(response.config as typeof response.config & RequestIdentity))
    throw new axios.CanceledError('用户会话已切换')
  return response
}, (error) => {
  if (isStaleRequest(error.config))
    return Promise.reject(new axios.CanceledError('用户会话已切换'))
  if (axios.isCancel(error) || error?.code === 'ERR_CANCELED') {
    return Promise.reject(error)
  }

  const toast = useToastStore()

  const rejection = error.response?.data?.errorType
  const accessRejected = error.response?.status === 403
    && ['expired', 'card_required', 'banned', 'invalid_role'].includes(rejection)
  if (error.config?.skipErrorToast && error.response?.status !== 401 && !accessRejected)
    return Promise.reject(error)

  if (error.response) {
    if (accessRejected && !window.location.pathname.includes('/login')) {
      tokenRef.value = ''
      window.location.href = '/login'
      toast.warning(error.response.data?.error || '请重新登录')
    }
    else if (error.response.status === 401) {
      if (!window.location.pathname.includes('/login')) {
        tokenRef.value = ''
        window.location.href = '/login'
        toast.warning('登录已过期，请重新登录')
      }
    }
    else if (error.response.status >= 500) {
      const backendError = String(error.response.data?.error || error.response.data?.message || '')
      if (backendError === '账号未运行' || backendError === 'API Timeout' || backendError === 'Request Timeout') {
        return Promise.reject(error)
      }
      toast.error(getApiErrorMessage(error, `服务器错误（${error.response.status}），请稍后重试`))
    }
    else {
      toast.error('请求失败，请联系管理员')
    }
  }
  else if (error.request) {
    showNetworkToast(getApiErrorMessage(error, '网络错误，无法连接到服务器'))
  }
  else {
    toast.error(getApiErrorMessage(error))
  }

  return Promise.reject(error)
})

export default api

export function getApiErrorMessage(error: any, fallback = '操作失败，请稍后重试'): string {
  const status = Number(error?.response?.status || 0)
  const code = String(error?.code || '').toUpperCase()
  const responseData = error?.response?.data
  const raw = String(
    responseData?.errorMessage
      || responseData?.error
      || responseData?.message
      || (typeof responseData === 'string' ? responseData : '')
      || error?.message
      || '',
  ).trim()

  // 网关/axios 的英文原文不能直接泄漏到中文界面，尤其是“刷新全部微信 Code”。
  if (status === 502 || /(?:status code|bad gateway)\s*502/i.test(raw))
    return '微信 Code 服务暂时不可用（502），请检查应用宝/微信 Code 服务后重试'
  if (status === 504 || /(?:status code|gateway timeout)\s*504/i.test(raw))
    return '刷新微信 Code 请求超时（504），请稍后重试'
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(raw))
    return '刷新微信 Code 请求超时，请稍后重试'
  if (!error?.response && error?.request)
    return '网络错误，无法连接到服务器，请检查服务状态后重试'

  const axiosStatus = raw.match(/^request failed with status code\s+(\d+)$/i)
  if (axiosStatus) {
    const failedStatus = Number(axiosStatus[1])
    if (failedStatus === 502)
      return '微信 Code 服务暂时不可用（502），请检查应用宝/微信 Code 服务后重试'
    if (failedStatus === 504)
      return '刷新微信 Code 请求超时（504），请稍后重试'
    return `服务器处理失败（${failedStatus}），请稍后重试`
  }

  // 已经是后端返回的中文诊断时保留它；未知英文错误使用稳定的中文兜底。
  if (raw && !/^(?:network error|bad gateway|gateway timeout|request timeout)$/i.test(raw))
    return raw
  return fallback
}

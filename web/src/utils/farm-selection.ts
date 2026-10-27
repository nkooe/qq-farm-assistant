import type { Land } from '@/stores/farm'

export type SelectedFarmAction = 'fertilizeNormal' | 'fertilizeOrganic' | 'clear' | 'harvest' | 'remove'

export const selectedFarmActions: Array<{ action: SelectedFarmAction, label: string }> = [
  { action: 'fertilizeNormal', label: '普通肥' },
  { action: 'fertilizeOrganic', label: '有机肥' },
  { action: 'clear', label: '务农' },
  { action: 'harvest', label: '收获' },
  { action: 'remove', label: '铲除' },
]

export function rootLandId(land: Land): number {
  return land.occupiedByMaster && Number(land.masterLandId) > 0 ? Number(land.masterLandId) : land.id
}

export function landDisabledReason(land: Land | undefined, action: SelectedFarmAction): string {
  if (!land || !land.unlocked || land.status === 'locked')
    return '土地未解锁'
  if (land.status === 'empty')
    return '没有作物'
  if (action === 'remove')
    return ''
  if (action === 'harvest')
    return land.status === 'harvestable' ? '' : '作物尚未成熟'
  if (action === 'clear')
    return land.status !== 'dead' && (land.needWater || land.needWeed || land.needBug || land.needGoldenBug) ? '' : '无需务农'
  if (land.status !== 'growing' || !(land.matureInSec > 0))
    return '作物已成熟或不能施肥'
  if (action === 'fertilizeOrganic' && land.organicFertilizerRemaining != null && land.organicFertilizerRemaining <= 0)
    return '有机肥次数已用完'
  return ''
}

export interface SelectedFarmResult {
  action: SelectedFarmAction
  requestedLandIds: number[]
  targetLandIds: number[]
  successLandIds: number[]
  skipped: Array<{ id: number, reason: string }>
  failedLandIds: number[]
  unconfirmedLandIds: number[]
  uncertain: boolean
  error: string
  fertilizerRemainingSec: number | null
  fertilizerConsumedSec: number | null
}

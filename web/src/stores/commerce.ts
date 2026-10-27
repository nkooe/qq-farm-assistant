// Shared item shape used by activity rewards, without loading the commerce store.
export interface CommerceItemDto {
  id: number
  count: number
  name: string
  image: string
  rarity: number
}

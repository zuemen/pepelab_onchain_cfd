/**
 * PepeIncentives.claimTierReward 要求 `positionIds` **嚴格遞增**。
 *
 * 合約用這個前提來保證同一個倉位不會被重複計入累計 notional（否則把同一個 id
 * 送 100 次就能刷到最高等級）。不符合就 revert `PositionIdsNotSorted`。
 *
 * `getUserPositions` 沒有承諾任何順序，也沒有承諾不重複，所以排序 + 去重必須在
 * 前端做——不做的話成功與否完全取決於 storage 的巧合。
 */
export function toStrictlyIncreasingIds(ids: readonly bigint[]): bigint[] {
  const unique = new Map<string, bigint>()
  for (const id of ids) unique.set(id.toString(), id)
  return [...unique.values()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

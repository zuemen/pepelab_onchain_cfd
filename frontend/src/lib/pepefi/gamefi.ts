// Shared bits of the GameFi state that more than one page needs.
//
// The lab keeps its progression in localStorage under `pepefi:gamefi:*` and
// owns the writes. Anything outside the lab that needs to *read* that state
// goes through here rather than reaching for the raw key, so the key names
// stay in one place.

export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const

const UNLOCKED_SKINS_KEY = 'pepefi:gamefi:unlocked_skins'

/**
 * How many cosmetics the player owns — skins drawn from the gacha or bought
 * outright. Feeds the 收藏家 achievement, which used to count equipped items
 * from the retired ITEMS inventory.
 */
export function ownedCosmeticsCount(): number {
  try {
    const raw = localStorage.getItem(UNLOCKED_SKINS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

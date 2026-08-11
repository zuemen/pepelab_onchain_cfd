// The lab's progression state — level, XP, mount, unlocked/equipped skins —
// and the one-time migration off the unscoped keys it used to live under.
//
// Until this module, all six fields were stored under a single global key
// per field (`pepefi:gamefi:level`, etc.), shared by every wallet that ever
// connected in this browser. Switching wallets did not reset the lab: a
// second address inherited the first one's level, mount, and skins. Reads
// and writes now go through `loadGamefiState`/`saveGamefiState`, both keyed
// by address, so the lab is per-wallet the way the avatar and display name
// already were (see pepeAvatar.ts, displayName.ts).

export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const

export interface GamefiState {
  balance:       number
  xp:            number
  level:         number
  activeMount:   string
  unlockedSkins: string[]
  activeSkin:    string
}

export const GAMEFI_DEFAULT_STATE: GamefiState = {
  balance:       5000,
  xp:            0,
  level:         1,
  activeMount:   'leaf',
  unlockedSkins: [],
  activeSkin:    '',
}

const LEGACY_KEYS: Record<keyof GamefiState, string> = {
  balance:       'pepefi:gamefi:balance',
  xp:            'pepefi:gamefi:xp',
  level:         'pepefi:gamefi:level',
  activeMount:   'pepefi:gamefi:active_mount',
  unlockedSkins: 'pepefi:gamefi:unlocked_skins',
  activeSkin:    'pepefi:gamefi:active_skin',
}

const MIGRATED_FLAG = 'pepefi:gamefi:migrated_per_wallet'

const scopedKey = (addr: string, field: keyof GamefiState) =>
  `pepefi:gamefi:${addr.toLowerCase()}:${field}`

/**
 * Runs once per browser, the first time any address loads the lab after this
 * shipped. The old global keys held whichever wallet last played — there is
 * no way to recover which address they "really" belong to, so they attach to
 * the first address that asks and every other address starts clean. That is
 * a one-time, unrecoverable progress loss for whichever wallets do not win
 * the race, which is acceptable here: this is testnet paper-trading state,
 * not funds.
 */
function migrateLegacyStateOnce(addr: string): void {
  try {
    if (localStorage.getItem(MIGRATED_FLAG)) return
    for (const field of Object.keys(LEGACY_KEYS) as (keyof GamefiState)[]) {
      const legacyValue = localStorage.getItem(LEGACY_KEYS[field])
      if (legacyValue !== null) localStorage.setItem(scopedKey(addr, field), legacyValue)
      localStorage.removeItem(LEGACY_KEYS[field])
    }
    localStorage.setItem(MIGRATED_FLAG, '1')
  } catch { /* best effort — storage unavailable */ }
}

export function loadGamefiState(addr: string): GamefiState {
  try {
    migrateLegacyStateOnce(addr)

    const balance = localStorage.getItem(scopedKey(addr, 'balance'))
    const xp = localStorage.getItem(scopedKey(addr, 'xp'))
    const level = localStorage.getItem(scopedKey(addr, 'level'))
    const activeMount = localStorage.getItem(scopedKey(addr, 'activeMount'))
    const unlockedSkinsRaw = localStorage.getItem(scopedKey(addr, 'unlockedSkins'))
    const activeSkin = localStorage.getItem(scopedKey(addr, 'activeSkin'))

    return {
      balance:       balance !== null ? Number(balance) : GAMEFI_DEFAULT_STATE.balance,
      xp:            xp !== null ? Number(xp) : GAMEFI_DEFAULT_STATE.xp,
      level:         level !== null ? Number(level) : GAMEFI_DEFAULT_STATE.level,
      activeMount:   activeMount ?? GAMEFI_DEFAULT_STATE.activeMount,
      unlockedSkins: unlockedSkinsRaw ? (JSON.parse(unlockedSkinsRaw) as string[]) : GAMEFI_DEFAULT_STATE.unlockedSkins,
      activeSkin:    activeSkin ?? GAMEFI_DEFAULT_STATE.activeSkin,
    }
  } catch {
    return GAMEFI_DEFAULT_STATE
  }
}

export function saveGamefiState(addr: string, state: GamefiState): void {
  try {
    localStorage.setItem(scopedKey(addr, 'balance'), state.balance.toString())
    localStorage.setItem(scopedKey(addr, 'xp'), state.xp.toString())
    localStorage.setItem(scopedKey(addr, 'level'), state.level.toString())
    localStorage.setItem(scopedKey(addr, 'activeMount'), state.activeMount)
    localStorage.setItem(scopedKey(addr, 'unlockedSkins'), JSON.stringify(state.unlockedSkins))
    localStorage.setItem(scopedKey(addr, 'activeSkin'), state.activeSkin)
  } catch { /* storage unavailable (private mode / quota) — state just won't persist */ }
}

/**
 * How many cosmetics the player owns — skins drawn from the gacha or bought
 * outright. Feeds the 收藏家 achievement, which used to count equipped items
 * from the retired ITEMS inventory.
 */
export function ownedCosmeticsCount(addr: string): number {
  return loadGamefiState(addr).unlockedSkins.length
}

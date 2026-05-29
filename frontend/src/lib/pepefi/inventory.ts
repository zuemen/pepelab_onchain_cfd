import type { ShopItem } from './items'

import { ITEMS, LOOTBOX_POOL } from './items'

const KEY = 'pepefi:inventory'
const EQ_KEY = 'pepefi:equipped'

export function getInventory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

export function addToInventory(itemId: string): void {
  const inv = getInventory()
  if (!inv.includes(itemId)) inv.push(itemId)
  localStorage.setItem(KEY, JSON.stringify(inv))
}

export function getEquipped(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(EQ_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

export function equipItem(item: ShopItem): void {
  const eq = getEquipped()
  eq[item.category] = item.id
  localStorage.setItem(EQ_KEY, JSON.stringify(eq))
}

export function unequipCategory(category: string): void {
  const eq = getEquipped()
  delete eq[category]
  localStorage.setItem(EQ_KEY, JSON.stringify(eq))
}

export function rollLootbox(): ShopItem {
  const idx = Math.floor(Math.random() * LOOTBOX_POOL.length)
  const id   = LOOTBOX_POOL[idx]
  const item = ITEMS.find(i => i.id === id) ?? ITEMS[0]
  addToInventory(item.id)
  return item
}

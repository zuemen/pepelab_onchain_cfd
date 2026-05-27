const KEY = (addr: string) => `pepefi:displayName:${addr.toLowerCase()}`

export function getDisplayName(addr?: string | null): string {
  if (!addr) return ''
  try {
    return localStorage.getItem(KEY(addr)) ?? ''
  } catch {
    return ''
  }
}

export function setDisplayName(addr: string, name: string): void {
  try {
    localStorage.setItem(KEY(addr), name)
    window.dispatchEvent(
      new CustomEvent('pepefi:displayName-changed', { detail: { addr, name } }),
    )
  } catch {}
}

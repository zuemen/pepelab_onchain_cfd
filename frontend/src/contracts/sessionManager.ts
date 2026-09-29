// AgentSessionManager（Phase 2 session-key 委派層）位址 + 合約工廠。
//
// 刻意獨立於 addresses.ts 的 ChainAddresses（該介面由 deploy 腳本整段重寫，
// 尚未納入此合約）。部署後請把 Deploy.s.sol 印出的 "AgentSessionMgr :" 位址
// 填到下面對應鏈，頁面即會啟用。位址為 0x0 時頁面顯示「未部署」提示。
import type { Signer, BrowserProvider } from 'ethers'

import { Contract } from 'ethers'

import AgentSessionManagerABI from 'src/contracts/abi/AgentSessionManager.json'

const ZERO = '0x0000000000000000000000000000000000000000'

// chainId → AgentSessionManager 位址（部署後填入）
const SESSION_MANAGER_ADDRESS: Record<number, string> = {
  31337:    ZERO, // Anvil：跑 deploy-anvil.sh 後填入
  11155111: ZERO, // Sepolia：跑 deploy-sepolia.sh 後填入
  // Base Sepolia. 2026-09-29 切到綁定現行 exchange 的實例：
  //   0xdF9C…d14B.exchange() == 0x827eA0c62a32e995927101259042F8A27D99124D（addresses.ts
  //   的 PerpetualExchange），且該 exchange 的 authorizedAgents(0xdF9C…d14B) == true
  //   （2026-09-29 以唯讀 eth_call 對 sepolia.base.org 核對）。
  // 前一個實例 0x4E7cC1B79B72ab72531a6C790e14304370f70764（2026-07-27 部署，帶 per-session
  // 資產白名單）綁的是舊 exchange 0xEf75ECA6514cE96B18382E921aC6190a0cF8c072，現行 exchange
  // 對它 authorizedAgents == false——經它開的 session 下單會被拒。它的 session 仍可在鏈上讀到。
  // 更早的 0x5Ebcc64C712C5a26119789dCbD0753981dc518E8 沒有資產白名單。
  // 新實例的 session id 從 0 重新開始。
  84532:    '0xdF9C1E53523568709f65Afe3C4AD2E6a6D99d14B',
}

export function getSessionManagerAddress(chainId: number | null): string {
  if (chainId === null) return ZERO
  return SESSION_MANAGER_ADDRESS[chainId] ?? ZERO
}

export function isSessionManagerDeployed(chainId: number | null): boolean {
  return getSessionManagerAddress(chainId) !== ZERO
}

/** 建立 AgentSessionManager 合約實例；位址未部署時回 null。 */
export function getSessionManager(
  runner: Signer | BrowserProvider | null,
  chainId: number | null,
): Contract | null {
  if (!runner) return null
  const addr = getSessionManagerAddress(chainId)
  if (addr === ZERO) return null
  return new Contract(addr, AgentSessionManagerABI, runner)
}

export { AgentSessionManagerABI }

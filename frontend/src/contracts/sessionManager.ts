// AgentSessionManager（Phase 2 session-key 委派層）位址 + 合約工廠。
//
// 刻意獨立於 addresses.ts 的 ChainAddresses（該介面由 deploy 腳本整段重寫，
// 尚未納入此合約）。部署後請把 Deploy.s.sol 印出的 "AgentSessionMgr :" 位址
// 填到下面對應鏈，頁面即會啟用。位址為 0x0 時頁面顯示「未部署」提示。
import type { Signer, BrowserProvider } from 'ethers'

import { Contract } from 'ethers'

import AgentSessionManagerABI from 'src/contracts/abi/AgentSessionManager.json'

import { tenantDeployment, resolvedDeployment } from './selectedDeployment'

const ZERO = '0x0000000000000000000000000000000000000000'

// chainId → AgentSessionManager 位址（部署後填入）。這是**平台部署**的表；專屬租戶的
// AgentSessionManager 在它自己的部署登記裡（src/contracts/deployments/<id>.json）。
export const SESSION_MANAGER_ADDRESS: Record<number, string> = {
  31337:    ZERO, // Anvil：跑 deploy-anvil.sh 後填入
  11155111: ZERO, // Sepolia：跑 deploy-sepolia.sh 後填入
  // Base Sepolia. 2026-10-20 #344 cutover 切到綁定新 exchange 的實例：
  //   0x4875…d2AF.exchange() == 0xbF3074C98e17d88B4127899C98C81AE94c9fC979（addresses.ts
  //   的 PerpetualExchange），且該 exchange 的 authorizedAgents(0x4875…d2AF) == true
  //   （Redeploy130Hardened 部署並授權，Verify130 讀回核對）。上一個實例 0xdF9C…d14B（綁 #129 的
  //   0x827e…）在 cutover 時已於舊 exchange 撤銷授權。
  // 前兩個實例（2026-07-27 部署、帶 per-session 資產白名單的那一顆綁的是舊 exchange
  // 0xEf75ECA6514cE96B18382E921aC6190a0cF8c072，現行 exchange 對它 authorizedAgents == false；
  // 更早的一顆沒有資產白名單）已退役，位址在機器可讀的退役清單
  // ./retiredPlatformAddresses.json（role: AgentSessionManager）。它們的 session 仍可在鏈上讀到。
  // 新實例的 session id 從 0 重新開始。
  84532:    '0x4875966ACA052A38d80ddD2aaE80995A98EAd2AF',
}

// 租戶隔離：專屬部署的 AgentSessionManager 不得就是平台的那一顆。其餘位址在
// selectedDeployment.ts 載入時已比對過 addresses.ts；這張表不在那個純資料模組裡，在這裡補上。
if (tenantDeployment.kind === 'dedicated') {
  const own = tenantDeployment.contracts.AgentSessionManager.toLowerCase()
  if (Object.values(SESSION_MANAGER_ADDRESS).some((a) => a !== ZERO && a.toLowerCase() === own)) {
    throw new Error(
      `[tenant] deployment registry for "${tenantDeployment.tenant}" breaks tenant isolation: contracts.AgentSessionManager is the platform's AgentSessionManager`,
    )
  }
}

export function getSessionManagerAddress(chainId: number | null): string {
  if (chainId === null) return ZERO
  // 專屬部署只有它自己那條鏈上的那一顆（其他鏈＝未部署），絕不退回平台的表：
  // session 綁定 exchange，租戶的使用者對平台的 manager 簽名就是對別人的 exchange 授權。
  // 平台部署（default 租戶）回 undefined，照舊查表。
  const dedicated = resolvedDeployment.dedicatedSessionManager(chainId)
  if (dedicated !== undefined) return dedicated
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

// 金庫的營運方注資總額：AssetVaultV2.fundVault 發出的 VaultFunded 事件加總。
//
// 合約沒有累計注資的 view，只能掃事件；而公開節點 eth_getLogs 上限約 200 塊
// （見 chainLogs.ts），從部署塊掃到現在是上萬次 RPC。所以公開鏈改問區塊瀏覽器的
// 事件索引（資料仍是鏈上事件，CSP connect-src 已放行），本機鏈節點沒有範圍上限，
// 直接掃。任何一步讀不到都回 null（無法確認），不是 0——「沒讀到注資」被當成
// 「沒有注資」，畫面就會把營運方的錢算成使用者的錢。

import { id } from 'ethers'

import { withTimeout } from './safeRead'

export const VAULT_FUNDED_TOPIC = id('VaultFunded(address,uint256)')

export const EXPLORER_API_BY_CHAIN: Record<number, string> = {
  84532: 'https://base-sepolia.blockscout.com/api',
  11155111: 'https://eth-sepolia.blockscout.com/api',
}

const LOCAL_CHAIN_ID = 31337

/** Blockscout 的 getLogs 單次最多回 1000 筆；滿了就可能少算。 */
const EXPLORER_PAGE_LIMIT = 1000

interface ExplorerLog {
  address: string
  topics: readonly string[]
  data: string
}

export interface OperatorFundingQuery {
  chainId: number | null
  vault: string
  /** 只在本機鏈用：回傳每一筆 VaultFunded 的金額。 */
  queryLocal?: () => Promise<readonly bigint[]>
  fetchImpl?: typeof fetch
}

/** 18-dec 注資總額；讀不到回 null。 */
export async function loadOperatorFunding({
  chainId,
  vault,
  queryLocal,
  fetchImpl = fetch,
}: OperatorFundingQuery): Promise<bigint | null> {
  try {
    if (chainId === LOCAL_CHAIN_ID && queryLocal) {
      return sum(await withTimeout(queryLocal()))
    }
    const api = chainId === null ? undefined : EXPLORER_API_BY_CHAIN[chainId]
    if (!api) return null

    const url =
      `${api}?module=logs&action=getLogs&address=${vault}` +
      `&topic0=${VAULT_FUNDED_TOPIC}&fromBlock=0&toBlock=latest`
    const res = await withTimeout(fetchImpl(url))
    if (!res.ok) return null
    const body = (await res.json()) as { status?: string; message?: string; result?: unknown }

    if (body.status === '0' && body.message === 'No logs found') return 0n
    if (body.status !== '1' || !Array.isArray(body.result)) return null
    const logs = body.result as ExplorerLog[]
    if (logs.length >= EXPLORER_PAGE_LIMIT) return null

    const wanted = vault.toLowerCase()
    const isFunding = (log: ExplorerLog) =>
      log.address.toLowerCase() === wanted && log.topics[0] === VAULT_FUNDED_TOPIC
    if (!logs.every(isFunding)) return null

    return sum(logs.map((log) => BigInt(log.data)))
  } catch {
    return null
  }
}

function sum(amounts: readonly bigint[]): bigint {
  return amounts.reduce((total, amount) => total + amount, 0n)
}

// 測試用的假鏈：認得 Multicall3 的 aggregate3，把每一筆子呼叫交給目標合約的 handler。
// 編碼與解碼都用真的 ethers Interface——測的是實際送出與讀回的位元組，不是 mock 的回傳值。

import type { ReadableContract } from '../multicall'

import { Interface } from 'ethers'

import { MULTICALL3 } from '../multicall'

const MC_IFACE = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
])

/** 合約拒絕時丟這個：ethers 的 Contract 對 revert 丟的錯誤也帶 code CALL_EXCEPTION。 */
export class Reverted extends Error {
  code = 'CALL_EXCEPTION'
}

/** 回傳這個方法的全部輸出（照 ABI 的順序）；丟 Reverted 代表合約拒絕。 */
export type Handler = (method: string, args: readonly unknown[]) => unknown[]

export interface FakeContract extends ReadableContract {
  iface: Interface
  handle: Handler
  /** 沒經過 Multicall3、直接呼叫的次數。 */
  direct: number
}

export function fakeContract(target: string, iface: Interface, handle: Handler): FakeContract {
  const contract: FakeContract = {
    target,
    interface: iface,
    iface,
    handle,
    direct: 0,
    getFunction: (method: string) => async (...args: unknown[]) => {
      contract.direct += 1
      const out = handle(method, args)
      return out.length === 1 ? out[0] : out
    },
  }
  return contract
}

/** 節點：只接 Multicall3。前 rejectFirst 個請求整批被拒（模擬 429）。 */
export function fakeMulticallNode(contracts: readonly FakeContract[], rejectFirst = 0) {
  const byAddress = new Map(contracts.map((c) => [String(c.target).toLowerCase(), c]))
  const node = {
    requests: 0,
    call: async (tx: { to?: string | null; data?: string | null }) => {
      node.requests += 1
      if (node.requests <= rejectFirst) throw new Error('25/second request limit reached')
      if (String(tx.to).toLowerCase() !== MULTICALL3.toLowerCase()) throw new Error(`unexpected eth_call to ${tx.to}`)
      const [calls] = MC_IFACE.decodeFunctionData('aggregate3', String(tx.data))
      const results = (calls as Array<{ target: string; callData: string }>).map((c) => {
        const contract = byAddress.get(c.target.toLowerCase())
        if (!contract) return { success: true, returnData: '0x' } // 沒有合約的位址：成功但沒有回傳
        const parsed = contract.iface.parseTransaction({ data: c.callData })!
        try {
          const out = contract.handle(parsed.name, [...parsed.args])
          return { success: true, returnData: contract.iface.encodeFunctionResult(parsed.name, out) }
        } catch {
          return { success: false, returnData: '0x' }
        }
      })
      return MC_IFACE.encodeFunctionResult('aggregate3', [results])
    },
  }
  return node
}

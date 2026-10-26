// src/contracts/abi/*.json 是 forge 產物（contracts/out/<C>.sol/<C>.json 的 abi 欄位）。合約原始碼改了而這裡
// 沒有重新覆寫時，前端會用舊介面編碼交易——呼叫一個已經不存在（或參數不同）的函式，要到使用者在瀏覽器裡按下去
// 才會失敗。這支測試直接解析 Solidity 原始碼（不需要 forge），核對 CopyTracker（ADR-024 自動同步改了它的介面）：
//   1. 原始碼宣告的每個 external／public 函式、事件（含 indexed 位置）與錯誤都在 JSON 裡，型別與 payable／view 相同；
//   2. 反過來，JSON 的每個項目都仍存在於原始碼（或是 public 狀態變數的 getter、繼承自 OpenZeppelin 的項目）；
//   3. 前端程式碼用到的 copyTracker.<函式>、filters.<事件>、bytecode 探測的函式簽章都在 ABI 裡。
// agent/copy-sync 的 abi.test.ts 再把執行者手寫的片段對到這份 JSON，兩邊用的是同一份介面。
import { readdirSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

import CopyTrackerABI from './CopyTracker.json'

interface AbiParam { type: string; indexed?: boolean; components?: AbiParam[] }
interface AbiItem { type: string; name?: string; inputs?: AbiParam[]; stateMutability?: string }

const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
const SOURCE = at('../../../../contracts/src/CopyTracker.sol')
const FRONTEND_SRC = at('../../')

/** 繼承來的項目（Ownable、ReentrancyGuard、SafeERC20、SafeCast）：不在 CopyTracker.sol 裡宣告。 */
const INHERITED = new Set([
  'owner', 'transferOwnership', 'OwnershipTransferred', 'OwnableInvalidOwner', 'OwnableUnauthorizedAccount',
  'ReentrancyGuardReentrantCall', 'SafeERC20FailedOperation', 'SafeCastOverflowedIntToUint',
  'SafeCastOverflowedUintToInt',
])

interface Decl { name: string; types: string[]; indexed: boolean[]; tail: string }

function parseContract(path: string, contract: string) {
  const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const start = text.search(new RegExp(`\\bcontract\\s+${contract}\\b`))
  if (start < 0) throw new Error(`找不到 contract ${contract}`)
  const body = text.slice(start) // 檔頭的 interface（IFeeRouterCopy…）不是這顆合約的函式
  const norm = (t: string) => (t === 'uint' ? 'uint256' : t === 'int' ? 'int256' : t)
  const params = (raw: string) => raw.split(',').map(p => p.trim()).filter(Boolean)
  const decls = (re: RegExp): Decl[] =>
    [...body.matchAll(re)].map(m => ({
      name: m[1],
      types: params(m[2]).map(p => norm(p.split(/\s+/)[0])),
      indexed: params(m[2]).map(p => /\bindexed\b/.test(p)),
      tail: m[3] ?? '',
    }))
  const functions = decls(/\bfunction\s+(\w+)\s*\(([^)]*)\)([^{;]*)[{;]/g)
    .filter(f => /\b(external|public)\b/.test(f.tail))
  const events = decls(/\bevent\s+(\w+)\s*\(([^)]*)\)\s*;/g)
  const errors = decls(/\berror\s+(\w+)\s*\(([^)]*)\)\s*;/g)
  // public 狀態變數、常數、immutable 的自動 getter
  const getters = new Set(
    body.split(';')
      .filter(stmt => /\bpublic\b/.test(stmt) && !/\b(function|event|error)\b/.test(stmt))
      .map(stmt => stmt.match(/\bpublic\b(?:\s+(?:constant|immutable))*\s+(\w+)\s*(?:=[\s\S]*)?$/)?.[1])
      .filter((n): n is string => !!n),
  )
  return { functions, events, errors, getters }
}

const abi = CopyTrackerABI as AbiItem[]
const src = parseContract(SOURCE, 'CopyTracker')
const typeOf = (p: AbiParam): string =>
  p.type.startsWith('tuple') ? `(${(p.components ?? []).map(typeOf).join(',')})${p.type.slice(5)}` : p.type
const sig = (name: string, types: string[]) => `${name}(${types.join(',')})`
const abiSigs = (kind: string) =>
  new Map(abi.filter(f => f.type === kind).map(f => [sig(f.name!, (f.inputs ?? []).map(typeOf)), f]))

describe('CopyTracker.json 與 contracts/src/CopyTracker.sol 一致', () => {
  it('原始碼的每個 external／public 函式都在 ABI 裡，參數型別與 payable／view 相同', () => {
    const fns = abiSigs('function')
    expect(src.functions.length).toBeGreaterThanOrEqual(20) // 解析本身有效（2026-10-26 為 20 個）
    for (const f of src.functions) {
      const item = fns.get(sig(f.name, f.types))
      expect(item, `ABI 缺少 ${sig(f.name, f.types)}——請用 forge 產物重新覆寫 CopyTracker.json`).toBeDefined()
      const want = /\bpayable\b/.test(f.tail) ? 'payable'
        : /\bview\b/.test(f.tail) ? 'view'
        : /\bpure\b/.test(f.tail) ? 'pure'
        : 'nonpayable'
      expect(item!.stateMutability, `${f.name} 的 stateMutability`).toBe(want)
    }
  })

  it('原始碼的每個事件（含 indexed 位置）與錯誤都在 ABI 裡', () => {
    const events = abiSigs('event')
    for (const e of src.events) {
      const item = events.get(sig(e.name, e.types))
      expect(item, `ABI 缺少 event ${sig(e.name, e.types)}`).toBeDefined()
      expect((item!.inputs ?? []).map(i => !!i.indexed), `event ${e.name} 的 indexed 位置`).toEqual(e.indexed)
    }
    const errors = abiSigs('error')
    for (const e of src.errors) {
      expect(errors.has(sig(e.name, e.types)), `ABI 缺少 error ${sig(e.name, e.types)}`).toBe(true)
    }
  })

  it('ABI 沒有原始碼裡已經不存在的函式、事件或錯誤', () => {
    const declared = new Set([
      ...src.functions.map(f => f.name), ...src.events.map(e => e.name), ...src.errors.map(e => e.name),
      ...src.getters, ...INHERITED,
    ])
    const stale = abi.filter(f => f.name && !declared.has(f.name)).map(f => `${f.type} ${f.name}`)
    expect(stale, '這些項目已不在 CopyTracker.sol：請用 forge 產物重新覆寫 CopyTracker.json').toEqual([])
    // 同名不同參數（例如 setAutoSync 加了參數）也算過期：每個 ABI 函式都要對得到原始碼或 getter
    const srcSigs = new Set(src.functions.map(f => sig(f.name, f.types)))
    const staleSigs = abi
      .filter(f => f.type === 'function' && !src.getters.has(f.name!) && !INHERITED.has(f.name!))
      .map(f => sig(f.name!, (f.inputs ?? []).map(typeOf)))
      .filter(s => !srcSigs.has(s))
    expect(staleSigs).toEqual([])
  })
})

describe('前端用到的 CopyTracker 介面都在 ABI 裡', () => {
  const files = (readdirSync(FRONTEND_SRC, { recursive: true }) as string[])
    .filter(f => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map(f => readFileSync(`${FRONTEND_SRC}/${f}`, 'utf8'))
  const names = (kind: string) => new Set(abi.filter(f => f.type === kind).map(f => f.name))
  // ethers Contract 本身的成員，不是合約函式
  const CONTRACT_MEMBERS = new Set(['target', 'interface', 'filters', 'runner', 'connect', 'getAddress', 'getFunction', 'getEvent', 'on', 'off', 'queryFilter'])

  it('copyTracker.<函式>（含 .staticCall）', () => {
    const used = new Set(files.flatMap(s => [...s.matchAll(/\bcopyTracker\??\.(\w+)/g)].map(m => m[1])))
    const fns = names('function')
    const missing = [...used].filter(n => !CONTRACT_MEMBERS.has(n) && !fns.has(n))
    expect(used.has('resyncAtVersion')).toBe(true) // 掃描本身有效
    expect(missing).toEqual([])
  })

  it('copyTracker.filters.<事件>、interface.getEvent(…)', () => {
    const events = names('event')
    const used = new Set(files.flatMap(s => [
      ...[...s.matchAll(/\bcopyTracker\??\.filters\.(\w+)/g)].map(m => m[1]),
      ...[...s.matchAll(/\bcopyTracker\??\.interface\.getEvent\(\s*['"](\w+)['"]/g)].map(m => m[1]),
    ]))
    expect(used.size).toBeGreaterThan(0)
    expect([...used].filter(n => !events.has(n))).toEqual([])
  })

  it('useAutoSyncSupport 探測 bytecode 用的函式簽章都在 ABI 裡（簽章寫錯會讓功能永遠顯示「尚未升級」）', () => {
    const hook = readFileSync(`${FRONTEND_SRC}/hooks/useAutoSyncSupport.ts`, 'utf8')
    const probed = [...hook.matchAll(/const SIG_\w+\s*=\s*'([^']+)'/g)].map(m => m[1])
    expect(probed.length).toBeGreaterThanOrEqual(4)
    const fns = abiSigs('function')
    expect(probed.filter(s => !fns.has(s))).toEqual([])
  })
})

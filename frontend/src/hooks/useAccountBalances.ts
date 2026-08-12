import type { Contract } from 'ethers';

import { useRef, useState, useEffect, useCallback } from 'react';

import { safeRead } from 'src/lib/pepefi/safeRead';

// 使用者的錢散在四個地方：Web3 錢包、交易所的自由保證金、TraderStake 的質押、
// LP 保險金庫。要算淨值就得四個都讀，而這段讀取原本埋在 DashboardPage 的
// fetchAll 裡，跟持倉、PEPE、GameFi 的讀取纏在一起。
//
// 抽出來是合併 Dashboard 與 Portfolio 的前提：Portfolio 之前只讀 freeMargin，
// 淨值 hero 搬過去就需要另外三桶。與其把四十行複製過去，不如讓兩邊（現在是
// 一邊）共用同一份。
//
// 每一項獨立讀取並各自容錯。之前是一次 Promise.all，只要 TraderStake 在這條鏈
// 上是 0x0 而 revert，持倉、保證金、餘額會一起陪葬——那正是把整個 dashboard
// 洗白的原因。

const POLL_MS = 30_000;

export interface AccountBalances {
  /** 以下皆為 18-dec。null = 沒讀到，不是 0。 */
  walletCash: bigint | null;
  freeMargin: bigint | null;
  staked:     bigint | null;
  vault:      bigint | null;
  loading:    boolean;
  refetch:    () => void;
}

interface Contracts {
  usdc:           Contract;
  exchange:       Contract;
  traderStake:    Contract;
  insuranceVault: Contract;
}

/**
 * TraderStake.getStake 的回傳形狀在不同部署間不一致——有時是 bigint，有時是
 * struct，有時是 tuple。全部收在這裡處理，呼叫端只拿到一個數字。
 */
function readStakeAmount(raw: unknown): bigint {
  if (typeof raw === 'bigint') return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if ('amount' in obj) return BigInt(obj.amount as string | number | bigint);
    if (obj[0] !== undefined) return BigInt(obj[0] as string | number | bigint);
  }
  return 0n;
}

export function useAccountBalances(
  contracts: Contracts | null,
  address: string | null | undefined,
): AccountBalances {
  const [walletCash, setWalletCash] = useState<bigint | null>(null);
  const [freeMargin, setFreeMargin] = useState<bigint | null>(null);
  const [staked,     setStaked]     = useState<bigint | null>(null);
  const [vault,      setVault]      = useState<bigint | null>(null);
  const [loading,    setLoading]    = useState(false);

  // 一次讀取要打好幾個 RPC，期間使用者可能換鏈或換地址。沒有版本號的話，先送出
  // 的舊查詢會在新查詢之後才回來，用過期的餘額蓋掉新的。
  const runId = useRef(0);

  const fetchBalances = useCallback(async () => {
    if (!contracts || !address) return;

    runId.current += 1;
    const myRun = runId.current;
    const isStale = () => runId.current !== myRun;

    setLoading(true);
    try {
      const [cashRaw, marginRaw, stakeRaw] = await Promise.all([
        safeRead<bigint | null>(contracts.usdc.balanceOf(address) as Promise<bigint>, null),
        safeRead<bigint | null>(contracts.exchange.freeMargin(address) as Promise<bigint>, null),
        safeRead<unknown>(contracts.traderStake.getStake(address) as Promise<unknown>, null),
      ]);
      if (isStale()) return;

      setWalletCash(cashRaw);
      setFreeMargin(marginRaw);
      setStaked(stakeRaw === null ? null : readStakeAmount(stakeRaw));

      // 金庫存的是股份，要換算成 USDC：myShares × totalAssets / totalSupply。
      let vaultValue: bigint | null = null;
      try {
        const [shares, totalAssets, totalSupply] = await Promise.all([
          contracts.insuranceVault.balanceOf(address) as Promise<bigint>,
          contracts.insuranceVault.totalAssets() as Promise<bigint>,
          contracts.insuranceVault.totalSupply() as Promise<bigint>,
        ]);
        vaultValue = BigInt(totalSupply) > 0n
          ? (BigInt(shares) * BigInt(totalAssets)) / BigInt(totalSupply)
          : 0n;
      } catch {
        // 金庫在這條鏈上可能沒部署。留 null 讓 netWorthOf 標記為不完整，
        // 而不是當成「你在金庫裡有 0 元」。
        vaultValue = null;
      }
      if (isStale()) return;
      setVault(vaultValue);
    } finally {
      if (runId.current === myRun) setLoading(false);
    }
  }, [contracts, address]);

  useEffect(() => {
    void fetchBalances();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void fetchBalances();
    }, POLL_MS);
    const onVisible = () => { if (document.visibilityState !== 'hidden') void fetchBalances(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchBalances]);

  return { walletCash, freeMargin, staked, vault, loading, refetch: fetchBalances };
}

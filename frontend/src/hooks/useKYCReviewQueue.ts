import type { Contract, BrowserProvider } from 'ethers'

import { useRef, useState, useCallback } from 'react'

import { t, interpolate } from 'src/locales'
import { mapLimit, withRetry, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'
import { scanFromBlock, queryLogsChunked, type ChunkProgress, type ChunkFailure } from 'src/lib/pepefi/chainLogs'
import { latestSubmissionByAddress, bucketOf, type ReviewBucket } from 'src/lib/pepefi/kycQueue'

// 審核佇列：見 ADR 0005（frontend/docs/adr/0005-review-queue-rebuilt-from-events.md）。
//
// 兩段式重建，不是單純掃三種事件：
//  1. 掃 KYCSubmitted，找出「曾經送過申請」的位址全集——這是合約唯一給不出來
//     的答案（沒有可列舉的清單）。
//  2. 對每個位址讀 records() / pending() 的即時鏈上狀態來分桶，不是從
//     KYCVerified / KYCRevoked 事件推。理由：一個位址可能通過→撤銷→再通過，
//     從三條事件流各自取最新一筆再比對順序很容易做錯；一次鏈上讀取就是正確
//     答案，不會過期。
//
// batchVerify 造出的帳號完全不會出現在這裡（見 ADR 0005 Consequences）——
// 它們從沒呼叫過 submitKYC，第 1 步就找不到它們。

export type { ReviewBucket }

export interface ReviewApplication {
  address:         string
  fullName:        string
  nationality:     string
  bucket:          ReviewBucket
  submittedBlock:  number
  submittedTxHash: string
}

export interface KYCReviewQueue {
  pending:   ReviewApplication[]
  verified:  ReviewApplication[]
  revoked:   ReviewApplication[]
  scanRange: { from: number; to: number } | null
  progress:  { done: number; total: number } | null
  loading:   boolean
  error:     string | null
  refetch:   () => void
}

interface SubmittedLog {
  args:            Record<string, unknown>
  blockNumber:     number
  transactionHash: string
}

interface RawRecord {
  verified:    boolean
  fullName:    string
  nationality: string
}

export function useKYCReviewQueue(
  kycRegistry: Contract | null,
  provider:    BrowserProvider | null,
  chainId:     number | null,
): KYCReviewQueue {
  const [apps,      setApps]      = useState<ReviewApplication[]>([]);
  const [scanRange, setScanRange] = useState<{ from: number; to: number } | null>(null);
  const [progress,  setProgress]  = useState<{ done: number; total: number } | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const runId = useRef(0);

  const refetch = useCallback(async () => {
    if (!kycRegistry || !provider) return;

    runId.current += 1;
    const myRun = runId.current;
    const isStale = () => runId.current !== myRun;

    setLoading(true);
    setError(null);

    try {
      const latest = await withRetry(() => provider.getBlockNumber());
      if (isStale()) return;

      const from = scanFromBlock({ chainId, currentBlock: latest });
      setScanRange({ from, to: latest });

      const onChunk: ChunkProgress = (done, total) => { if (!isStale()) setProgress({ done, total }); };
      // 掃描期間掉的段不能悄悄丟掉——這裡找的是「誰申請過」，掉一段代表某個
      // 申請人整個從佇列消失，不是「這筆讀不到」而已，審核員得知道範圍不完整。
      let failedChunks = 0;
      const onChunkFailed: ChunkFailure = () => { failedChunks += 1; };
      const logs = await queryLogsChunked(
        kycRegistry,
        kycRegistry.filters.KYCSubmitted(),
        from,
        latest,
        onChunk,
        onChunkFailed,
      ) as SubmittedLog[];
      if (isStale()) return;

      const bySubmitter = latestSubmissionByAddress(
        logs.map(log => ({
          user: String(log.args.user),
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        })),
      );

      const addresses = [...bySubmitter.keys()];
      // records()/pending() 釘在同一個 blockTag：兩個各自獨立的 eth_call 若不
      // 釘同一塊，approveKYC 剛好在兩次呼叫之間上鏈的話會讀到不一致的組合
      // （verified=false 來自舊塊、pending=false 來自新塊 → 誤判成 revoked）。
      // 釘住同一塊之後兩個欄位保證來自同一個世界狀態。
      const reads = await mapLimit(addresses, RPC_CONCURRENCY, async (addr) => {
        try {
          const rec = await withRetry(
            () => kycRegistry.records(addr, { blockTag: latest }),
          ) as RawRecord;
          // pending 只在還沒 verified 時才有意義（bucketOf 對 verified 直接
          // 短路），已驗證的位址不必再多打一次 eth_call。
          const isPending = rec.verified
            ? false
            : await withRetry(() => kycRegistry.pending(addr, { blockTag: latest })) as boolean;
          return { addr, rec, isPending, ok: true as const };
        } catch {
          return { addr, ok: false as const };
        }
      });
      if (isStale()) return;

      let unreadable = 0;
      const rows: ReviewApplication[] = [];
      for (const r of reads) {
        if (!r.ok) { unreadable += 1; continue; }
        const log = bySubmitter.get(r.addr)!;
        const bucket = bucketOf({ verified: r.rec.verified, pending: r.isPending });
        rows.push({
          address:         r.addr,
          fullName:        r.rec.fullName,
          nationality:     r.rec.nationality,
          bucket,
          submittedBlock:  log.blockNumber,
          submittedTxHash: log.transactionHash,
        });
      }

      rows.sort((a, b) => b.submittedBlock - a.submittedBlock);
      setApps(rows);

      // 掃描階段掉的段比某幾筆讀不到更嚴重——代表佇列本身可能漏了申請人，
      // 所以獨立顯示，優先於下面的「有讀不到」訊息。
      if (failedChunks > 0) {
        setError(interpolate(t.admin.kyc.queue.scanIncomplete, { count: failedChunks }));
      } else if (unreadable > 0) {
        // 讀取失敗只影響那幾筆——限流被靜默吃掉會讓審核員以為某人從沒申請過,
        // 所以明講「有讀不到的」而不是默默漏掉。
        setError(interpolate(t.admin.kyc.queue.readErrorSome, { count: unreadable }));
      }
    } catch (e) {
      console.error('[useKYCReviewQueue]', e);
      if (!isStale()) setError(t.admin.kyc.queue.readErrorAll);
    } finally {
      if (!isStale()) {
        setLoading(false);
        setProgress(null);
      }
    }
  }, [kycRegistry, provider, chainId]);

  return {
    pending:  apps.filter(a => a.bucket === 'pending'),
    verified: apps.filter(a => a.bucket === 'verified'),
    revoked:  apps.filter(a => a.bucket === 'revoked'),
    scanRange,
    progress,
    loading,
    error,
    refetch: () => { void refetch(); },
  };
}

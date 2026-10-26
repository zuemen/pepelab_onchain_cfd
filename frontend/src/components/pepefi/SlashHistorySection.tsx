import type { Contract } from 'ethers'

import { useState, useEffect } from 'react'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Link from '@mui/material/Link'
import Alert from '@mui/material/Alert'
import Table from '@mui/material/Table'
import TableRow from '@mui/material/TableRow'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import Typography from '@mui/material/Typography'
import TableContainer from '@mui/material/TableContainer'

import { t, interpolate } from 'src/locales'
import { MONO } from 'src/components/pepefi/brandKit'
import { explorerTx, explorerName } from 'src/lib/pepefi/notify'
import { UI_RETRIES, scanFromBlock, isChunkScanAborted, describeScanWindow, scanContractEventsStrict } from 'src/lib/pepefi/chainLogs'

// 交易者個人頁的罰沒紀錄（從 TraderProfilePage 搬出來）：掛上去才開始掃 Slashed 事件。
// 個人頁用 DeferredSection 包著，使用者按「載入」才掛——它是幾百段 getLogs，不該跟主要內容搶讀鏈額度。

interface SlashEvent {
  trader:    string
  amount:    bigint
  recipient: string
  txHash:    string
}

const f18 = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export default function SlashHistorySection({ traderStake, trader, chainId, totalSlashed }: {
  traderStake:  Contract
  trader:       string
  chainId:      number | null
  /** 合約 storage 的累計罰沒（不受掃描範圍限制）；null = 沒讀到。 */
  totalSlashed: bigint | null
}) {
  const [slashHistory, setSlashHistory] = useState<SlashEvent[]>([])
  /**
   * 罰沒事件讀取狀態。'failed' 時**絕不能**顯示成「沒有罰沒」——讀不到和沒有是兩件事。
   * 'pending' = 還沒讀完；'ok' 時 slashBlocks = 實際掃描的塊數。
   */
  const [slashRead, setSlashRead] = useState<'pending' | 'ok' | 'failed'>('pending')
  const [slashBlocks, setSlashBlocks] = useState(0)

  // 換頁或卸載時以 AbortController 中止，過期結果一律丟棄。
  useEffect(() => {
    const ac = new AbortController()
    setSlashRead('pending')
    setSlashHistory([])
    void (async () => {
      try {
        const provider = traderStake.runner?.provider
        if (!provider) throw new Error('no provider')
        const latest = Number(await provider.getBlockNumber())
        if (ac.signal.aborted) return
        const from = scanFromBlock({ chainId, currentBlock: latest })
        // 任何一段讀不到就整個標成讀取失敗：部分結果在這裡會被讀成「沒有罰沒」。
        const events = await scanContractEventsStrict(
          provider,
          traderStake,
          [traderStake.filters.Slashed(trader, null)],
          from,
          latest,
          { retries: UI_RETRIES, signal: ac.signal },
        )
        if (ac.signal.aborted) return
        setSlashHistory(events.map((ev) => ({
          trader:    ev.args.trader as string,
          amount:    ev.args.amount as bigint,
          recipient: ev.args.recipient as string,
          txHash:    ev.transactionHash,
        })).reverse())
        setSlashBlocks(latest - from + 1)
        setSlashRead('ok')
      } catch (err) {
        if (ac.signal.aborted || isChunkScanAborted(err)) return
        console.warn('[traderProfile] slash history read failed', err)
        setSlashHistory([])
        setSlashRead('failed')
      }
    })()
    return () => ac.abort()
  }, [traderStake, trader, chainId])

  const span = describeScanWindow(chainId, slashBlocks)

  // 讀取失敗：明說無法確認，絕不顯示成「沒有罰沒」。合約 storage 的 totalSlashed 是完整的
  // 累計值（不受掃描範圍限制），讀得到就一併列出。
  if (slashRead === 'pending') {
    return (
      <Typography variant="caption" color="text.secondary">
        {t.traderProfile.slashHistory.loading}
      </Typography>
    )
  }
  if (slashRead === 'failed') {
    return (
      <Alert severity="error">
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
          {t.traderProfile.slashHistory.readFailedTitle}
        </Typography>
        {t.traderProfile.slashHistory.readFailedBody}
        {totalSlashed !== null && (
          <Box sx={{ mt: 0.5 }}>
            {interpolate(t.traderProfile.slashHistory.totalFromContract, { amount: f18(totalSlashed) })}
          </Box>
        )}
      </Alert>
    )
  }
  if (slashHistory.length === 0) {
    // 掃到的範圍裡沒有：合約說曾被罰沒，就是發生在範圍之前
    return totalSlashed !== null && totalSlashed > 0n ? (
      <Alert severity="warning">
        {interpolate(t.traderProfile.slashHistory.outsideWindow, { span, amount: f18(totalSlashed) })}
      </Alert>
    ) : (
      <Typography variant="body2" color="text.secondary">
        {interpolate(t.traderProfile.slashHistory.emptyInWindow, { span })}
      </Typography>
    )
  }
  return (
    <Card sx={{ p: 3, border: '1px solid', borderColor: 'error.main', bgcolor: 'rgba(255, 86, 48, 0.08)', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="subtitle1" color="error.main" sx={{ fontWeight: 'bold' }}>
        {interpolate(
          slashHistory.length === 1
            ? t.traderProfile.slashHistory.titleOne
            : t.traderProfile.slashHistory.titleMany,
          { count: slashHistory.length },
        )}
      </Typography>
      <TableContainer>
        <Table size="small">
          <TableBody>
            {slashHistory.map((ev, i) => (
              <TableRow key={i}>
                <TableCell>
                  <Typography variant="body2" color="error.main" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                    −{f18(ev.amount)} USDC
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    → {shortAddr(ev.recipient)}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  {explorerTx(ev.txHash, chainId) && (
                    <Link
                      href={explorerTx(ev.txHash, chainId)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      color="info.main"
                      sx={{ fontSize: '0.875rem', textDecoration: 'underline' }}
                    >
                      {explorerName(chainId)} ↗
                    </Link>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Card>
  )
}

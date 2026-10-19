import type { BrowserProvider } from 'ethers';

import { useState } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableRow from '@mui/material/TableRow';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import Typography from '@mui/material/Typography';
import TableContainer from '@mui/material/TableContainer';

import { t, interpolate } from 'src/locales';
import { MONO } from 'src/components/pepefi/brandKit';
import { fUsd, type HeroDetail, type HeroTrade } from 'src/lib/pepefi/heroData';

import ListDialog, { ExpandListButton } from 'src/components/pepefi/ListDialog';

import TxProof from './TxProof';

// ----------------------------------------------------------------------
// 模擬交易者的部位紀錄（issue #309）。每一筆都附開倉與平倉交易雜湊，點開向節點讀收據（見 TxProof）。
// 策略的歷次版本不在這裡：個人頁的「策略歷史」從鏈上讀，發布交易也併在那裡，不重複列一次。

// 卡片上只放最新的這麼多筆；完整清單開在彈窗裡（ListDialog）。
const PREVIEW_ROWS = 10;
// 時間壓縮的回放（#344）：日期欄是模擬日期，下面另外標上鏈時間（UTC 到分鐘）——BaseScan 上看到的是它。
const fChainTime = (unix: number) => `${new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

function DateCell({ date, chainTime, compressed }: { date: string | null; chainTime: number | null; compressed: boolean }) {
  const L = t.traderProfile.hero;
  return (
    <>
      <Box sx={{ fontSize: '0.6875rem', color: 'text.secondary' }}>{date ?? '—'}</Box>
      {compressed && chainTime !== null && (
        <Box sx={{ fontSize: '0.625rem', color: 'text.disabled' }}>{interpolate(L.chainTime, { time: fChainTime(chainTime) })}</Box>
      )}
    </>
  );
}

function PnlCell({ trade }: { trade: HeroTrade }) {
  const L = t.traderProfile.hero;
  if (trade.pnlUsd === null) {
    return <Chip size="small" variant="outlined" label={L.stillOpen} sx={{ height: 20, fontSize: '0.6875rem' }} />;
  }
  return (
    <Stack alignItems="flex-end" spacing={0.25}>
      <Box sx={{ fontFamily: MONO, fontWeight: 'bold', color: trade.pnlUsd >= 0 ? 'success.main' : 'error.main' }}>
        {trade.pnlUsd >= 0 ? '+' : ''}{fUsd(trade.pnlUsd)}
      </Box>
      <Box sx={{ fontFamily: MONO, fontSize: '0.6875rem', color: 'text.secondary' }}>
        ({trade.grossPnlUsd !== null && trade.grossPnlUsd >= 0 ? '+' : ''}{fUsd(trade.grossPnlUsd)})
      </Box>
      {trade.liquidated && (
        <Chip size="small" color="error" variant="outlined" label={L.liquidated} sx={{ height: 18, fontSize: '0.625rem' }} />
      )}
    </Stack>
  );
}

interface Props {
  hero: HeroDetail;
  provider: BrowserProvider | null;
  chainId: number | null;
}

export default function HeroTrades({ hero, provider, chainId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const L = t.traderProfile.hero;
  // 最新的在最上面
  const trades = [...hero.trades].reverse();

  // 卡片上的預覽與彈窗裡的完整清單共用同一張表；彈窗裡標題列固定在上方。
  const table = (rows: HeroTrade[], stickyHeader: boolean) => (
    <TableContainer>
      <Table size="small" stickyHeader={stickyHeader}>
        <TableHead>
          <TableRow>
            <TableCell>{L.colAsset}</TableCell>
            <TableCell>{L.colSide}</TableCell>
            <TableCell align="right">{L.colMargin}</TableCell>
            <TableCell align="right">{L.colOpen}</TableCell>
            <TableCell align="right">{L.colClose}</TableCell>
            <TableCell align="right">{L.colPnl}</TableCell>
            <TableCell>{L.colProof}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((trade) => (
            <TableRow key={trade.positionId} hover>
              <TableCell sx={{ fontWeight: 600 }}>{trade.asset}</TableCell>
              <TableCell sx={{ color: trade.isLong ? 'success.main' : 'error.main', whiteSpace: 'nowrap' }}>
                {trade.isLong ? L.long : L.short} {trade.leverage}×
              </TableCell>
              <TableCell align="right" sx={{ fontFamily: MONO }}>{fUsd(trade.marginUsd)}</TableCell>
              <TableCell align="right" sx={{ fontFamily: MONO, whiteSpace: 'nowrap' }}>
                {fUsd(trade.openPrice)}
                <DateCell date={trade.openDate} chainTime={trade.openTime} compressed={hero.timeCompressed} />
              </TableCell>
              <TableCell align="right" sx={{ fontFamily: MONO, whiteSpace: 'nowrap' }}>
                {fUsd(trade.closePrice)}
                <DateCell date={trade.closeDate} chainTime={trade.closeTime} compressed={hero.timeCompressed} />
              </TableCell>
              <TableCell align="right"><PnlCell trade={trade} /></TableCell>
              <TableCell>
                <TxProof label={L.openTx} hash={trade.openTx} provider={provider} chainId={chainId} />
                {trade.closeTx && (
                  <TxProof label={L.closeTx} hash={trade.closeTx} provider={provider} chainId={chainId} />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );

  return (
    <Card sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, mb: 2 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{L.tradesTitle}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{L.tradesNote}</Typography>
          {hero.timeCompressed && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{L.tradesNoteCompressed}</Typography>
          )}
        </Box>
        {trades.length > PREVIEW_ROWS && <ExpandListButton count={trades.length} onClick={() => setExpanded(true)} />}
      </Box>
      {table(trades.slice(0, PREVIEW_ROWS), false)}
      <ListDialog open={expanded} onClose={() => setExpanded(false)} title={L.tradesTitle} subtitle={L.tradesNote}>
        {table(trades, true)}
      </ListDialog>
    </Card>
  );
}

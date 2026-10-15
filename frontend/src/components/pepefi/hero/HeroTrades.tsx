import type { BrowserProvider } from 'ethers';

import { useState } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import Button from '@mui/material/Button';
import TableRow from '@mui/material/TableRow';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import Typography from '@mui/material/Typography';
import TableContainer from '@mui/material/TableContainer';

import { t, interpolate } from 'src/locales';
import { MONO } from 'src/components/pepefi/brandKit';
import { fUsd, type HeroDetail, type HeroTrade } from 'src/lib/pepefi/heroData';

import TxProof from './TxProof';

// ----------------------------------------------------------------------
// 模擬交易者的部位紀錄（issue #309）。每一筆都附開倉與平倉交易雜湊，點開向節點讀收據（見 TxProof）。
// 策略的歷次版本不在這裡：個人頁的「策略歷史」從鏈上讀，發布交易也併在那裡，不重複列一次。

const FIRST_PAGE = 25;
const fDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

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
  const [showAllTrades, setShowAllTrades] = useState(false);
  const L = t.traderProfile.hero;
  // 最新的在最上面
  const trades = [...hero.trades].reverse();
  const shownTrades = showAllTrades ? trades : trades.slice(0, FIRST_PAGE);

  return (
    <Stack spacing={2}>
      <Card sx={{ p: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{L.tradesTitle}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>{L.tradesNote}</Typography>
        <TableContainer>
          <Table size="small">
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
              {shownTrades.map((trade) => (
                <TableRow key={trade.positionId} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{trade.asset}</TableCell>
                  <TableCell sx={{ color: trade.isLong ? 'success.main' : 'error.main', whiteSpace: 'nowrap' }}>
                    {trade.isLong ? L.long : L.short} {trade.leverage}×
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO }}>{fUsd(trade.marginUsd)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO, whiteSpace: 'nowrap' }}>
                    {fUsd(trade.openPrice)}
                    <Box sx={{ fontSize: '0.6875rem', color: 'text.secondary' }}>{fDay(trade.openTime)}</Box>
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO, whiteSpace: 'nowrap' }}>
                    {fUsd(trade.closePrice)}
                    <Box sx={{ fontSize: '0.6875rem', color: 'text.secondary' }}>
                      {trade.closeTime === null ? '—' : fDay(trade.closeTime)}
                    </Box>
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
        {!showAllTrades && trades.length > FIRST_PAGE && (
          <Button size="small" onClick={() => setShowAllTrades(true)} sx={{ mt: 1, textTransform: 'none' }}>
            {interpolate(L.showMore, { count: trades.length })}
          </Button>
        )}
      </Card>
    </Stack>
  );
}

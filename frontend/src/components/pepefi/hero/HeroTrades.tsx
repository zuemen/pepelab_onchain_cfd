import type { BrowserProvider } from 'ethers';

import { useState } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
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
import { explorerTx } from 'src/lib/pepefi/explorer';
import { fUsd, type HeroDetail, type HeroTrade } from 'src/lib/pepefi/heroData';

// ----------------------------------------------------------------------
// 模擬交易者的策略版本與部位紀錄（issue #309）。每一筆都附交易雜湊；點開會直接向節點
// 讀這筆交易的收據——畫面上的「交易證明」是鏈回的答案，不是資料檔自己說的。

const FIRST_PAGE = 25;
// 調整頻繁的交易者兩年有二十幾個版本；先列最新的幾版，其餘收在「顯示全部」後面。
const FIRST_VERSIONS = 5;
const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;
const fDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

type Proof =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ok'; block: number; time: number | null; success: boolean; logs: number };

function TxProof({ label, hash, provider, chainId }: {
  label: string;
  hash: string;
  provider: BrowserProvider | null;
  chainId: number | null;
}) {
  const [proof, setProof] = useState<Proof | null>(null);
  const L = t.traderProfile.hero;
  const href = explorerTx(hash, chainId);

  const load = async () => {
    if (!provider) return setProof({ state: 'failed' });
    setProof({ state: 'loading' });
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (!receipt) return setProof({ state: 'failed' });
      const block = await provider.getBlock(receipt.blockNumber);
      return setProof({
        state: 'ok',
        block: receipt.blockNumber,
        time: block?.timestamp ?? null,
        success: receipt.status === 1,
        logs: receipt.logs.length,
      });
    } catch {
      return setProof({ state: 'failed' });
    }
  };

  return (
    <Box sx={{ lineHeight: 1.4 }}>
      <Typography variant="caption" color="text.secondary">{label} </Typography>
      {href ? (
        <Link href={href} target="_blank" rel="noopener noreferrer" variant="caption" sx={{ fontFamily: MONO }}>
          {shortHash(hash)}
        </Link>
      ) : (
        <Link component="button" type="button" variant="caption" onClick={() => void load()} sx={{ fontFamily: MONO }}>
          {shortHash(hash)}
        </Link>
      )}
      {proof?.state === 'loading' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{L.proofLoading}</Typography>
      )}
      {proof?.state === 'failed' && (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>{L.proofFailed}</Typography>
      )}
      {proof?.state === 'ok' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: MONO }}>
          {interpolate(L.proofBlock, { block: proof.block })}
          {' · '}
          {interpolate(L.proofTime, { time: proof.time === null ? '—' : new Date(proof.time * 1000).toISOString().replace('.000Z', 'Z') })}
          {' · '}
          {interpolate(L.proofStatus, { status: proof.success ? L.proofSuccess : L.proofReverted })}
          {' · '}
          {interpolate(L.proofLogs, { count: proof.logs })}
        </Typography>
      )}
    </Box>
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
  const [showAllTrades, setShowAllTrades] = useState(false);
  const [showAllVersions, setShowAllVersions] = useState(false);
  const L = t.traderProfile.hero;
  // 最新的在最上面
  const strategies = [...hero.strategies].reverse();
  const trades = [...hero.trades].reverse();
  const shownVersions = showAllVersions ? strategies : strategies.slice(0, FIRST_VERSIONS);
  const shownTrades = showAllTrades ? trades : trades.slice(0, FIRST_PAGE);

  return (
    <Stack spacing={2}>
      {strategies.length > 0 && (
        <Card sx={{ p: 3 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>{L.strategiesTitle}</Typography>
          <Stack spacing={1.5}>
            {shownVersions.map((version) => (
              <Box key={version.versionId}>
                <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap">
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {interpolate(L.strategyVersion, { version: version.versionId + 1 })}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>{version.date}</Typography>
                </Stack>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ my: 0.5 }}>
                  {version.legs.map((leg) => (
                    <Chip
                      key={leg.asset}
                      size="small"
                      variant="outlined"
                      color={leg.isLong ? 'success' : 'error'}
                      label={`${leg.isLong ? '↑' : '↓'}${leg.asset} ${(leg.weightBps / 100).toFixed(0)}% ${leg.leverage}×`}
                      sx={{ height: 20, fontSize: '0.6875rem', fontFamily: MONO }}
                    />
                  ))}
                </Stack>
                <TxProof label={L.publishTx} hash={version.tx} provider={provider} chainId={chainId} />
              </Box>
            ))}
          </Stack>
          {!showAllVersions && strategies.length > FIRST_VERSIONS && (
            <Button size="small" onClick={() => setShowAllVersions(true)} sx={{ mt: 1, textTransform: 'none' }}>
              {interpolate(L.showMore, { count: strategies.length })}
            </Button>
          )}
        </Card>
      )}

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

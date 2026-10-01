import type { ReactNode } from 'react';
import type {
  Preflight,
  LegacyBlock,
  LegacyExchangeScan,
  LegacyPositionView,
} from 'src/lib/pepefi/legacyExchange';

import { formatUnits } from 'ethers';
import { useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Link from '@mui/material/Link';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import TableRow from '@mui/material/TableRow';
import Container from '@mui/material/Container';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import Typography from '@mui/material/Typography';
import AlertTitle from '@mui/material/AlertTitle';
import TableContainer from '@mui/material/TableContainer';

import { tenant } from 'src/tenant';
import { paths } from 'src/routes/paths';
import { t, interpolate } from 'src/locales';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { CHAIN_NAMES } from 'src/contracts/addresses';
import { useLegacyAssets } from 'src/hooks/useLegacyAssets';
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta';
import { MONO } from 'src/components/pepefi/brandKit';
import { explorerAddr } from 'src/lib/pepefi/explorer';
import { prettyError } from 'src/lib/pepefi/errorMessages';
import { STABLE_LABEL } from 'src/lib/pepefi/tokenLabel';
import { useToast } from 'src/components/pepefi/ToastProvider';
import { FALLBACK_MAX_PRICE_AGE_SEC } from 'src/lib/pepefi/priceFreshness';
import {
  ageLabel,
  MAX_POSITION_IDS,
  encodeClose,
  needsOperator,
  scanHasAssets,
  encodeWithdraw,
  preflightClose,
  preflightWithdraw,
  legacyBlockMessage,
  settlesAtStalePrice,
} from 'src/lib/pepefi/legacyExchange';

// ----------------------------------------------------------------------

/**
 * /legacy：已退役 PerpetualExchange 上的保證金與未平倉部位。
 *
 * 安全邊界（見 docs/LEGACY_EXCHANGES.md）：
 *   - 合約位址只來自 src/contracts/legacyExchanges.ts 的常數，這一頁不讀任何 URL 參數
 *     或使用者輸入的位址。
 *   - 每個按鈕送出前都重新用 eth_call（from = 使用者）預檢一次；預檢失敗就不送，
 *     使用者看到的是原因而不是錢包裡一筆必定 revert 的交易。
 *   - 使用者自己無法解決的情況（需要合約 owner 操作）顯示租戶設定的客服聯絡方式。
 */

const SHORT = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const nowSec = () => Math.floor(Date.now() / 1000);

function fmt(v: bigint, decimals: number, dp = 2): string {
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

type Action =
  | { kind: 'withdraw'; scan: LegacyExchangeScan; amount: bigint }
  | { kind: 'close'; scan: LegacyExchangeScan; position: LegacyPositionView };

export default function LegacyPage() {
  const wallet = usePepefiWallet();
  const { notify } = useToast();
  const reader = wallet.isMock ? null : wallet.provider;
  const legacy = useLegacyAssets(reader, wallet.chainId, wallet.address);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const busyRef = useRef<Set<string>>(new Set());

  const chainName = wallet.chainId !== null
    ? (CHAIN_NAMES[wallet.chainId] ?? `chainId ${wallet.chainId}`)
    : '—';

  const runAction = async (action: Action) => {
    const { scan } = action;
    const key = action.kind === 'withdraw'
      ? `w:${scan.exchange.address}`
      : `c:${scan.exchange.address}:${String(action.position.id)}`;
    if (busyRef.current.has(key)) return;
    if (!wallet.provider || !wallet.signer || !wallet.address) return;
    // 掃描結果屬於掃描當時的鏈；錢包若已切到別條鏈，不送。
    if (wallet.chainId !== scan.exchange.chainId) return;

    busyRef.current.add(key);
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      // 送出前重新預檢：價格新鮮度、合約餘額、可用保證金都可能在掃描之後變了。
      const pf: Preflight = action.kind === 'withdraw'
        ? await preflightWithdraw(wallet.provider, scan.exchange.address, wallet.address, action.amount, nowSec())
        : await preflightClose(wallet.provider, scan.exchange.address, wallet.address, action.position.id, nowSec());
      if (!pf.ok) {
        notify(`${t.legacy.block.notSent} ${legacyBlockMessage(pf.block, nowSec())}`, false);
        legacy.refresh();
        return;
      }
      const tx = await wallet.signer.sendTransaction({
        to: scan.exchange.address,
        data: action.kind === 'withdraw' ? encodeWithdraw(action.amount) : encodeClose(action.position.id),
      });
      await tx.wait();
      notify(action.kind === 'withdraw' ? t.legacy.withdraw.done : t.legacy.close.done, true, tx.hash);
      legacy.refresh();
    } catch (e) {
      notify(prettyError(e), false);
    } finally {
      busyRef.current.delete(key);
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  // ── Guards ────────────────────────────────────────────────────────────────

  const header = (
    <Stack spacing={1}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>{t.legacy.title}</Typography>
        <Button
          size="small"
          variant="text"
          color="inherit"
          onClick={legacy.refresh}
          disabled={legacy.loading || !reader}
          sx={{ textTransform: 'none', color: 'text.secondary' }}
        >
          {t.legacy.refresh}
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary">{t.legacy.subtitle}</Typography>
    </Stack>
  );

  const shell = (body: ReactNode) => (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
      {header}
      {body}
      <Box>
        <Button component={RouterLink} to={paths.pepefi.portfolio} size="small" sx={{ textTransform: 'none' }}>
          {t.legacy.backToPortfolio}
        </Button>
      </Box>
    </Container>
  );

  if (wallet.isMock) return shell(<Alert severity="info">{t.legacy.demoWallet}</Alert>);
  if (!wallet.isConnected || !wallet.address || !reader) return shell(<Alert severity="info">{t.legacy.connectPrompt}</Alert>);
  if (legacy.registered === 0) {
    return shell(<Alert severity="info">{interpolate(t.legacy.noneOnChain, { chain: chainName })}</Alert>);
  }
  if (legacy.loading || legacy.scans === null) {
    return shell(<Typography color="text.secondary">{t.legacy.loading}</Typography>);
  }

  const scans = legacy.scans;
  const withAssets = scans.filter(scanHasAssets);
  const problems = scans.filter((s) => s.status === 'readFailed' || s.status === 'unsupported');
  const operatorNeeded = withAssets.filter(needsOperator);

  return shell(
    <>
      {problems.map((s) => (
        <Alert key={s.exchange.address} severity="warning">
          {interpolate(s.status === 'readFailed' ? t.legacy.readFailed : t.legacy.unsupported, {
            address: s.exchange.address,
          })}
        </Alert>
      ))}

      {withAssets.length === 0 && problems.length === 0 && (
        <Alert severity="success">{interpolate(t.legacy.noneFound, { chain: chainName })}</Alert>
      )}

      {withAssets.map((s) => (
        <LegacyExchangeCard key={s.exchange.address} scan={s} busy={busy} onAction={runAction} />
      ))}

      {operatorNeeded.length > 0 && (
        <ContactCard account={wallet.address} scans={operatorNeeded} />
      )}
    </>
  );
}

// ----------------------------------------------------------------------

function BlockNote({ block }: { block: LegacyBlock }) {
  return (
    <Typography variant="caption" color={block.needsOperator ? 'error.main' : 'warning.main'} sx={{ display: 'block', whiteSpace: 'normal' }}>
      {legacyBlockMessage(block, nowSec())}
    </Typography>
  );
}

function LegacyExchangeCard({
  scan,
  busy,
  onAction,
}: {
  scan: LegacyExchangeScan;
  busy: Record<string, boolean>;
  onAction: (a: Action) => void;
}) {
  const { exchange, usdcDecimals: dec } = scan;
  const href = explorerAddr(exchange.address, exchange.chainId);
  const wKey = `w:${exchange.address}`;
  const now = nowSec();

  return (
    <Card sx={{ p: 3, border: '1px solid', borderColor: 'divider' }} data-testid="legacy-exchange-card">
      <Stack spacing={2}>
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1}>
          <Box>
            <Typography variant="caption" color="text.secondary">{t.legacy.card.contract}</Typography>
            <Typography sx={{ fontFamily: MONO, wordBreak: 'break-all' }}>
              {href ? (
                <Link href={href} target="_blank" rel="noopener noreferrer">{exchange.address}</Link>
              ) : exchange.address}
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {interpolate(t.legacy.card.period, { from: exchange.activeFrom, until: exchange.activeUntil })}
          </Typography>
        </Stack>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={4}>
          <Box>
            <Typography variant="caption" color="text.secondary">{t.legacy.card.freeMargin}</Typography>
            <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmt(scan.freeMargin, dec)} {STABLE_LABEL}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">{t.legacy.card.contractBalance}</Typography>
            <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {scan.exchangeBalance === null ? '—' : `${fmt(scan.exchangeBalance, dec)} ${STABLE_LABEL}`}
            </Typography>
          </Box>
        </Stack>

        {scan.withdraw && (
          <Stack spacing={1} alignItems="flex-start">
            <Button
              variant="contained"
              disabled={!scan.withdraw.preflight.ok || scan.withdraw.amount === 0n || !!busy[wKey]}
              onClick={() => scan.withdraw && onAction({ kind: 'withdraw', scan, amount: scan.withdraw.amount })}
              sx={{ textTransform: 'none' }}
            >
              {busy[wKey]
                ? t.legacy.withdraw.working
                : interpolate(t.legacy.withdraw.button, { amount: fmt(scan.withdraw.amount, dec), token: STABLE_LABEL })}
            </Button>
            {scan.withdraw.shortfall > 0n && (
              <Typography variant="caption" color="error.main">
                {interpolate(t.legacy.withdraw.partial, {
                  amount: `${fmt(scan.withdraw.amount, dec)} ${STABLE_LABEL}`,
                  shortfall: `${fmt(scan.withdraw.shortfall, dec)} ${STABLE_LABEL}`,
                })}
              </Typography>
            )}
            {!scan.withdraw.preflight.ok && <BlockNote block={scan.withdraw.preflight.block} />}
          </Stack>
        )}

        {scan.truncated && (
          <Typography variant="caption" color="error.main">
            {interpolate(t.legacy.card.truncated, { max: MAX_POSITION_IDS })}
          </Typography>
        )}

        <Divider />

        <Typography variant="subtitle2">{t.legacy.card.openPositions}</Typography>
        {scan.positions.length === 0 ? (
          <Typography variant="body2" color="text.secondary">{t.legacy.card.noPositions}</Typography>
        ) : (
          <>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t.legacy.column.id}</TableCell>
                    <TableCell>{t.legacy.column.asset}</TableCell>
                    <TableCell>{t.legacy.column.side}</TableCell>
                    <TableCell align="right">{t.legacy.column.margin}</TableCell>
                    <TableCell align="right">{t.legacy.column.leverage}</TableCell>
                    <TableCell align="right">{t.legacy.column.entryPrice}</TableCell>
                    <TableCell>{t.legacy.column.oracleAge}</TableCell>
                    <TableCell align="right">{t.legacy.column.action}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {scan.positions.map((p) => {
                    const cKey = `c:${exchange.address}:${String(p.id)}`;
                    const stale = settlesAtStalePrice(p, scan.maxPriceAgeSec, now, FALLBACK_MAX_PRICE_AGE_SEC);
                    return (
                      <TableRow key={String(p.id)}>
                        <TableCell sx={{ fontFamily: MONO }}>#{String(p.id)}</TableCell>
                        <TableCell>{ASSET_LABEL[p.asset] ?? SHORT(p.asset)}</TableCell>
                        <TableCell>{p.isLong ? t.legacy.side.long : t.legacy.side.short}</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                          {fmt(p.margin, dec)} {STABLE_LABEL}
                        </TableCell>
                        <TableCell align="right">{String(p.leverage)}×</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                          {fmt(p.entryPrice, 18, 4)}
                        </TableCell>
                        <TableCell>{p.oracleUpdatedAt === null ? t.freshness.unknownAge : ageLabel(p.oracleUpdatedAt, now)}</TableCell>
                        <TableCell align="right" sx={{ maxWidth: 280 }}>
                          <Button
                            size="small"
                            variant="outlined"
                            color="error"
                            disabled={!p.close.ok || !!busy[cKey]}
                            onClick={() => onAction({ kind: 'close', scan, position: p })}
                            sx={{ textTransform: 'none', minWidth: 64 }}
                          >
                            {busy[cKey] ? t.legacy.close.working : t.legacy.close.button}
                          </Button>
                          {!p.close.ok && <BlockNote block={p.close.block} />}
                          {stale && p.oracleUpdatedAt !== null && (
                            <Typography variant="caption" color="warning.main" sx={{ display: 'block', whiteSpace: 'normal' }}>
                              {interpolate(t.legacy.staleWarning, { age: ageLabel(p.oracleUpdatedAt, now) })}
                            </Typography>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
            <Typography variant="caption" color="text.secondary">{t.legacy.close.afterClose}</Typography>
          </>
        )}
      </Stack>
    </Card>
  );
}

// ----------------------------------------------------------------------

/**
 * 需要營運方處理時的聯絡區塊。聯絡方式只來自租戶設定（tenant.support）；租戶沒有
 * 設定時明講「沒有設定」，而不是編一個信箱出來。下面附上客服處理時需要的資訊，
 * 讓使用者一鍵複製。
 */
function ContactCard({ account, scans }: { account: string; scans: LegacyExchangeScan[] }) {
  const [copied, setCopied] = useState(false);
  const { email, url } = tenant.support;

  const details = [
    `${t.legacy.contact.detailsWallet}: ${account}`,
    ...scans.map((s) => {
      const blocked = s.positions.filter((p) => !p.close.ok).map((p) => `#${String(p.id)}`);
      const line = `${t.legacy.contact.detailsContract}: ${s.exchange.address} (chainId ${s.exchange.chainId})`;
      return blocked.length > 0 ? `${line} · ${t.legacy.contact.detailsPositions}: ${blocked.join(', ')}` : line;
    }),
  ].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Alert severity="error" data-testid="legacy-contact">
      <AlertTitle>{t.legacy.contact.title}</AlertTitle>
      <Stack spacing={1}>
        <Typography variant="body2">{email || url ? t.legacy.contact.body : t.legacy.contact.none}</Typography>
        {email && (
          <Typography variant="body2">
            {t.legacy.contact.email}
            <Link href={`mailto:${email}`}>{email}</Link>
          </Typography>
        )}
        {url && (
          <Typography variant="body2">
            <Link href={url} target="_blank" rel="noopener noreferrer">{t.legacy.contact.url}</Link>
          </Typography>
        )}
        <Box
          component="pre"
          sx={{ m: 0, p: 1.5, borderRadius: 1, bgcolor: 'background.neutral', fontFamily: MONO, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
        >
          {details}
        </Box>
        <Box>
          <Button size="small" variant="outlined" color="inherit" onClick={() => void copy()} sx={{ textTransform: 'none' }}>
            {copied ? t.legacy.contact.copied : t.legacy.contact.copy}
          </Button>
        </Box>
      </Stack>
    </Alert>
  );
}

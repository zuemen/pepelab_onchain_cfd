import { useState, useEffect, useCallback } from 'react';
import { parseEther, type ContractTransactionResponse } from 'ethers';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import TableRow from '@mui/material/TableRow';
import Container from '@mui/material/Container';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import { Icon } from '@iconify/react';

import { t, interpolate } from 'src/locales';
import { assetPolicy } from 'src/tenant';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { useContracts } from 'src/hooks/useContracts';
import { useV2Contracts } from 'src/hooks/useV2Contracts';
import { CHAIN_NAMES } from 'src/contracts/addresses';
import { getV2Stack } from 'src/contracts/deployment';
import { f18 } from 'src/lib/pepefi/format';
import { withStable } from 'src/lib/pepefi/tokenLabel';
import { safeRead } from 'src/lib/pepefi/safeRead';
import { explorerTx } from 'src/lib/pepefi/notify';
import { prettyError } from 'src/lib/pepefi/errorMessages';
import { parseAllocs } from 'src/lib/pepefi/leaderboardMetrics';
import {
  planAdoption,
  runAdoption,
  toSpotAllocation,
  type SpotLeg,
  type LegStatus,
  type LegOutcome,
  type PlannedLeg,
  type AdoptionResult,
} from 'src/lib/pepefi/allocationAdoption';
import AssetIcon from 'src/components/pepefi/AssetIcon';
import { MONO, shortAddr } from 'src/components/pepefi/brandKit';
import { TableSkeleton } from 'src/components/pepefi/Skeleton';

// ----------------------------------------------------------------------
// #149 / ADR-007：Simple Mode 的配置市集。採用 = 照配置發布者目前公開的比例，
// 用 AssetVaultV2_4.mint 把現貨代幣買進使用者自己的錢包——快照式、無槓桿、
// 沒有鏈上的「誰採用了誰」紀錄。可不可以用現貨表達、怎麼拆金額、多筆交易
// 怎麼依序送與失敗時怎麼回報，全部在 lib/pepefi/allocationAdoption（有測試）；
// 這個元件只負責讀鏈、接上 ethers、把結果畫出來。

const asTx = (x: unknown) => x as ContractTransactionResponse;

/** 送出前就判斷出來的失敗，做成跟 ethers 解碼後的 custom error 同一個形狀，讓 prettyError 用同一份對照表。 */
const namedRevert = (name: string) => ({ revert: { name } });

interface PublishedAllocation {
  publisher: string;
  name: string;
  legs: SpotLeg[];
}

const fWeight = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

const STATUS_COLOR: Record<LegStatus, 'default' | 'info' | 'success' | 'error' | 'warning'> = {
  waiting: 'default',
  buying: 'info',
  bought: 'success',
  failed: 'error',
  unavailable: 'warning',
  notStarted: 'default',
};

export default function AllocationMarketplace() {
  const wallet = usePepefiWallet();
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const v2 = useV2Contracts(wallet.provider, wallet.signer, wallet.chainId);

  const [items, setItems] = useState<PublishedAllocation[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<PublishedAllocation | null>(null);

  const load = useCallback(async () => {
    if (!contracts || !v2) return;
    setLoading(true);
    setLoadError(null);
    try {
      const publishers = (await contracts.registry.getAllTraders()) as string[];
      const read = await Promise.all(
        publishers.map(async (publisher) => {
          // 每位發布者各自 safeRead：一個人讀不到，不該讓整個市集變空。
          const [info, latest] = await Promise.all([
            safeRead(contracts.registry.traders(publisher) as Promise<[boolean, string, bigint]>, null),
            safeRead(contracts.registry.getLatestStrategy(publisher) as Promise<[unknown[], bigint]>, null),
          ]);
          if (!latest) return null; // 從未發布
          return {
            publisher,
            name: info?.[1] ?? '',
            spot: toSpotAllocation(parseAllocs(latest[0] as unknown[]), v2.tokens),
          };
        })
      );
      const published = read.filter((r): r is NonNullable<typeof r> => r !== null);
      setItems(
        published.flatMap((p) => (p.spot.ok ? [{ publisher: p.publisher, name: p.name, legs: p.spot.legs }] : []))
      );
      setHiddenCount(published.filter((p) => !p.spot.ok).length);
    } catch (e) {
      console.error('[allocations] load failed', e);
      setLoadError(prettyError(e, 'adopt'));
    } finally {
      setLoading(false);
    }
  }, [contracts, v2]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">{t.adopt.connectWallet}</Typography>
      </Box>
    );
  }

  const chainName =
    wallet.chainId !== null
      ? (CHAIN_NAMES[wallet.chainId] ?? interpolate(t.adopt.empty.unknownChain, { chainId: wallet.chainId }))
      : interpolate(t.adopt.empty.unknownChain, { chainId: '—' });

  // 「這條鏈有沒有部署」是靜態的地址表查詢，跟「現在連不連得上」是兩件事——
  // 模擬錢包（無 provider/signer）在一條已部署的鏈上也會讓 useV2Contracts 回傳
  // null，那不是「未部署」，是模擬錢包本來就讀不到任何鏈上資料（見 CONTEXT.md
  // 的 Mock Wallet 詞條）。兩種原因分開講，不要把後者講成前者。
  const deployedHere = !!getV2Stack(wallet.chainId);

  return (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
            {t.adopt.title}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {t.adopt.subtitle}
          </Typography>
        </Box>
        <IconButton size="small" color="inherit" onClick={() => void load()} aria-label={t.adopt.refreshAria}>
          <Icon icon="solar:restart-bold-duotone" width={16} />
        </IconButton>
      </Box>

      {!deployedHere ? (
        <Alert severity="info">{t.adopt.notDeployed}</Alert>
      ) : !v2 ? (
        <Alert severity="info">{wallet.isMock ? t.adopt.mockWallet : t.adopt.notConnected}</Alert>
      ) : (
        <>
          <Alert severity="info" variant="outlined">
            {t.adopt.snapshotNote}
          </Alert>

          {loadError && (
            <Alert severity="error">
              <strong>{t.adopt.loadFailed}</strong> {loadError}
            </Alert>
          )}

          {loading ? (
            <Card>
              <TableSkeleton rows={4} cols={3} />
            </Card>
          ) : items.length === 0 ? (
            <Card sx={{ p: 4, textAlign: 'center' }}>
              <Typography variant="h6">{t.adopt.empty.title}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {interpolate(t.adopt.empty.description, { chain: chainName })}
              </Typography>
            </Card>
          ) : (
            <Grid container spacing={2}>
              {items.map((item) => (
                <Grid key={item.publisher} size={{ xs: 12, sm: 6, md: 4 }}>
                  <AllocationCard item={item} onAdopt={() => setAdopting(item)} />
                </Grid>
              ))}
            </Grid>
          )}

          {!loading && hiddenCount > 0 && (
            <Typography variant="caption" color="text.secondary">
              {interpolate(t.adopt.hiddenNote, { count: hiddenCount })}
            </Typography>
          )}
        </>
      )}

      {adopting && <AdoptDialog item={adopting} onClose={() => setAdopting(null)} />}
    </Container>
  );
}

// ----------------------------------------------------------------------

function AllocationCard({ item, onAdopt }: { item: PublishedAllocation; onAdopt: () => void }) {
  return (
    <Card sx={{ p: 2.5, height: '100%', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }} noWrap>
          {item.name || t.adopt.card.noName}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
          {shortAddr(item.publisher)} · {interpolate(t.adopt.card.assetCount, { count: item.legs.length })}
        </Typography>
      </Box>

      <Stack spacing={1} sx={{ flex: 1 }}>
        {item.legs.map((leg) => (
          <Box key={leg.assetId}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <AssetIcon symbol={leg.symbol} size={20} />
              <Typography variant="body2" sx={{ flex: 1, fontWeight: 600 }}>
                {leg.symbol}
              </Typography>
              <Typography variant="body2" sx={{ fontFamily: MONO }}>
                {fWeight(leg.weightBps)}
              </Typography>
            </Stack>
            <Box sx={{ mt: 0.5, height: 4, borderRadius: 2, bgcolor: 'action.hover', overflow: 'hidden' }}>
              <Box sx={{ width: `${leg.weightBps / 100}%`, height: '100%', bgcolor: 'primary.main' }} />
            </Box>
          </Box>
        ))}
      </Stack>

      <Button variant="contained" onClick={onAdopt} sx={{ textTransform: 'none', fontWeight: 'bold' }}>
        {t.adopt.card.adopt}
      </Button>
    </Card>
  );
}

// ----------------------------------------------------------------------

function AdoptDialog({ item, onClose }: { item: PublishedAllocation; onClose: () => void }) {
  const wallet = usePepefiWallet();
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const v2 = useV2Contracts(wallet.provider, wallet.signer, wallet.chainId);

  const [amount, setAmount] = useState('');
  const [balance, setBalance] = useState<bigint | null>(null);
  // 只用來提早把確認鈕關掉、講原因；真正的閘門在 confirm() 的 check 裡，讀不到會擋。
  const [vaultGate, setVaultGate] = useState<{ paused: boolean; halted: boolean }>({ paused: false, halted: false });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<LegOutcome[] | null>(null);
  const [result, setResult] = useState<AdoptionResult | null>(null);

  useEffect(() => {
    if (!contracts || !v2 || !wallet.address) return;
    void (async () => {
      const [bal, paused, halted] = await Promise.all([
        safeRead(contracts.usdc.balanceOf(wallet.address) as Promise<bigint>, null),
        safeRead(v2.vault.paused() as Promise<boolean>, false),
        safeRead(v2.vault.mintingHalted() as Promise<boolean>, false),
      ]);
      setBalance(bal);
      setVaultGate({ paused, halted });
    })();
  }, [contracts, v2, wallet.address, result]);

  let parsed: bigint | null = null;
  try {
    parsed = amount ? parseEther(amount) : null;
  } catch {
    parsed = null;
  }
  const plan = parsed !== null ? planAdoption(parsed, item.legs) : null;

  // 白標租戶白名單：配置裡只要有一檔不在白名單，整筆採用就不送——採用是「照比例全買」，
  // 自動略過某一檔等於悄悄改掉發布者的配置比例。
  const tenantBlocked = item.legs.some((leg) => !assetPolicy.canOpen(leg.assetId));

  const blockingReason =
    tenantBlocked ? t.common.tenant.assetNotEnabled
    : vaultGate.paused ? t.adopt.dialog.vaultPaused
    : vaultGate.halted ? t.adopt.dialog.mintingHalted
    : !amount ? null
    : parsed === null ? t.adopt.dialog.badAmount
    : !plan?.ok ? t.adopt.dialog.tooSmall
    : balance !== null && parsed > balance ? t.adopt.dialog.insufficientBalance
    : null;

  const canConfirm = !!plan?.ok && !blockingReason && !running && !result && !!contracts && !!v2;

  const confirm = async () => {
    if (!plan?.ok || !contracts || !v2 || tenantBlocked) return;
    setRunning(true);
    try {
      const outcome = await runAdoption(
        plan.legs,
        {
          check: async (leg) => {
            // 送出前重演 mint() 自己的閘門（AssetVaultV2_4.mint）。previewMint 只擋
            // 未註冊／沒價格／價格過期；暫停、鎖存的鑄造暫停、發行上限要自己讀。
            // 不走 safeRead——讀不到就當作買不了，不預設放行。唯一重演不了的是
            // ReserveRatioTooLow（轉帳之後才算），那一種仍可能落到 partial。
            const [paused, halted, preview, outstanding, cap] = await Promise.all([
              v2.vault.paused() as Promise<boolean>,
              v2.vault.mintingHalted() as Promise<boolean>,
              v2.vault.previewMint(leg.assetId, leg.usdc) as Promise<[bigint, bigint]>,
              v2.vault.exposureOf(leg.assetId) as Promise<bigint>,
              v2.vault.assetCap(leg.assetId) as Promise<bigint>,
            ]);
            if (paused) throw namedRevert('EnforcedPause');
            if (halted) throw namedRevert('MintingHalted');
            if (outstanding + preview[0] > cap) throw namedRevert('CapExceeded');
          },
          approve: async (total) => {
            await asTx(await contracts.usdc.approve(v2.vaultAddr, total)).wait();
          },
          mint: async (leg) => {
            const tx = asTx(await v2.vault.mint(leg.assetId, leg.usdc));
            await tx.wait();
            return tx.hash;
          },
        },
        setProgress
      );
      setResult(outcome);
    } finally {
      setRunning(false);
    }
  };

  // 還沒輸入金額 → 只有比例；有合法金額 → 加上每檔金額；開始採用後 → 再加上狀態。
  const rows: (SpotLeg | PlannedLeg | LegOutcome)[] = progress ?? (plan?.ok ? plan.legs : item.legs);

  return (
    <Dialog open fullWidth maxWidth="sm" onClose={running ? undefined : onClose} disableEscapeKeyDown={running}>
      <DialogTitle>{interpolate(t.adopt.dialog.title, { name: item.name || t.adopt.card.noName })}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {t.adopt.snapshotNote}
        </Typography>

        <TextField
          label={t.adopt.dialog.amountLabel}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={running || !!result}
          inputMode="decimal"
          helperText={balance !== null ? interpolate(t.adopt.dialog.balance, { amount: f18(balance, { dp: 2 }) }) : ' '}
          fullWidth
        />

        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t.adopt.dialog.colAsset}</TableCell>
              <TableCell align="right">{t.adopt.dialog.colWeight}</TableCell>
              <TableCell align="right">{t.adopt.dialog.colAmount}</TableCell>
              {progress && <TableCell align="right">{t.adopt.dialog.colStatus}</TableCell>}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => {
              const outcome = 'status' in r ? r : null;
              const href = outcome?.txHash ? explorerTx(outcome.txHash, wallet.chainId) : null;
              return (
                <TableRow key={r.assetId}>
                  <TableCell>
                    <Stack direction="row" alignItems="center" spacing={1}>
                      <AssetIcon symbol={r.symbol} size={18} />
                      <span>{r.symbol}</span>
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO }}>
                    {fWeight(r.weightBps)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO }}>
                    {'usdc' in r ? withStable(f18(r.usdc, { dp: 2 })) : '—'}
                  </TableCell>
                  {outcome && (
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="flex-end">
                        <Chip size="small" color={STATUS_COLOR[outcome.status]} label={t.adopt.status[outcome.status]} />
                        {href && (
                          <Link href={href} target="_blank" rel="noopener noreferrer" variant="caption">
                            {t.adopt.dialog.viewTx}
                          </Link>
                        )}
                      </Stack>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {blockingReason && !result && <Alert severity="warning">{blockingReason}</Alert>}
        {plan?.ok && !blockingReason && !progress && (
          <Typography variant="caption" color="text.secondary">
            {interpolate(t.adopt.dialog.txCount, { total: plan.legs.length + 1, legs: plan.legs.length })}
          </Typography>
        )}
        {result && <OutcomeAlert result={result} />}
      </DialogContent>
      <DialogActions>
        {result ? (
          <Button onClick={onClose}>{t.adopt.dialog.close}</Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={running} color="inherit">
              {t.adopt.dialog.cancel}
            </Button>
            <Button variant="contained" disabled={!canConfirm} onClick={() => void confirm()}>
              {running ? t.adopt.dialog.running : t.adopt.dialog.confirm}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

/** 結果逐檔講清楚——部分成功時使用者一定要知道自己手上現在有什麼、少了什麼。 */
function OutcomeAlert({ result }: { result: AdoptionResult }) {
  const names = (status: LegStatus) =>
    result.legs.filter((l) => l.status === status).map((l) => l.symbol).join(t.adopt.listSeparator);
  const firstError = result.error ?? result.legs.find((l) => l.error !== undefined)?.error;
  const reason = firstError !== undefined ? prettyError(firstError, 'adopt') : null;

  const summary = (): { severity: 'success' | 'warning' | 'error'; text: string } => {
    switch (result.outcome) {
      case 'complete':
        return { severity: 'success', text: interpolate(t.adopt.outcome.complete, { count: result.legs.length }) };
      case 'partial':
        return {
          severity: 'warning',
          text: interpolate(t.adopt.outcome.partial, { bought: names('bought'), failed: names('failed') }),
        };
      case 'failed':
        return { severity: 'error', text: t.adopt.outcome.failed };
      case 'blocked':
        return { severity: 'warning', text: interpolate(t.adopt.outcome.blocked, { symbols: names('unavailable') }) };
      default: {
        const exhaustive: never = result.outcome;
        return exhaustive;
      }
    }
  };
  const { severity, text } = summary();

  return (
    <Alert severity={severity}>
      {text}
      {reason && <Box sx={{ mt: 0.5 }}>{reason}</Box>}
    </Alert>
  );
}

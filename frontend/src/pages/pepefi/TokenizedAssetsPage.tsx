import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react'
import { Contract, parseEther, type ContractTransactionResponse } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { useV2Contracts } from 'src/hooks/useV2Contracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { explorerTx, explorerName } from 'src/lib/pepefi/notify'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { safeRead } from 'src/lib/pepefi/safeRead'
import {
  ASSET_IDS, getAddresses, getSynthTokens, getV2Stack, type AssetSymbol,
} from 'src/contracts/addresses'
import { ASSET_META } from 'src/lib/pepefi/assetMeta'
import SyntheticAssetABI   from 'src/contracts/abi/SyntheticAsset.json'
import SyntheticAssetV2ABI from 'src/contracts/abi/SyntheticAssetV2.json'
import AssetIcon from 'src/components/pepefi/AssetIcon'
import Skeleton from 'src/components/pepefi/Skeleton'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Snackbar from '@mui/material/Snackbar';
import InputAdornment from '@mui/material/InputAdornment';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Divider from '@mui/material/Divider';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import { Icon } from '@iconify/react';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
const VERSION_KEY = 'pepefi:vaultVersion'

type VaultVersion = 'v1' | 'v2'

const f18 = (v: bigint, d = 4) => (Number(v) / 1e18).toFixed(d)
const fUsd = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Contract methods come off a JSON ABI, so ethers types them loosely. Narrow to
// the transaction shape we actually use rather than casting through `any`.
const asTx = (t: unknown) => t as ContractTransactionResponse

interface Row {
  price:   bigint   // 8-dec oracle price
  balance: bigint   // 18-dec token balance
  cap:     bigint   // V2 only: per-asset issuance ceiling
  issued:  bigint   // V2 only: currently outstanding
}

interface V2Health {
  reserveRatioBps: bigint | null
  paused:          boolean | null
  accruedFees:     bigint | null
  /**
   * GuardedOracle fails closed on a stale price — getPrice reverts rather than
   * returning old data. AssetVaultV2.outstandingValue() calls it directly, so
   * once any price ages past maxPriceAge both reserveRatioBps() AND mint()
   * revert. Surfaced here so the page explains it instead of showing a bare "—"
   * and letting the user hit a confusing revert on Buy.
   */
  oracleStale: boolean
}

export default function TokenizedAssetsPage() {
  const wallet    = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const v2        = useV2Contracts(wallet.provider, wallet.signer, wallet.chainId)
  const addr      = getAddresses(wallet.chainId)

  const v2Available = !!getV2Stack(wallet.chainId)

  const [version, setVersion] = useState<VaultVersion>(() => {
    try { return (localStorage.getItem(VERSION_KEY) as VaultVersion) ?? 'v1' }
    catch { return 'v1' }
  })
  const switchVersion = (v: VaultVersion) => {
    setVersion(v)
    try { localStorage.setItem(VERSION_KEY, v) } catch { /* private mode */ }
  }

  // If the stored preference is v2 but this chain has no V2, fall back rather
  // than rendering an empty page.
  const isV2 = version === 'v2' && !!v2

  // One set of "active" handles so the logic below never branches on version.
  const activeTokens    = isV2 ? v2!.tokens : getSynthTokens(wallet.chainId)
  const activeVault     = isV2 ? v2!.vault  : contracts?.assetVault
  const activeVaultAddr = isV2 ? v2!.vaultAddr : addr?.AssetVault
  const activeOracle    = isV2 ? v2!.oracle : contracts?.oracle
  const activeTokenAbi  = isV2 ? SyntheticAssetV2ABI : SyntheticAssetABI

  const symbols = Object.keys(activeTokens) as AssetSymbol[]
  const vaultReady =
    !!activeVaultAddr && activeVaultAddr !== ZERO_ADDR && symbols.length > 0

  const [rows, setRows]       = useState<Record<string, Row>>({})
  const [health, setHealth]   = useState<V2Health>({
    reserveRatioBps: null, paused: null, accruedFees: null, oracleStale: false,
  })
  const [loading, setLoading] = useState(true)
  const [dlg, setDlg]         = useState<{ sym: AssetSymbol; mode: 'buy' | 'sell' } | null>(null)
  const [amount, setAmount]   = useState('')
  const [quote, setQuote]     = useState<{ out: bigint; fee: bigint } | null>(null)
  const [busy, setBusy]       = useState(false)
  const [toast, setToast]     = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)

  const notify = useCallback((msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
  }, [])

  const refresh = useCallback(async () => {
    if (!contracts || !vaultReady || !wallet.address || !activeVault || !activeOracle) {
      setLoading(false); return
    }
    const next: Record<string, Row> = {}
    await Promise.all(
      symbols.map(async (sym) => {
        const id = ASSET_IDS[sym]
        const [priceRes, balance, cap, issued] = await Promise.all([
          safeRead(activeOracle.getPrice(id) as Promise<[bigint, bigint]>, [0n, 0n] as [bigint, bigint]),
          safeRead(
            new Contract(activeTokens[sym]!, activeTokenAbi, contracts.usdc.runner)
              .balanceOf(wallet.address) as Promise<bigint>,
            0n,
          ),
          // V2-only views; on V1 these reject and fall back, which is why each
          // read is isolated rather than batched into one try.
          isV2 ? safeRead(activeVault.assetCap(id) as Promise<bigint>, 0n) : Promise.resolve(0n),
          isV2 ? safeRead(activeVault.exposureOf(id) as Promise<bigint>, 0n) : Promise.resolve(0n),
        ])
        next[sym] = { price: priceRes[0], balance, cap, issued }
      })
    )
    setRows(next)

    if (isV2) {
      const [ratio, paused, fees] = await Promise.all([
        safeRead(activeVault.reserveRatioBps() as Promise<bigint>, -1n),
        safeRead(activeVault.paused() as Promise<boolean>, null as unknown as boolean),
        safeRead(activeVault.accruedFees() as Promise<bigint>, -1n),
      ])
      // reserveRatioBps failing while accruedFees succeeds points at the oracle
      // rather than at the vault being unreachable — accruedFees touches no
      // price, reserveRatioBps prices every outstanding asset.
      const ratioFailed = ratio < 0n
      const vaultReachable = fees >= 0n
      setHealth({
        reserveRatioBps: ratio >= 0n ? ratio : null,
        paused: typeof paused === 'boolean' ? paused : null,
        accruedFees: fees >= 0n ? fees : null,
        oracleStale: ratioFailed && vaultReachable,
      })
    } else {
      setHealth({ reserveRatioBps: null, paused: null, accruedFees: null, oracleStale: false })
    }

    setLoading(false)
    // symbols/activeTokens derive from chainId + version, both dependencies below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts, vaultReady, wallet.address, wallet.chainId, version, isV2])

  useEffect(() => { void refresh() }, [refresh])

  // Live quote from the contract rather than client-side arithmetic, so the V2
  // fee is the real one. V1 returns a single uint256; V2 returns
  // (amount, feePaid) for BOTH previewMint and previewRedeem — verified against
  // the ABI, not assumed.
  useEffect(() => {
    let cancelled = false
    if (!dlg || !activeVault || !amount) { setQuote(null); return undefined }

    void (async () => {
      let parsed: bigint
      try { parsed = parseEther(amount) } catch { setQuote(null); return }
      if (parsed <= 0n) { setQuote(null); return }

      const id = ASSET_IDS[dlg.sym]
      try {
        const raw = dlg.mode === 'buy'
          ? await activeVault.previewMint(id, parsed)
          : await activeVault.previewRedeem(id, parsed)
        if (cancelled) return
        if (isV2) {
          const [out, fee] = raw as unknown as [bigint, bigint]
          setQuote({ out, fee })
        } else {
          setQuote({ out: raw as unknown as bigint, fee: 0n })
        }
      } catch {
        if (!cancelled) setQuote(null)   // asset closed, stale price, etc.
      }
    })()

    return () => { cancelled = true }
  }, [dlg, amount, activeVault, isV2])

  const closeDlg = () => { setDlg(null); setAmount(''); setQuote(null) }

  const doBuy = async (sym: AssetSymbol) => {
    if (!contracts || !activeVault || !activeVaultAddr) return
    let usdcAmt: bigint
    try { usdcAmt = parseEther(amount) } catch { notify('金額格式不正確', false); return }
    if (usdcAmt <= 0n) { notify('請輸入大於 0 的金額', false); return }

    setBusy(true)
    try {
      // Approve the ACTIVE vault — hardcoding V1's address here would send the
      // allowance to the wrong contract and the mint would revert.
      const approveTx = asTx(await contracts.usdc.approve(activeVaultAddr, usdcAmt))
      await approveTx.wait()
      const tx = asTx(await activeVault.mint(ASSET_IDS[sym], usdcAmt))
      await tx.wait()
      notify(`已買入 ${sym} ✓ — 代幣已進入你的錢包`, true, tx.hash)
      closeDlg()
      await refresh()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setBusy(false) }
  }

  const doSell = async (sym: AssetSymbol) => {
    if (!activeVault) return
    let tokenAmt: bigint
    try { tokenAmt = parseEther(amount) } catch { notify('數量格式不正確', false); return }
    if (tokenAmt <= 0n) { notify('請輸入大於 0 的數量', false); return }

    setBusy(true)
    try {
      const tx = asTx(await activeVault.redeem(ASSET_IDS[sym], tokenAmt))
      await tx.wait()
      notify(`已賣出 ${sym} ✓ — USDC 已退回錢包`, true, tx.hash)
      closeDlg()
      await refresh()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setBusy(false) }
  }

  // EIP-747: make the token visible in MetaMask. This is the point of the page —
  // the token should be visibly sitting in the wallet.
  const addToWallet = async (sym: AssetSymbol) => {
    const eth = window.ethereum
    if (!eth) { notify('找不到錢包擴充功能', false); return }
    try {
      await eth.request({
        method: 'wallet_watchAsset',
        params: { type: 'ERC20', options: { address: activeTokens[sym], symbol: sym, decimals: 18 } },
      })
    } catch (e) {
      notify(prettyError(e), false)
    }
  }

  const versionSwitcher = (
    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
      <ToggleButtonGroup
        size="small" exclusive value={version}
        onChange={(_, v) => v && switchVersion(v)}
      >
        <ToggleButton value="v1" sx={{ textTransform: 'none', px: 2 }}>V1（原始版）</ToggleButton>
        <Tooltip title={v2Available ? '' : '此網路尚未部署 V2'} arrow>
          {/* span keeps the tooltip alive on a disabled control */}
          <span>
            <ToggleButton value="v2" disabled={!v2Available} sx={{ textTransform: 'none', px: 2 }}>
              V2（硬化版）
            </ToggleButton>
          </span>
        </Tooltip>
      </ToggleButtonGroup>
      {isV2 && <Chip size="small" color="success" variant="outlined" label="SafeERC20 · 重入保護 · 可暫停" />}
    </Stack>
  )

  const diffTable = (
    <Accordion sx={{ mt: 1 }}>
      <AccordionSummary expandIcon={<Icon icon="solar:alt-arrow-down-linear" />}>
        <Typography sx={{ fontWeight: 'bold' }}>V1 / V2 差異對照</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>項目</TableCell>
                <TableCell>V1</TableCell>
                <TableCell>V2</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {[
                ['ERC-20 轉帳', '裸 transfer', 'SafeERC20'],
                ['重入保護', '無', 'ReentrancyGuard'],
                ['暫停機制', '無', 'Pausable'],
                ['權限模型', 'Ownable（單一 owner）', 'AccessControl（角色分離）'],
                ['可升級性', '不可升級', 'UUPS proxy'],
                ['Oracle', 'MockOracle（單一 key）', 'GuardedOracle（多 keeper + 偏差上限）'],
                ['發行上限', '無', '每資產 cap'],
                ['儲備率保護', '無', '低於下限拒絕 mint'],
                ['手續費', '無', 'mint 手續費'],
              ].map(([k, a, b]) => (
                <TableRow key={k}>
                  <TableCell sx={{ fontWeight: 'bold' }}>{k}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{a}</TableCell>
                  <TableCell sx={{ color: 'success.main' }}>{b}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          兩套實作並存於鏈上，V1 保留作為對照組。詳見 <b>docs/RISK_MODEL.md</b> 與{' '}
          <b>docs/KNOWN_LIMITATIONS.md</b>。
        </Typography>
      </AccordionDetails>
    </Accordion>
  )

  // ── not deployed on this chain ──────────────────────────────────────────────
  if (!vaultReady) {
    return (
      <Container maxWidth="md" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>代幣化資產</Typography>
          <Typography variant="body2" color="text.secondary">ERC-20 Tokenized Assets</Typography>
        </Box>
        {versionSwitcher}
        <Alert severity="info">
          {isV2
            ? '此網路尚未部署 V2 硬化版金庫。'
            : '代幣化資產尚未在此網路啟用（AssetVault 未部署）。'}
        </Alert>
        {diffTable}
      </Container>
    )
  }

  const ratioPct = health.reserveRatioBps !== null
    ? Number(health.reserveRatioBps) / 100
    : null

  return (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>代幣化資產</Typography>
        <Typography variant="body2" color="text.secondary">ERC-20 Tokenized Assets</Typography>
      </Box>

      {versionSwitcher}

      <Alert severity="info">
        本頁展示<b>代幣化資產（ERC-20）</b>。與交易頁的合成持倉不同，這裡買入的資產會以
        ERC-20 token 形式<b>出現在你的錢包中</b>，可加入 MetaMask 檢視、可轉帳給他人。
        買賣以 <b>USDC</b> 結算，價格取自鏈上 oracle（無滑價）。
      </Alert>

      {/* ── V2 hardening panel ─────────────────────────────────────────────── */}
      {isV2 ? (
        <Card sx={{ p: 2.5 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>
            🛡️ V2 硬化特性（鏈上即時數值）
          </Typography>

          {health.oracleStale && (
            <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>
              <b>GuardedOracle 價格已過期</b>，買賣暫時無法執行。
              這是 fail-closed 的預期行為：預言機拒絕提供過期報價，而金庫的儲備率計算
              會直接呼叫它，所以 <code>reserveRatioBps()</code> 與 <code>mint()</code> 會一起 revert。
              需由 KEEPER_ROLE 重新餵價後恢復。
            </Alert>
          )}
          <Grid container spacing={2.5}>
            <Grid size={{ xs: 12, md: 4 }}>
              <Typography variant="caption" color="text.secondary" display="block">儲備率</Typography>
              <Typography sx={{ fontFamily: MONO, fontWeight: 'bold', fontSize: '1.15rem' }}>
                {ratioPct === null
                  ? '—'
                  : ratioPct > 100000 ? '∞（尚無發行）' : ratioPct.toFixed(1) + '%'}
              </Typography>
              <LinearProgress
                variant="determinate"
                value={ratioPct === null ? 0 : Math.min(100, ratioPct / 2)}
                color={ratioPct !== null && ratioPct < 110 ? 'error' : 'success'}
                sx={{ mt: 0.75, height: 6, borderRadius: 3 }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                金庫 USDC 儲備 / 已發行代幣總值。低於下限時 mint 會被拒絕。
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, md: 4 }}>
              <Typography variant="caption" color="text.secondary" display="block">運作狀態</Typography>
              {health.paused === null ? (
                <Typography sx={{ fontFamily: MONO }}>—</Typography>
              ) : (
                <Chip
                  size="small"
                  color={health.paused ? 'error' : 'success'}
                  label={health.paused ? '已暫停' : '運作中'}
                  sx={{ fontWeight: 'bold', mt: 0.5 }}
                />
              )}
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                Pausable：緊急時可由 PAUSER_ROLE 停止買賣。
              </Typography>

              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>
                累積手續費
              </Typography>
              <Typography sx={{ fontFamily: MONO }}>
                {health.accruedFees === null ? '—' : f18(health.accruedFees, 2) + ' USDC'}
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, md: 4 }}>
              <Typography variant="caption" color="text.secondary" display="block">GuardedOracle</Typography>
              <Link
                href={`https://sepolia.etherscan.io/address/${v2!.oracleAddr}`}
                target="_blank" rel="noopener noreferrer"
                sx={{ fontFamily: MONO, fontSize: '0.8rem', wordBreak: 'break-all' }}
              >
                {v2!.oracleAddr}
              </Link>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                多 keeper 預言機，單次更新偏差超過上限會被拒絕。
              </Typography>
            </Grid>
          </Grid>
        </Card>
      ) : (
        <Alert severity="warning" variant="outlined">
          V1 為初版實作，未包含 SafeERC20、儲備率保護與暫停機制。切換至 V2 查看硬化版本。
        </Alert>
      )}

      <Grid container spacing={2}>
        {symbols.map((sym) => {
          const row = rows[sym]
          const price = row?.price ?? 0n
          const bal   = row?.balance ?? 0n
          const usd   = (Number(bal) / 1e18) * (Number(price) / 1e8)

          return (
            <Grid size={{ xs: 12, sm: 6, md: 4 }} key={sym}>
              <Card sx={{ p: 2.5, height: '100%', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <AssetIcon symbol={sym} size={36} />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', lineHeight: 1.2 }}>{sym}</Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {ASSET_META[ASSET_IDS[sym]]?.name ?? sym}
                    </Typography>
                  </Box>
                </Box>

                <Box>
                  <Typography variant="caption" color="text.secondary" display="block">Oracle 價格</Typography>
                  {loading ? (
                    <Skeleton height={24} sx={{ width: '60%' }} />
                  ) : (
                    <Typography sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                      {price > 0n ? fUsd(Number(price) / 1e8) : '—'}
                    </Typography>
                  )}
                </Box>

                <Box>
                  <Typography variant="caption" color="text.secondary" display="block">我的餘額</Typography>
                  {loading ? (
                    <Skeleton height={24} sx={{ width: '70%' }} />
                  ) : (
                    <Typography sx={{ fontFamily: MONO }}>
                      {f18(bal)} {sym}
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
                        ≈ {fUsd(usd)}
                      </Typography>
                    </Typography>
                  )}
                </Box>

                {isV2 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block">發行量 / 上限</Typography>
                    <Typography variant="caption" sx={{ fontFamily: MONO }}>
                      {f18(row?.issued ?? 0n, 2)} / {(row?.cap ?? 0n) === 0n ? '0（已關閉）' : f18(row?.cap ?? 0n, 2)}
                    </Typography>
                  </Box>
                )}

                <Stack direction="row" spacing={1} sx={{ mt: 'auto', pt: 0.5 }}>
                  <Button
                    size="small" variant="contained" fullWidth
                    disabled={isV2 && (health.paused === true || health.oracleStale)}
                    onClick={() => setDlg({ sym, mode: 'buy' })}
                    sx={{ textTransform: 'none', fontWeight: 'bold' }}
                  >
                    買入
                  </Button>
                  <Button
                    size="small" variant="outlined" fullWidth
                    disabled={bal === 0n || (isV2 && (health.paused === true || health.oracleStale))}
                    onClick={() => setDlg({ sym, mode: 'sell' })}
                    sx={{ textTransform: 'none', fontWeight: 'bold' }}
                  >
                    賣出
                  </Button>
                </Stack>

                <Button
                  size="small" variant="text"
                  onClick={() => void addToWallet(sym)}
                  sx={{ textTransform: 'none', fontSize: '0.75rem', color: 'info.main', alignSelf: 'flex-start' }}
                >
                  ➕ 加入 MetaMask
                </Button>
              </Card>
            </Grid>
          )
        })}
      </Grid>

      <Typography variant="caption" color="text.secondary">
        提示：賣出由金庫的 USDC 儲備支付。若儲備不足會顯示「vault dry」，
        需由管理者呼叫 <Box component="code" sx={{ fontFamily: MONO }}>fundVault()</Box> 補充。
      </Typography>

      <Divider />
      {diffTable}

      {/* buy / sell dialog */}
      <Dialog open={!!dlg} onClose={closeDlg} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 'bold' }}>
          {dlg?.mode === 'buy' ? '買入' : '賣出'} {dlg?.sym}
          <Chip size="small" label={isV2 ? 'V2' : 'V1'} sx={{ ml: 1 }} />
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Chip
              size="small"
              variant="outlined"
              label={`Oracle: ${
                dlg && (rows[dlg.sym]?.price ?? 0n) > 0n
                  ? fUsd(Number(rows[dlg.sym].price) / 1e8)
                  : '—'
              }`}
              sx={{ alignSelf: 'flex-start', fontFamily: MONO }}
            />
            <TextField
              autoFocus fullWidth type="number" size="small"
              label={dlg?.mode === 'buy' ? '支付 USDC 金額' : `賣出 ${dlg?.sym ?? ''} 數量`}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      {dlg?.mode === 'buy' ? 'USDC' : dlg?.sym}
                    </InputAdornment>
                  ),
                },
              }}
            />
            <Box>
              <Typography variant="caption" color="text.secondary" display="block">
                {quote === null
                  ? '輸入金額以取得報價'
                  : dlg?.mode === 'buy'
                    ? `你將獲得 ≈ ${f18(quote.out)} ${dlg?.sym ?? ''}`
                    : `你將收到 ≈ ${fUsd(Number(quote.out) / 1e18)} USDC`}
              </Typography>
              {isV2 && quote !== null && quote.fee > 0n && (
                <Typography variant="caption" color="warning.main" display="block">
                  手續費：{f18(quote.fee, 4)} USDC
                </Typography>
              )}
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDlg} disabled={busy} sx={{ textTransform: 'none' }}>取消</Button>
          <Button
            variant="contained"
            disabled={busy || !amount}
            onClick={() => dlg && void (dlg.mode === 'buy' ? doBuy(dlg.sym) : doSell(dlg.sym))}
            sx={{ textTransform: 'none', fontWeight: 'bold' }}
          >
            {busy ? '處理中…' : '確認'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!toast}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        message={toast?.msg}
        action={
          toast?.hash && explorerTx(toast.hash, wallet.chainId) ? (
            <Button
              color="primary" size="small" component="a"
              href={explorerTx(toast.hash, wallet.chainId)!}
              target="_blank" rel="noopener noreferrer"
            >
              {explorerName(wallet.chainId)}
            </Button>
          ) : null
        }
      />
    </Container>
  )
}

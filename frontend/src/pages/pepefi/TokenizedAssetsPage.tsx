import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react'
import { Contract, parseEther, type ContractTransactionResponse } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { explorerTx, explorerName } from 'src/lib/pepefi/notify'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { ASSET_IDS, getAddresses, getSynthTokens, type AssetSymbol } from 'src/contracts/addresses'
import { ASSET_META } from 'src/lib/pepefi/assetMeta'
import SyntheticAssetABI from 'src/contracts/abi/SyntheticAsset.json'
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

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

const f18 = (v: bigint, d = 4) => (Number(v) / 1e18).toFixed(d)
const fUsd = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Contract methods come off a JSON ABI, so ethers types them loosely. Narrow to
// the transaction shape we actually use rather than casting through `any`.
const asTx = (t: unknown) => t as ContractTransactionResponse

interface Row {
  price:   bigint   // 8-dec oracle price
  balance: bigint   // 18-dec token balance
}

export default function TokenizedAssetsPage() {
  const wallet    = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const addr      = getAddresses(wallet.chainId)
  const synth     = getSynthTokens(wallet.chainId)

  const symbols = Object.keys(synth) as AssetSymbol[]
  const vaultReady =
    !!addr && addr.AssetVault !== ZERO_ADDR && symbols.length > 0

  const [rows, setRows]       = useState<Record<string, Row>>({})
  const [loading, setLoading] = useState(true)
  const [dlg, setDlg]         = useState<{ sym: AssetSymbol; mode: 'buy' | 'sell' } | null>(null)
  const [amount, setAmount]   = useState('')
  const [busy, setBusy]       = useState(false)
  const [toast, setToast]     = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)

  const notify = useCallback((msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
  }, [])

  const refresh = useCallback(async () => {
    if (!contracts || !vaultReady || !wallet.address) { setLoading(false); return }
    const next: Record<string, Row> = {}
    await Promise.all(
      symbols.map(async (sym) => {
        const id = ASSET_IDS[sym]
        let price = 0n
        let balance = 0n
        try { [price] = await contracts.oracle.getPrice(id) as [bigint, bigint] } catch { price = 0n }
        try {
          const token = new Contract(synth[sym]!, SyntheticAssetABI, contracts.usdc.runner)
          balance = await token.balanceOf(wallet.address) as bigint
        } catch { balance = 0n }
        next[sym] = { price, balance }
      })
    )
    setRows(next)
    setLoading(false)
    // symbols/synth derive from wallet.chainId, which is already a dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts, vaultReady, wallet.address, wallet.chainId])

  useEffect(() => { void refresh() }, [refresh])

  const closeDlg = () => { setDlg(null); setAmount('') }

  const doBuy = async (sym: AssetSymbol) => {
    if (!contracts || !addr) return
    let usdcAmt: bigint
    try { usdcAmt = parseEther(amount) } catch { notify('金額格式不正確', false); return }
    if (usdcAmt <= 0n) { notify('請輸入大於 0 的金額', false); return }

    setBusy(true)
    try {
      const approveTx = asTx(await contracts.usdc.approve(addr.AssetVault, usdcAmt))
      await approveTx.wait()
      const tx = asTx(await contracts.assetVault.mint(ASSET_IDS[sym], usdcAmt))
      await tx.wait()
      notify(`已買入 ${sym} ✓ — 代幣已進入你的錢包`, true, tx.hash)
      closeDlg()
      await refresh()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setBusy(false) }
  }

  const doSell = async (sym: AssetSymbol) => {
    if (!contracts) return
    let tokenAmt: bigint
    try { tokenAmt = parseEther(amount) } catch { notify('數量格式不正確', false); return }
    if (tokenAmt <= 0n) { notify('請輸入大於 0 的數量', false); return }

    setBusy(true)
    try {
      const tx = asTx(await contracts.assetVault.redeem(ASSET_IDS[sym], tokenAmt))
      await tx.wait()
      notify(`已賣出 ${sym} ✓ — USDC 已退回錢包`, true, tx.hash)
      closeDlg()
      await refresh()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setBusy(false) }
  }

  // EIP-747: make the token visible in MetaMask. This is the point of the page —
  // the professor should be able to see sAAPL sitting in the wallet.
  const addToWallet = async (sym: AssetSymbol) => {
    const eth = window.ethereum
    if (!eth) { notify('找不到錢包擴充功能', false); return }
    try {
      await eth.request({
        method: 'wallet_watchAsset',
        params: { type: 'ERC20', options: { address: synth[sym], symbol: sym, decimals: 18 } },
      })
    } catch (e) {
      notify(prettyError(e), false)
    }
  }

  // ── not deployed on this chain ──────────────────────────────────────────────
  if (!vaultReady) {
    return (
      <Container maxWidth="md" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>代幣化資產</Typography>
          <Typography variant="body2" color="text.secondary">ERC-20 Tokenized Assets</Typography>
        </Box>
        <Alert severity="info">
          代幣化資產尚未在此網路啟用（AssetVault 未部署）。
          部署 <b>DeploySyntheticAssets.s.sol</b> 後，把 AssetVault 與 11 顆代幣位址填入
          <Box component="code" sx={{ mx: 0.5, fontFamily: MONO }}>addresses.ts</Box>
          即可開放買入。
        </Alert>
      </Container>
    )
  }

  const dlgPrice = dlg ? (rows[dlg.sym]?.price ?? 0n) : 0n
  const dlgPriceNum = Number(dlgPrice) / 1e8
  const parsedAmt = parseFloat(amount || '0')
  const estimate =
    dlg?.mode === 'buy'
      ? dlgPriceNum > 0 ? parsedAmt / dlgPriceNum : 0
      : parsedAmt * dlgPriceNum

  return (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>代幣化資產</Typography>
        <Typography variant="body2" color="text.secondary">ERC-20 Tokenized Assets</Typography>
      </Box>

      <Alert severity="info">
        本頁展示<b>代幣化資產（ERC-20）</b>。與交易頁的合成持倉不同，這裡買入的資產會以
        ERC-20 token 形式<b>出現在你的錢包中</b>，可加入 MetaMask 檢視、可轉帳給他人。
        買賣以 <b>USDC</b> 結算，價格取自鏈上 oracle（無滑價）。
      </Alert>

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

                <Stack direction="row" spacing={1} sx={{ mt: 'auto', pt: 0.5 }}>
                  <Button
                    size="small" variant="contained" fullWidth
                    onClick={() => setDlg({ sym, mode: 'buy' })}
                    sx={{ textTransform: 'none', fontWeight: 'bold' }}
                  >
                    買入
                  </Button>
                  <Button
                    size="small" variant="outlined" fullWidth
                    disabled={bal === 0n}
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
        提示：賣出由 AssetVault 的 USDC 儲備支付。若儲備不足會顯示「vault dry」，
        需由管理者呼叫 <Box component="code" sx={{ fontFamily: MONO }}>fundVault()</Box> 補充。
      </Typography>

      {/* buy / sell dialog */}
      <Dialog open={!!dlg} onClose={closeDlg} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 'bold' }}>
          {dlg?.mode === 'buy' ? '買入' : '賣出'} {dlg?.sym}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Chip
              size="small"
              variant="outlined"
              label={`Oracle: ${dlgPriceNum > 0 ? fUsd(dlgPriceNum) : '—'}`}
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
            <Typography variant="caption" color="text.secondary">
              {dlg?.mode === 'buy'
                ? `你將獲得 ≈ ${estimate.toFixed(4)} ${dlg?.sym ?? ''}`
                : `你將收到 ≈ ${fUsd(estimate)} USDC`}
            </Typography>
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

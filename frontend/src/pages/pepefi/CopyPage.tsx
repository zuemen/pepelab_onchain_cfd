import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams, Link as RouterLink } from 'react-router'
import { parseEther } from 'ethers'
import { paths } from 'src/routes/paths'
import { useContracts } from 'src/hooks/useContracts'
import { kycActionMode, useVcKycRegistry } from 'src/hooks/useVcKycRegistry'
import { useOnchainRwaFlags, kycGateApplies } from 'src/hooks/useOnchainRwa'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { ASSET_LABEL, ASSET_META } from 'src/lib/pepefi/assetMeta'
import { useKYC } from 'src/hooks/useKYC'
import { useESG } from 'src/hooks/useESG'
import { useLivePrices } from 'src/hooks/useLivePrices'
import { useExecutionFee, formatEth } from 'src/hooks/useExecutionFee'
import { t, interpolate } from 'src/locales'
import { STABLE_LABEL } from 'src/lib/pepefi/tokenLabel'
import { firstBlocking, stalenessNotice } from 'src/lib/pepefi/priceFreshness'
import ESGBadge from 'src/components/pepefi/ESGBadge'
import KYCModal from 'src/components/pepefi/KYCModal'
import { traderAvatarSrc } from 'src/utils/pepefi-assets'
import TraderRankBadge from 'src/components/pepefi/TraderRankBadge'
import { useToast } from 'src/components/pepefi/ToastProvider'
import { belowMinimum, minimumCopyAmount } from 'src/lib/pepefi/copyGuards'
import { fetchHeroIndex, heroByAddress } from 'src/lib/pepefi/heroData'
import { heroDisclosure } from 'src/lib/pepefi/heroDisclosure'
import { useMode } from 'src/contexts/mode-context'
import StrategySides from 'src/components/pepefi/feed/StrategySides'
import { useCarbonRouting } from 'src/hooks/useCarbonRouting'
import { copyRetirementEstimate } from 'src/lib/pepefi/carbonRetirement'
import { useAutoSyncSupport } from 'src/hooks/useAutoSyncSupport'
import AutoSyncFields from 'src/components/pepefi/copy/AutoSyncFields'
import { AutoSyncDisclosure } from 'src/components/pepefi/copy/AutoSyncDialogs'
import {
  DEFAULT_TIP_WEI,
  DEFAULT_COOLDOWN,
  autoSyncEntry,
  parseEthInput,
  settingsProblem,
  executorProblem,
  defaultPrefundWei,
  defaultMaxLeverage,
  followWithAutoSyncValue,
  type AutoSyncSettings,
} from 'src/lib/pepefi/autoSync'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Chip from '@mui/material/Chip';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Avatar from '@mui/material/Avatar';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';

interface TraderStakeData {
  stake:        bigint
  totalSlashed: bigint
  reputation:   bigint
}

interface CopyPreview {
  copyFee:            bigint
  totalTradingFee:    bigint
  marginForPositions: bigint
  portions:           bigint[]
}

interface AllocWithPrice {
  asset:      string
  weight:     bigint
  isLong:     boolean
  leverage:   bigint
  entryPrice: bigint   // 18-dec, current oracle price
}

const tryParse = (s: string): bigint | null => {
  if (!s) return null
  try { return parseEther(s) } catch { return null }
}

const f18  = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)
const fUsd = (v: bigint) =>
  '$' + (Number(v) / 1e18).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

export default function CopyPage() {
  const wallet = usePepefiWallet()
  const { mode } = useMode()
  const { traderAddress } = useParams<{ traderAddress: string }>()
  // 從投資組合「更新到最新版」過來時，金額已經帶在 ?amount= 上。
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  // VC 准入登錄沒有 submitKYC：「送出 KYC」改為前往憑證頁。
  const vcKyc = useVcKycRegistry(wallet.chainId, wallet.provider)
  const kycAction = kycActionMode(vcKyc, contracts ? String(contracts.kycRegistry.target) : null)

  const [traderName,       setTraderName]       = useState('')
  const [traderRegistered, setTraderRegistered] = useState(false)
  const [hasStrategy,      setHasStrategy]      = useState(false)
  const [loadError,        setLoadError]        = useState<string | null>(null)
  const [stratAllocs,      setStratAllocs]      = useState<AllocWithPrice[]>([])
  const [stakeData,        setStakeData]        = useState<TraderStakeData | null>(null)
  const [totalMargin,      setTotalMargin]      = useState(searchParams.get('amount') ?? '1000')
  const [approved,         setApproved]         = useState(false)
  const [busy,             setBusy]             = useState<Record<string, boolean>>({})
  const [preview,          setPreview]          = useState<CopyPreview | null>(null)
  const [showKYCModal,     setShowKYCModal]     = useState(false)
  // PerpetualExchange.MIN_MARGIN：每一檔部位的最低保證金。讀不到就用合約目前的常數。
  const [minMargin,        setMinMargin]        = useState<bigint>(10n * 10n ** 18n)
  // 被跟單的對象是模擬交易者（issue #309）。讀的是靜態檔，不依賴任何鏈上讀取；
  // 這條鏈沒有績效資料時維持 false。
  const [isSimulated,      setIsSimulated]      = useState(false)
  const [heroCompressed,   setHeroCompressed]   = useState(false)
  // 交易者最新版的 versionId：送出時釘住（followTraderAtVersion*），交易者在中間改版就整筆失敗。
  const [stratVersion,     setStratVersion]     = useState<bigint | null>(null)
  // ADR-024 自動同步：預設不勾——這是跟隨者在鏈上的明確同意，不替他預設。
  const [autoSyncOn,       setAutoSyncOn]       = useState(false)
  const [syncSettings,     setSyncSettings]     = useState<AutoSyncSettings>({
    maxLeverage: 1, minSyncInterval: DEFAULT_COOLDOWN, tipWei: DEFAULT_TIP_WEI,
  })
  const [prefund,          setPrefund]          = useState('')
  // 選填：只讓這個地址（跟隨者自己的 agent 熱錢包）代為同步；空字串＝任何人。跟單後另送 setSyncExecutor。
  const [executorInput,    setExecutorInput]    = useState('')

  const { isVerified: isKYCVerified, isPending: kycPending, refetch: refetchKYC } = useKYC(
    contracts?.kycRegistry ?? null,
    wallet.address ?? null,
  )
  const { data: esg } = useESG(contracts?.esgRegistry ?? null)
  const livePrices = useLivePrices()
  const execFee = useExecutionFee(contracts?.exchange ?? null)
  const autoSync = useAutoSyncSupport(contracts?.copyTracker ?? null, wallet.provider)
  // #333：跟單費 → 平台份額 → 退役預算的比例與模擬價格，全部讀自鏈上；這條鏈沒接碳權退役時為 null。
  const { routing: carbon } = useCarbonRouting(wallet.provider, wallet.chainId)

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const { notify } = useToast()

  useEffect(() => {
    if (!contracts || !traderAddress) return
    setLoadError(null)
    const go = async () => {
      let traderRaw: [boolean, string, bigint] | null = null;
      try {
        traderRaw = (await contracts.registry.traders(traderAddress)) as unknown as [boolean, string, bigint]
      } catch { traderRaw = null; }
      if (traderRaw) {
        setTraderName(traderRaw[1])
        setTraderRegistered(traderRaw[0])
      }

      let stratRaw: [unknown[], bigint] | null = null;
      try {
        stratRaw = (await contracts.registry.getLatestStrategy(traderAddress)) as unknown as [unknown[], bigint]
      } catch (e) {
        console.warn('[CopyPage] no strategy for', traderAddress, e)
        stratRaw = null;
      }

      if (stratRaw === null) {
        setStratAllocs([])
        setHasStrategy(false)
        setStratVersion(null)
      } else {
        setStratVersion(BigInt(stratRaw[1] as bigint))
        try {
          const allocs = stratRaw[0] as unknown as Array<{
            asset: string; weight: bigint; isLong: boolean; leverage: bigint
          }>
          const withPrices = await Promise.all(
            allocs.map(async a => {
              const pr = (await contracts.oracle.getPrice(a.asset)) as unknown as [bigint, bigint]
              return {
                asset:      a.asset,
                weight:     a.weight,
                isLong:     a.isLong,
                leverage:   a.leverage,
                entryPrice: pr[0] * 10n ** 10n,
              } satisfies AllocWithPrice
            }),
          )
          setStratAllocs(withPrices)
          setHasStrategy(true)
        } catch {
          setStratAllocs([])
          setHasStrategy(false)
        }
      }

      try {
        const [si, score] = await Promise.all([
          contracts.traderStake.getStake(traderAddress),
          contracts.traderStake.reputationScore(traderAddress),
        ])
        const s = si as unknown as { amount: bigint; totalSlashed: bigint }
        setStakeData({ stake: s.amount, totalSlashed: s.totalSlashed, reputation: score as bigint })
      } catch { /* not deployed */ }
    }
    void go()
  }, [contracts, traderAddress])

  useEffect(() => { setApproved(false) }, [totalMargin])

  // 槓桿上限的預設：這一版策略最高的槓桿（交易者之後調高不會帶著跟隨者一起調高）。
  useEffect(() => {
    setSyncSettings(prev => ({ ...prev, maxLeverage: defaultMaxLeverage(stratAllocs.map(a => a.leverage)) }))
  }, [stratAllocs])

  const toggleAutoSync = (on: boolean) => {
    setAutoSyncOn(on)
    // 第一次勾選時填入預設預存：夠讓別人代為同步五次
    if (on && prefund === '') {
      const wei = defaultPrefundWei(execFee.wei, Math.max(1, stratAllocs.length), syncSettings.tipWei)
      setPrefund(formatEth(wei))
    }
  }

  useEffect(() => {
    if (!contracts) return
    void (contracts.exchange.MIN_MARGIN() as Promise<bigint>).then(setMinMargin).catch(() => undefined)
  }, [contracts])

  useEffect(() => {
    let cancelled = false
    setIsSimulated(false)
    if (!traderAddress) return undefined
    void fetchHeroIndex(wallet.chainId).then((index) => {
      if (cancelled) return
      setIsSimulated(!!index && heroByAddress(index).has(traderAddress.toLowerCase()))
      setHeroCompressed(index?.timeCompressed ?? false)
    })
    return () => { cancelled = true }
  }, [traderAddress, wallet.chainId])

  const onchainRwa     = useOnchainRwaFlags(contracts?.exchange, stratAllocs.map((a) => a.asset))
  const hasKYCRequired = stratAllocs.some(a => kycGateApplies(ASSET_META[a.asset]?.regulated, onchainRwa[a.asset]))
  const kycBlocked     = hasKYCRequired && !isKYCVerified

  // ── F-2 · stale 擋單 ───────────────────────────────────────────────────────
  // 跟單會在同一筆交易裡對策略的每一個標的開倉。只要其中一檔的鏈上價過期，
  // 整筆就 revert StalePrice——而且 N 檔的 execution fee 已經一起送出去了。
  // 所以判斷是「有沒有任何一檔過期」，不是「選中的那檔」。
  const staleAlloc = firstBlocking(
    stratAllocs.map(a => ({
      label: ASSET_LABEL[a.asset] ?? a.asset.slice(0, 8),
      freshness: livePrices[a.asset]?.freshness,
    })),
  )
  const staleNotice = staleAlloc ? stalenessNotice(staleAlloc.freshness, staleAlloc.label) : null
  const staleBlocked = staleNotice !== null

  const COPY_FEE_BPS = 30n
  const totalBig  = tryParse(totalMargin) ?? 0n
  const feeBig    = totalBig * COPY_FEE_BPS / 10_000n
  const netBig    = totalBig - feeBig
  const retirement = carbon && carbon.copyFeeBps !== null && totalBig > 0n
    ? copyRetirementEstimate({
        totalMargin:      totalBig,
        copyFeeBps:       carbon.copyFeeBps,
        platformShareBps: carbon.platformShareBps,
        carbonShareBps:   carbon.carbonShareBps,
        pricePerTonne:    carbon.pricePerTonne,
      })
    : null
  const tokenAmt = (v: bigint) => `${(Number(v) / 10 ** (carbon?.decimals ?? 18)).toFixed(4)} ${STABLE_LABEL}`
  // 碳權固定 18 位（1e18 = 1 公噸），f18 正好適用
  const tonnesTxt = (v: bigint) => f18(v, 4)
  // 自動同步的入口只在 Expert Mode（與投資組合一致：設定含槓桿上限，同步會依新版開新部位）。
  // Simple Mode 只說明怎麼開；在 Expert 勾了再切回 Simple，也不會帶著看不到的勾選送出。
  const syncEntry = autoSyncEntry(autoSync.supported, mode)
  const autoSyncActive = syncEntry === 'available' && autoSyncOn
  // 勾了自動同步時，跟隨者自設的槓桿上限也套用在這次開倉（合約 followTraderAtVersionWithAutoSync）；
  // 沒有這個合併入口時是先 followTraderAtVersion 再開自動同步，這次開倉不受上限影響
  const levCap = autoSyncActive && autoSync.combined ? BigInt(syncSettings.maxLeverage) : null
  const previewRows = stratAllocs.map(a => {
    const leverage = levCap !== null && a.leverage > levCap ? levCap : a.leverage
    return {
      ...a,
      leverage,
      margin:   netBig * a.weight / 10_000n,
      notional: netBig * a.weight / 10_000n * leverage,
    }
  })

  // 勾了自動同步：預覽要套用同一個槓桿上限（緩衝、實際投入保證金、各檔份額才會與上鏈結果一致）
  const previewCap = levCap !== null && autoSync.previewWithCap ? levCap : null

  useEffect(() => {
    if (!contracts || !traderAddress || !totalBig || totalBig === 0n) {
      setPreview(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const r = previewCap !== null
          ? await contracts.copyTracker.previewCopyAllocationWithCap(traderAddress, totalBig, previewCap)
          : await contracts.copyTracker.previewCopyAllocation(traderAddress, totalBig)
        if (!cancelled) {
          setPreview({
            copyFee:            r[0] as bigint,
            totalTradingFee:    r[1] as bigint,
            marginForPositions: r[2] as bigint,
            portions:           Array.from(r[3] as bigint[]),
          })
        }
      } catch {
        if (!cancelled) setPreview(null)
      }
    })()
    return () => { cancelled = true }
  }, [contracts, traderAddress, totalBig, previewCap])

  // 照比例拆完有一檔低於最低保證金，followTrader 會整筆 revert——送出前就擋下，並講出最低要多少。
  const tooSmall = preview !== null && belowMinimum(preview.portions, minMargin)
  const minAmount = preview && tooSmall ? minimumCopyAmount(totalBig, preview.portions, minMargin) : null

  const doApprove = async () => {
    if (!contracts) return
    const amt = tryParse(totalMargin)
    if (!amt) { notify(t.copy.tx.enterValidAmount, false); return }
    setLoad('approve', true)
    try {
      const tx = asTx(await contracts.usdc.approve(String(contracts.copyTracker.target), amt))
      await tx.wait()
      notify(interpolate(t.copy.tx.approved, { token: STABLE_LABEL }), true, tx.hash)
      setApproved(true)
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('approve', false) }
  }

  const prefundWei = autoSyncActive ? parseEthInput(prefund === '' ? '0' : prefund) : 0n
  const syncProblem = autoSyncActive
    ? settingsProblem(syncSettings, autoSync.maxTipWei) ?? (prefundWei === null ? 'prefund' : null)
    : null
  const executorActive = autoSyncActive && autoSync.executorLock
  const exProblem = executorActive ? executorProblem(executorInput, wallet.address ?? null) : null

  const doFollow = async () => {
    if (!contracts || !traderAddress) return
    const amt = tryParse(totalMargin)
    if (!amt) { notify(t.copy.tx.enterValidAmount, false); return }
    // F-2：任何一檔過期就別送。送出去只會 revert，但 N 筆 execution fee 的 gas
    // 已經花掉了——這是最貴的一種白撞牆。
    if (staleNotice) { notify(staleNotice, false); return }
    if (syncProblem) { notify(t.copy.autoSync.invalid[syncProblem], false); return }
    if (exProblem) { notify(t.copy.autoSync.executorInvalid[exProblem], false); return }
    setLoad('follow', true)
    try {
      const execFeePerPosition = await contracts.exchange.executionFee() as bigint
      const totalExecFee = execFeePerPosition * BigInt(stratAllocs.length)
      if (autoSyncActive && stratVersion !== null) {
        await followWithAutoSync(amt, execFeePerPosition, stratVersion, prefundWei ?? 0n)
      } else {
        // M10：沒勾自動同步也釘住畫面上這一版。交易者在送出前搶先發布另一版（例如換資產、5 倍槓桿），
        // 合約整筆 revert StrategyVersionMismatch，不會直接跟到沒看過的版本。只有舊版 tracker 沒有這個
        // 入口（或還讀不到版本）時才退回不釘版本的 followTrader。
        const tx = asTx(await (stratVersion !== null && autoSync.pinnedFollow
          ? contracts.copyTracker.followTraderAtVersion(traderAddress, amt, stratVersion, { value: totalExecFee })
          : contracts.copyTracker.followTrader(traderAddress, amt, { value: totalExecFee })))
        await tx.wait()
        notify(t.copy.tx.following, true, tx.hash)
      }
      navigate('/portfolio')
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('follow', false) }
  }

  // ADR-024：跟單＋開啟自動同步＋存入油箱。合約有一筆完成的函式就一筆送；沒有就分三步：
  // 先跟單（跟單成功就是成功），之後兩步失敗只提示，使用者可以到投資組合再開。
  // 兩條路都用 AtVersion 釘住版本：交易者在送出前改版，跟單整筆失敗，不會跟到沒看過的那一版。
  // 執行費同樣釘住：畫面上顯示的每檔執行費（execFee.wei）就是跟隨者簽名同意的上限
  // （maxExecFeePerLeg）。交易所 owner 在送出前調高費率，合約整筆 revert ExecutionFeeAboveCap，
  // 不會把要存進油箱的 ETH 當成開倉執行費收走，也不會把調高後的費率記成之後代為同步的同意值。
  const followWithAutoSync = async (amt: bigint, fee: bigint, version: bigint, deposit: bigint) => {
    if (!contracts || !traderAddress || !wallet.address) return
    const { maxLeverage, minSyncInterval, tipWei } = syncSettings
    const maxExecFeePerLeg = execFee.wei
    if (autoSync.combined) {
      const tx = asTx(await contracts.copyTracker.followTraderAtVersionWithAutoSync(
        traderAddress, amt, version, maxLeverage, minSyncInterval, tipWei, maxExecFeePerLeg,
        { value: followWithAutoSyncValue(fee, stratAllocs.length, deposit) },
      ))
      await tx.wait()
      notify(t.copy.tx.followingAuto, true, tx.hash)
      await setExecutorAfterFollow()
      return
    }
    const followTx = asTx(await contracts.copyTracker.followTraderAtVersion(traderAddress, amt, version, {
      value: fee * BigInt(stratAllocs.length),
    }))
    await followTx.wait()
    notify(t.copy.tx.autoSyncStep, true, followTx.hash)
    try {
      const recs = (await contracts.copyTracker.getCopyRecords(wallet.address)) as unknown as { trader: string; active: boolean }[]
      const idx = recs.length - 1
      if (idx < 0 || recs[idx].trader.toLowerCase() !== traderAddress.toLowerCase() || !recs[idx].active) {
        throw new Error('copy record not found')
      }
      await asTx(await contracts.copyTracker.setAutoSync(
        BigInt(idx), true, maxLeverage, minSyncInterval, tipWei, maxExecFeePerLeg,
      )).wait()
      if (deposit > 0n) {
        await asTx(await contracts.copyTracker.depositSyncGas({ value: deposit })).wait()
      }
      notify(t.copy.tx.followingAuto, true)
    } catch (e) {
      console.warn('[CopyPage] auto-sync setup after follow failed', e)
      notify(t.copy.tx.autoSyncFailed, false)
      return
    }
    await setExecutorAfterFollow()
  }

  /** 剛完成的這筆跟單在 getCopyRecords 裡的索引（最後一筆、交易者相符、仍在跟隨）。 */
  const newestRecordIdx = async (): Promise<number> => {
    if (!contracts || !traderAddress || !wallet.address) throw new Error('not connected')
    const recs = (await contracts.copyTracker.getCopyRecords(wallet.address)) as unknown as { trader: string; active: boolean }[]
    const idx = recs.length - 1
    if (idx < 0 || recs[idx].trader.toLowerCase() !== traderAddress.toLowerCase() || !recs[idx].active) {
      throw new Error('copy record not found')
    }
    return idx
  }

  // 選填的指定執行者：跟單（＋自動同步）之後另送一筆 setSyncExecutor。兩筆之間沒有人能搶先代為同步——
  // 冷卻從跟單當下起算、至少 1 小時（合約 MIN_SYNC_INTERVAL）。失敗只提示：跟單與自動同步都已經成立，
  // 可以到投資組合的「設定」再指定。
  const setExecutorAfterFollow = async () => {
    if (!contracts || !executorActive || executorInput.trim() === '' || exProblem) return
    try {
      notify(t.copy.tx.executorStep, true)
      const idx = await newestRecordIdx()
      await asTx(await contracts.copyTracker.setSyncExecutor(BigInt(idx), executorInput.trim())).wait()
    } catch (e) {
      console.warn('[CopyPage] setSyncExecutor after follow failed', e)
      notify(t.copy.tx.executorFailed, false)
    }
  }

  if (!traderAddress) {
    return <Box sx={{ p: 4 }}><Typography color="text.secondary">{t.copy.invalidAddress}</Typography></Box>
  }

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">{t.copy.connectWallet}</Typography>
      </Box>
    )
  }

  return (
    <Container maxWidth="md" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* Load error banner */}
      {loadError && (
        <Alert severity="error">
          <strong>{t.copy.loadFailed}</strong> {loadError}
        </Alert>
      )}

      {/* Breadcrumb */}
      <Breadcrumbs separator="/" sx={{ mb: 1 }}>
        <Link component={RouterLink} to="/marketplace" color="inherit" underline="hover" sx={{ fontSize: '0.875rem' }}>
          {t.copy.breadcrumbMarketplace}
        </Link>
        <Typography variant="body2" color="text.primary">
          {traderName || shortAddr(traderAddress)}
        </Typography>
      </Breadcrumbs>

      {/* Header */}
      <Card sx={{ p: 3 }}>
        <Stack direction="row" spacing={3} alignItems="center">
          <Avatar
            src={traderAvatarSrc(stakeData ? stakeData.reputation : null, traderAddress)}
            sx={{
              width: 80,
              height: 80,
              border: '3px solid',
              borderColor: stakeData && stakeData.reputation >= 80n ? 'warning.main' : 'rgba(255,255,255,0.1)',
              boxShadow: '0 0 16px rgba(0,0,0,0.5)',
              bgcolor: 'rgba(255, 255, 255, 0.05)',
              '& .MuiAvatar-img': {
                objectFit: 'contain',
                padding: '4px',
              }
            }}
          />
          <Box sx={{ flexGrow: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 2 }}>
              <Box>
                <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                  <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
                    {traderName || t.copy.header.unknownTrader}
                  </Typography>
                  <TraderRankBadge reputation={stakeData ? stakeData.reputation : null} />
                </Stack>
                <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary', display: 'block', mt: 0.5 }}>
                  {traderAddress}
                </Typography>
              </Box>
              {stakeData && (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5 }}>
                  <Chip
                    label={interpolate(t.copy.header.repChip, { rep: String(stakeData.reputation) })}
                    size="small"
                    sx={{
                      fontWeight: 'bold',
                      ...(stakeData.reputation >= 80n ? { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' }
                        : stakeData.reputation >= 60n ? { bgcolor: 'rgba(255, 171, 0, 0.16)', color: '#ffab00', border: '1px solid', borderColor: 'rgba(255, 171, 0, 0.24)' }
                        : { bgcolor: 'rgba(255, 86, 48, 0.16)', color: '#ff5630', border: '1px solid', borderColor: 'rgba(255, 86, 48, 0.24)' }
                      )
                    }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                    {interpolate(t.copy.header.staked, {
                      amount: (Number(stakeData.stake) / 1e18).toFixed(0),
                      token: STABLE_LABEL,
                    })}
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>
        </Stack>
        {!loadError && traderName !== '' && !traderRegistered && (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 2, fontWeight: 'bold' }}>
            {t.copy.header.notRegistered}
          </Typography>
        )}
      </Card>

      {isSimulated && (
        <Alert severity="info" variant="outlined">
          {heroDisclosure(heroCompressed)}
        </Alert>
      )}

      {/* Strategy allocations */}
      <Card sx={{ p: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>
          {t.copy.strategy.title}
        </Typography>

        {stratAllocs.length === 0 ? (
          <Typography color="text.secondary">{t.copy.strategy.empty}</Typography>
        ) : (
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            {stratAllocs.map((a, i) => (
              <Chip
                key={i}
                label={interpolate(t.copy.strategy.chip, {
                  side: a.isLong ? '↑' : '↓',
                  asset: ASSET_LABEL[a.asset] ?? '?',
                  weight: (Number(a.weight) / 100).toFixed(0),
                  leverage: String(a.leverage),
                })}
                size="small"
                sx={{
                  fontWeight: 'bold',
                  ...(a.isLong
                    ? { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' }
                    : { bgcolor: 'rgba(255, 86, 48, 0.16)', color: '#ff5630', border: '1px solid', borderColor: 'rgba(255, 86, 48, 0.24)' }
                  )
                }}
              />
            ))}
          </Stack>
        )}
      </Card>

      {/* 策略各資產目前的市場多空比例（issue #335），只在 Expert */}
      {mode === 'expert' && stratAllocs.length > 0 && (
        <StrategySides legs={stratAllocs} exchange={contracts?.exchange ?? null} />
      )}

      {/* Strategy ESG composite */}
      {stratAllocs.length > 0 && (() => {
        const totalW = stratAllocs.reduce((s, a) => s + Number(a.weight), 0)
        if (totalW === 0) return null
        let wavg = 0
        let allRated = true
        for (const a of stratAllocs) {
          const info = esg[a.asset]
          if (!info) { allRated = false; break }
          wavg += info.composite * Number(a.weight)
        }
        if (!allRated) return null
        const composite = Math.round(wavg / totalW)
        const rating    = composite >= 80 ? 'AAA' : composite >= 70 ? 'AA' : composite >= 60 ? 'A' : composite >= 50 ? 'BBB' : 'CCC'
        const tierName  = composite >= 80 ? t.copy.esg.champion : composite >= 60 ? t.copy.esg.aware : t.copy.esg.considerGreener
        const tierColorHex = composite >= 80 ? '#22c55e' : composite >= 60 ? '#c0ca33' : '#ffab00'
        return (
          <Card sx={{ p: 2.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Typography variant="h5">🌱</Typography>
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 'bold' }}>
                  {t.copy.esg.title}
                </Typography>
                <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: tierColorHex }}>
                  {tierName}
                </Typography>
              </Box>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, ml: 'auto' }}>
              <ESGBadge composite={composite} rating={rating} size="md" />
              <Typography variant="h5" sx={{ fontWeight: 'extrabold', fontFamily: MONO, color: tierColorHex }}>
                {composite}
              </Typography>
              <Button
                component={RouterLink}
                to="/esg"
                variant="text"
                size="small"
                sx={{ textTransform: 'none' }}
              >
                {t.copy.esg.details}
              </Button>
            </Box>
          </Card>
        )
      })()}

      {/* Total margin input */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          {t.copy.amount.title}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <TextField
            type="number"
            size="small"
            placeholder={t.copy.amount.placeholder}
            value={totalMargin}
            disabled={!hasStrategy}
            onChange={e => setTotalMargin(e.target.value)}
            slotProps={{ htmlInput: { min: "0", style: { fontFamily: MONO } } }}
            sx={{ width: 200 }}
          />
          <Typography variant="body2" color="text.secondary">
            {interpolate(t.copy.amount.unitSuffix, { token: STABLE_LABEL })}
          </Typography>
          {!hasStrategy && (
            <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
              {t.copy.amount.disabledHint}
            </Typography>
          )}
        </Box>

        {preview && totalBig > 0n && (
          <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
            <Stack spacing={1} sx={{ typography: 'caption' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
                <Box>{t.copy.preview.totalDeposit}</Box>
                <Box sx={{ fontFamily: MONO, color: 'text.primary', fontWeight: 'semibold' }}>{f18(totalBig)} {STABLE_LABEL}</Box>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
                <Box>{t.copy.preview.copyFee}</Box>
                <Box sx={{ fontFamily: MONO, color: 'error.main', fontWeight: 'semibold' }}>-{f18(preview.copyFee)} {STABLE_LABEL}</Box>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
                <Box>{t.copy.preview.tradingFeeBuffer}</Box>
                <Box sx={{ fontFamily: MONO, color: 'error.main', fontWeight: 'semibold' }}>-{f18(preview.totalTradingFee)} {STABLE_LABEL}</Box>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.primary', fontWeight: 'bold', borderTop: '1px solid', borderColor: 'divider', pt: 1, mt: 0.5 }}>
                <Box>{t.copy.preview.effectiveMargin}</Box>
                <Box sx={{ fontFamily: MONO, color: 'success.main' }}>{f18(preview.marginForPositions)} {STABLE_LABEL}</Box>
              </Box>
            </Stack>
          </Card>
        )}

        {previewRows.length > 0 && totalBig > 0n && (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {[
                    t.copy.preview.column.asset,
                    t.copy.preview.column.side,
                    t.copy.preview.column.leverage,
                    t.copy.preview.column.weight,
                    t.copy.preview.column.margin,
                    t.copy.preview.column.notional,
                    t.copy.preview.column.estEntry,
                  ].map(h => (
                    <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {previewRows.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'text.primary' }}>
                      {ASSET_LABEL[row.asset] ?? '?'}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 'bold', color: row.isLong ? 'success.main' : 'error.main' }}>
                      {row.isLong ? t.copy.preview.long : t.copy.preview.short}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO }}>{String(row.leverage)}×</TableCell>
                    <TableCell sx={{ fontFamily: MONO }}>{(Number(row.weight) / 100).toFixed(0)}%</TableCell>
                    <TableCell sx={{ fontFamily: MONO }} align="right">
                      {preview && preview.portions[i] !== undefined
                        ? f18(preview.portions[i])
                        : f18(row.margin)}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO }} align="right">{f18(row.notional)}</TableCell>
                    <TableCell sx={{ fontFamily: MONO }} align="right">{fUsd(row.entryPrice)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>

      {/* Fee preview */}
      {totalBig > 0n && (
        <Card sx={{ p: 2.5, bgcolor: 'background.neutral', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="overline" color="warning.main" sx={{ fontWeight: 'bold', display: 'block', mb: 1 }}>
            {t.copy.feePreview.title}
          </Typography>
          <Stack spacing={1} sx={{ typography: 'body2' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
              <Box>{t.copy.feePreview.copyFee}</Box>
              <Box sx={{ fontFamily: MONO }}>−{f18(feeBig, 4)} {STABLE_LABEL}</Box>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
              <Box>{t.copy.feePreview.netMargin}</Box>
              <Box sx={{ fontFamily: MONO, color: 'text.primary', fontWeight: 'semibold' }}>{f18(netBig)} {STABLE_LABEL}</Box>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary', borderTop: '1px solid', borderColor: 'divider', pt: 1, mt: 1 }}>
              <Box>{t.copy.feePreview.executionFee}</Box>
              <Box sx={{ fontFamily: MONO, color: 'primary.main', fontWeight: 'semibold' }}>{formatEth(execFee.wei * BigInt(stratAllocs.length))} ETH</Box>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              {t.copy.feePreview.split}
            </Typography>
          </Stack>
        </Card>
      )}

      {/* #333：這次跟單會促成平台退役多少模擬碳權（估算）。噸數歸屬平台，文案不說「抵銷」。 */}
      {retirement && (
        <Card sx={{ p: 2.5, bgcolor: 'background.neutral', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="overline" color="success.main" sx={{ fontWeight: 'bold', display: 'block', mb: 1 }}>
            {t.copy.retirementEstimate.title}
          </Typography>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold', fontFamily: MONO }}>
            {interpolate(t.copy.retirementEstimate.value, { tonnes: tonnesTxt(retirement.tonnes) })}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {interpolate(t.copy.retirementEstimate.body, {
              fee:      tokenAmt(retirement.copyFee),
              platform: tokenAmt(retirement.platformShare),
              carbon:   tokenAmt(retirement.toRetirement),
              tonnes:   tonnesTxt(retirement.tonnes),
            })}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            {t.copy.retirementEstimate.note}
          </Typography>
        </Card>
      )}

      {/* Trader stake / risk summary */}
      {stakeData && (
        <Card sx={{ p: 3, border: '1px solid', borderColor: stakeData.totalSlashed > 0n ? 'error.main' : 'divider', bgcolor: 'background.neutral' }}>
          <Typography variant="overline" sx={{ fontWeight: 'bold', display: 'block', mb: 1.5 }}>
            {t.copy.skinInGame.title}
          </Typography>
          <Grid container spacing={3}>
            <Grid size={{ xs: 4 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{t.copy.skinInGame.staked}</Typography>
              <Typography variant="h6" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                {(Number(stakeData.stake) / 1e18).toFixed(0)} <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary' }}>{STABLE_LABEL}</Box>
              </Typography>
            </Grid>
            <Grid size={{ xs: 4 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{t.copy.skinInGame.reputation}</Typography>
              <Typography variant="h6" sx={{ fontFamily: MONO, fontWeight: 'bold', color: stakeData.reputation >= 80n ? 'success.main' : stakeData.reputation >= 60n ? 'warning.main' : 'error.main' }}>
                {String(stakeData.reputation)} <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary' }}>{t.copy.skinInGame.reputationUnit}</Box>
              </Typography>
            </Grid>
            <Grid size={{ xs: 4 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{t.copy.skinInGame.totalSlashed}</Typography>
              <Typography variant="h6" sx={{ fontFamily: MONO, fontWeight: 'bold', color: stakeData.totalSlashed > 0n ? 'error.main' : 'text.primary' }}>
                {(Number(stakeData.totalSlashed) / 1e18).toFixed(0)} <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary' }}>{STABLE_LABEL}</Box>
              </Typography>
            </Grid>
          </Grid>
          {stakeData.totalSlashed > 0n && (
            <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 2, fontWeight: 'semibold' }}>
              {interpolate(t.copy.skinInGame.slashedWarning, {
                amount: (Number(stakeData.totalSlashed) / 1e18).toFixed(0),
                token: STABLE_LABEL,
              })}
            </Typography>
          )}
          {stakeData.stake === 0n && (
            <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 2, fontWeight: 'semibold' }}>
              {t.copy.skinInGame.noStakeWarning}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            {t.copy.skinInGame.slashRule}
          </Typography>
        </Card>
      )}

      {/* ADR-024：自動同步（選用）。合約不支援、或在 Simple Mode 時只說明一句，不給勾選框。 */}
      {hasStrategy && autoSync.loaded && (
        <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
            {t.copy.autoSync.title}
          </Typography>
          {syncEntry !== 'available' ? (
            <Typography variant="body2" color="text.secondary">{t.copy.autoSync[syncEntry]}</Typography>
          ) : (
            <>
              <FormControlLabel
                control={<Checkbox checked={autoSyncOn} onChange={e => toggleAutoSync(e.target.checked)} />}
                label={<Typography variant="body2" sx={{ fontWeight: 'bold' }}>{t.copy.autoSync.toggle}</Typography>}
              />
              <AutoSyncDisclosure />
              {autoSyncOn && (
                <>
                  <AutoSyncFields
                    value={syncSettings}
                    onChange={setSyncSettings}
                    maxTipWei={autoSync.maxTipWei}
                    executionFee={execFee.wei}
                    legs={stratAllocs.length}
                    showLeverage
                    prefund={{ value: prefund, onChange: setPrefund }}
                    executor={autoSync.executorLock
                      ? { value: executorInput, onChange: setExecutorInput, problem: exProblem, extraTxNote: true }
                      : undefined}
                  />
                  {syncProblem && (
                    <Alert severity="warning">{t.copy.autoSync.invalid[syncProblem]}</Alert>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {autoSync.combined
                      ? interpolate(t.copy.autoSync.oneTx, {
                          total:   formatEth(followWithAutoSyncValue(execFee.wei, stratAllocs.length, prefundWei ?? 0n)),
                          open:    formatEth(execFee.wei * BigInt(stratAllocs.length)),
                          prefund: formatEth(prefundWei ?? 0n),
                        })
                      : t.copy.autoSync.twoTx}
                  </Typography>
                </>
              )}
            </>
          )}
        </Card>
      )}

      {/* Two-stage action */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          {t.copy.confirm.title}
        </Typography>

        <Alert severity="info" variant="outlined">
          {autoSyncActive
            ? interpolate(t.copy.autoSync.snapshotNoteAuto, { lev: syncSettings.maxLeverage })
            : autoSync.supported
              ? (syncEntry === 'available' ? t.copy.confirm.snapshotNoteSyncable : t.copy.confirm.snapshotNoteSyncableSimple)
              : t.copy.confirm.snapshotNote}
        </Alert>

        {tooSmall && (
          <Alert severity="warning">
            {interpolate(t.copy.amount.belowMinimum, {
              amount: minAmount === null ? '—' : (minAmount / 10n ** 18n).toString(),
            })}
          </Alert>
        )}

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Chip
            label={approved ? '✓' : '1'}
            size="small"
            color={approved ? 'success' : 'default'}
            sx={{ fontWeight: 'bold' }}
          />
          <Typography variant="body2" color={approved ? 'success.main' : 'text.secondary'}>
            {interpolate(t.copy.confirm.approveStep, { token: STABLE_LABEL })}
          </Typography>
          <Typography variant="body2" color="text.disabled" sx={{ mx: 1 }}>→</Typography>
          <Chip
            label="2"
            size="small"
            color={approved ? 'default' : 'primary'}
            sx={{ fontWeight: 'bold' }}
          />
          <Typography variant="body2" color="text.secondary">
            {t.copy.confirm.followStep}
          </Typography>
        </Box>

        {staleNotice && (
          <Alert severity="error">
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
              {t.copy.confirm.staleTitle}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block' }}>{staleNotice}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              {interpolate(t.copy.confirm.staleExplain, { count: stratAllocs.length })}
            </Typography>
          </Alert>
        )}

        {/* 審核制：送出申請 ≠ 通過。待審中不要再推「完成 KYC」按鈕。 */}
        {kycBlocked && kycPending && (
          <Alert severity="info">
            {t.copy.markup.kycPendingBefore}<b>{t.copy.markup.kycPendingBold}</b>{t.copy.markup.kycPendingAfter}
          </Alert>
        )}

        {kycBlocked && !kycPending && (
          <Alert severity="warning" action={
            kycAction === 'unknown' ? (
              <Button color="inherit" size="small" onClick={vcKyc.retry} sx={{ fontWeight: 'bold' }}>
                {t.investorVc.unknownRetry}
              </Button>
            ) : kycAction === 'checking' ? (
              <Button color="inherit" size="small" disabled sx={{ fontWeight: 'bold' }}>
                {t.investorVc.checkingShort}
              </Button>
            ) : kycAction === 'credentials' ? (
              <Button color="inherit" size="small" component={RouterLink} to={paths.pepefi.credentials} sx={{ fontWeight: 'bold' }}>
                {t.investorVc.goToCredential}
              </Button>
            ) : (
              <Button
                color="inherit"
                size="small"
                onClick={() => setShowKYCModal(true)}
                sx={{ fontWeight: 'bold' }}
              >
                {t.copy.confirm.kycSubmit}
              </Button>
            )
          }>
            {t.copy.confirm.kycRequired}
          </Alert>
        )}

        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button
            variant={approved ? 'contained' : 'outlined'}
            color={approved ? 'success' : 'inherit'}
            onClick={() => void doApprove()}
            disabled={approved || busy['approve'] || !totalMargin || !hasStrategy || kycBlocked || tooSmall}
            sx={{ flexGrow: 1 }}
          >
            {busy['approve'] ? t.copy.confirm.approving : approved ? t.copy.confirm.approved : t.copy.confirm.approveCta}
          </Button>

          <Button
            variant="contained"
            color="primary"
            onClick={() => void doFollow()}
            disabled={
              !hasStrategy || !approved || busy['follow'] || stratAllocs.length === 0 ||
              (preview !== null && preview.marginForPositions === 0n) ||
              kycBlocked || staleBlocked || tooSmall || syncProblem !== null || exProblem !== null ||
              (autoSyncActive && stratVersion === null) ||
              // 讀完 tracker 有哪些入口才送：否則會在還不知道有沒有 followTraderAtVersion 時退回不釘版本的入口
              !autoSync.loaded
            }
            title={staleNotice ?? undefined}
            sx={{ flexGrow: 1 }}
          >
            {busy['follow']
              ? t.copy.confirm.following
              : staleBlocked
                ? interpolate(t.copy.confirm.stalePrice, { asset: staleAlloc?.label ?? '' })
                : t.copy.confirm.followCta}
          </Button>
        </Box>

        {!hasStrategy && (
          <Typography variant="caption" color="warning.main" sx={{ textAlign: 'center', fontWeight: 'bold', display: 'block' }}>
            {t.copy.confirm.noStrategy}
          </Typography>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', display: 'block' }}>
          {t.copy.confirm.footer}
        </Typography>
      </Card>

      {/* KYC Modal */}
      <KYCModal
        isOpen={showKYCModal && kycAction === 'legacy'}
        onClose={() => setShowKYCModal(false)}
        onSuccess={() => { void refetchKYC() }}
        kycRegistry={contracts?.kycRegistry ?? null}
        isPending={kycPending}
      />
    </Container>
  )
}

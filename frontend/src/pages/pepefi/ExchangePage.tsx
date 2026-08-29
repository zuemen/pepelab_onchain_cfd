import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react';
import { Link as RouterLink } from 'react-router';
import { parseEther } from 'ethers';
import { useContracts } from 'src/hooks/useContracts';
import { useStablecoin } from 'src/hooks/useStablecoin';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { useLivePrices } from 'src/hooks/useLivePrices';
import { useFundingData } from 'src/hooks/useFundingData';
import { LineChart, Line, YAxis, ResponsiveContainer } from 'recharts';
import { ASSET_IDS, getAddresses } from 'src/contracts/addresses';
import { paths } from 'src/routes/paths';
import { t, interpolate } from 'src/locales';
import { prettyError } from 'src/lib/pepefi/errorMessages';
import { safeRead } from 'src/lib/pepefi/safeRead';
import { STABLE_LABEL, ALT_STABLE_LABEL, X402_STABLE_LABEL } from 'src/lib/pepefi/tokenLabel';
import { SHOW_LEVERAGE, SHOW_PERPETUALS, FIXED_LEVERAGE } from 'src/lib/pepefi/featureFlags';
import { estimateLiquidationPrice } from 'src/lib/pepefi/liquidation';
import { blocksTrading, stalenessNotice } from 'src/lib/pepefi/priceFreshness';
import {
  isOracleStale,
  priceImpactBps,
  HIGH_IMPACT_BPS,
  SEVERE_IMPACT_BPS,
  minOutWithSlippage,
  DEFAULT_SLIPPAGE_BPS,
} from 'src/lib/pepefi/ammQuote';
import { useESG } from 'src/hooks/useESG';
import ESGBadge from 'src/components/pepefi/ESGBadge';
import { ASSETS_LIST, ASSET_LABEL, ASSET_META } from 'src/lib/pepefi/assetMeta';
import { useKYC } from 'src/hooks/useKYC';
import { useExecutionFee } from 'src/hooks/useExecutionFee';
import KYCModal from 'src/components/pepefi/KYCModal';
import Skeleton from 'src/components/pepefi/Skeleton';
import PaperTradingBadge from 'src/components/pepefi/PaperTradingBadge';
import AssetIcon from 'src/components/pepefi/AssetIcon';
import { useToast } from 'src/components/pepefi/ToastProvider';

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Backdrop from '@mui/material/Backdrop';
import CircularProgress from '@mui/material/CircularProgress';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import InputLabel from '@mui/material/InputLabel';
import InputAdornment from '@mui/material/InputAdornment';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { Icon } from '@iconify/react';

// ── Config ────────────────────────────────────────────────────────────────────
type AssetId = `0x${string}`;

const ASSETS = ASSETS_LIST;

// ── Types ─────────────────────────────────────────────────────────────────────
interface PositionRow {
  id:            bigint;
  asset:         string;
  isLong:        boolean;
  entryPrice:    bigint;
  margin:        bigint;
  leverage:      bigint;
  unrealizedPnL: bigint;
  currentPrice:  bigint;
  /** 開倉時間（unix 秒）。ESG 獎勵有最短持有期，沒有這個就算不出還差多久。 */
  openedAt:      bigint;
}

interface RawPos {
  asset: string; isLong: boolean; isOpen: boolean;
  entryPrice: bigint; margin: bigint; leverage: bigint;
  openedAt: bigint;
}

interface ESGAssetInfo {
  composite: number;
  rating: string;
  environmental: number;
  social: number;
  governance: number;
}

// ── Formatting ────────────────────────────────────────────────────────────────
const f18    = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d);
const fUsd   = (v: bigint) =>
  '$' + (Number(v) / 1e18).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const fPnL   = (v: bigint) => {
  const n = Number(v) / 1e18;
  return (n >= 0 ? '+' : '') + n.toFixed(4) + ' ' + STABLE_LABEL;
};
const pnlColor = (v: bigint) => Number(v) >= 0 ? 'success.main' : 'error.main';
const tryParse = (s: string): bigint | null => {
  try { return s ? parseEther(s) : null; } catch { return null; }
};

type TxResp = { wait(): Promise<unknown>; hash: string };
const asTx = (tx: unknown): TxResp => tx as TxResp;

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// safeRead now lives in src/lib/pepefi/safeRead.ts so every page shares one
// implementation — this file was the only place that had the guard.

export default function ExchangePage() {
  const wallet = usePepefiWallet();
  const contracts    = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const livePrices   = useLivePrices();
  const fundingData  = useFundingData(contracts?.exchange ?? null);
  const execFee      = useExecutionFee(contracts?.exchange ?? null);
  const { data: esgData, loaded: esgLoaded, unavailable: esgUnavailable } = useESG(contracts?.esgRegistry ?? null);

  const esg = (esgData ?? {}) as unknown as Record<string, ESGAssetInfo>;

  const { stable, setStable } = useStablecoin(contracts);

  const [usdcBal,   setUsdcBal]   = useState(0n);
  const [usdtBal,   setUsdtBal]   = useState(0n);
  const [ethBal,    setEthBal]    = useState('0.0000');
  const [freeMgn,   setFreeMgn]   = useState(0n);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [curPrice,  setCurPrice]  = useState(0n);
  const [pageLoading, setPageLoading] = useState(true);

  const [pepeBal,   setPepeBal]   = useState(0n);

  // AMM swap (PepeAMM — deployed + funded on Base Sepolia)
  //
  // PepeAMM 這一輪被改寫成真正的恆定乘積池：`getPrice()` 現在是**池內現價**
  // （儲備比例），不再是 oracle 報價；oracle 報價搬到新的 `oraclePrice()`。
  // 兩者是不同的數字，而且會分岔——把池價標成 "Oracle rate" 會直接說謊。
  const [swapMode,  setSwapMode]  = useState<'eth-to-usdc' | 'usdc-to-eth'>('eth-to-usdc');
  const [payAmount, setPayAmount] = useState('');
  const [ammPrice,  setAmmPrice]  = useState(0n);   // getPrice() — 池內現價
  const [ammEth,    setAmmEth]    = useState(0n);
  const [ammUsdc,   setAmmUsdc]   = useState(0n);
  const [ammOracle, setAmmOracle] = useState<{ price: bigint; updatedAt: bigint }>({ price: 0n, updatedAt: 0n });
  const [ammMaxAge, setAmmMaxAge] = useState(0n);   // maxOracleAge()，預設 1h
  const [receiveAmount, setReceiveAmount] = useState('');
  /** 這筆兌換相對池內中價的滑點（bps）。恆定乘積 → 金額越大越痛。 */
  const [impactBps, setImpactBps] = useState<number | null>(null);
  const [quotedOut, setQuotedOut] = useState<bigint | null>(null);

  const [depositAmt,       setDepositAmt]        = useState('');
  const [withdrawAmt, setWithdrawAmt] = useState('');
  const [selAsset,    setSelAsset]    = useState<AssetId>(ASSET_IDS.sBTC);
  const [isLong,      setIsLong]      = useState(true);
  // SHOW_LEVERAGE 關閉時鎖 1×（現貨等價）；選擇器不渲染，送單一樣送這個值。
  const [leverage,    setLeverage]    = useState(FIXED_LEVERAGE);
  const [maxLev,      setMaxLev]      = useState(5); // N3: per-asset leverage cap
  const [openMgn,     setOpenMgn]     = useState('');
  const [riskOpen,    setRiskOpen]    = useState(true); // 測試網/ADL/oracle 風險提示（可收合）
  const [history,     setHistory]     = useState<{ time: string; price: number }[]>([]);

  const [busy,         setBusy]        = useState<Record<string, boolean>>({});
  const [showKYCModal, setShowKYCModal] = useState(false);
  const [esgConfirmed, setEsgConfirmed] = useState(false);

  const [esgRewardedMap, setEsgRewardedMap] = useState<Record<string, boolean>>({});
  const [esgPreviewMap,  setEsgPreviewMap]  = useState<Record<string, bigint>>({});
  /** EsgRewardDistributor.minHoldSeconds()（預設 30 天）。0 = 還沒讀到。 */
  const [esgMinHold,     setEsgMinHold]     = useState(0n);

  const {
    isVerified: isKYCVerified,
    isUnknown:  kycStatusUnknown,
    isPending:  kycPending,
    refetch:    refetchKYC,
  } = useKYC(contracts?.kycRegistry ?? null, wallet.address ?? null);

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }));
  const { notify } = useToast();

  // ── F-1 · stale 擋單 ───────────────────────────────────────────────────────
  // 這一頁是最大的下單路徑，卻是唯一沒接 stale 擋單的：顯示價來自 CoinGecko，
  // 永遠是漂亮的綠色即時價，但結算走鏈上 oracle。oracle 過期時使用者按下
  // Open Long → 簽名 → 付 gas → 合約 revert StalePrice。Terminal 早就擋了
  // （見 sections/terminal/TerminalView.tsx），這裡把同一個判斷接上來。
  const openFreshness = livePrices[selAsset]?.freshness;
  const openStaleBlocked = openFreshness ? blocksTrading(openFreshness) : false;
  const openStaleNotice = stalenessNotice(openFreshness, ASSET_LABEL[selAsset] ?? undefined);

  // N3: read the per-asset max leverage (0 → global default) and clamp the UI.
  useEffect(() => {
    let cancelled = false;
    const ex = contracts?.exchange;
    if (!ex) { setMaxLev(5); return; }
    void (async () => {
      const m = Number(await safeRead(ex.maxLeverageForAsset(selAsset) as Promise<bigint>, 0n));
      if (!cancelled) {
        const cap = m > 0 ? m : 5;
        setMaxLev(cap);
        setLeverage(l => (l > cap ? cap : l));
      }
    })();
    return () => { cancelled = true; };
  }, [contracts, selAsset]);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  // Every chain read is isolated (safeRead = per-call try/catch + 8s timeout) and
  // independent batches use allSettled, so no single hung/undeployed-contract
  // call can block the page. setPageLoading(false) is always reached.
  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.address || !wallet.provider) {
      setPageLoading(false);   // 未連錢包也要渲染頁面骨幹，別卡在 Skeleton
      return;
    }
    const addr = wallet.address;
    const provider = wallet.provider;
    try {
      const [bal, mgn, eBal] = await Promise.all([
        safeRead(contracts.usdc.balanceOf(addr) as Promise<bigint>, 0n),
        safeRead(contracts.exchange.freeMargin(addr) as Promise<bigint>, 0n),
        safeRead(provider.getBalance(addr), 0n),
      ]);
      setUsdcBal(bal);
      setFreeMgn(mgn);
      setEthBal(f18(eBal, 4));

      // USDT balance — MockUSDT is a separate token from the USDC margin
      // stablecoin. Skip the read when it isn't deployed on this chain.
      if (String(contracts.usdt.target) !== ZERO_ADDR) {
        setUsdtBal(await safeRead(contracts.usdt.balanceOf(addr) as Promise<bigint>, 0n));
      } else {
        setUsdtBal(0n);
      }

      // PEPE balance — skip the read when PepeToken isn't deployed on this chain
      // (address 0x0) so we never call a non-existent contract.
      if (String(contracts.pepeToken.target) !== ZERO_ADDR) {
        setPepeBal(await safeRead(contracts.pepeToken.balanceOf(addr) as Promise<bigint>, 0n));
      } else {
        setPepeBal(0n);
      }

      // AMM reserves/price — skip when PepeAMM isn't deployed (0x0). Each read is
      // isolated so a slow/failed call can't block the page.
      if (String(contracts.pepeAMM.target) !== ZERO_ADDR) {
        const [price, reserves, oraclePx, maxAge] = await Promise.all([
          safeRead(contracts.pepeAMM.getPrice() as Promise<bigint>, 0n),
          safeRead(contracts.pepeAMM.getReserves() as Promise<[bigint, bigint]>, [0n, 0n] as [bigint, bigint]),
          // oraclePrice() ＝ 舊 getPrice() 的語意（oracle 參考價 + updatedAt）。
          // swap 會在 oracle 過期時 revert StaleOraclePrice，所以這個 updatedAt
          // 要拿來事前擋單，而不是等使用者付完 gas 才知道。
          safeRead(contracts.pepeAMM.oraclePrice() as unknown as Promise<[bigint, bigint]>, [0n, 0n] as [bigint, bigint]),
          safeRead(contracts.pepeAMM.maxOracleAge() as Promise<bigint>, 0n),
        ]);
        setAmmPrice(price);
        setAmmEth(reserves[0]);
        setAmmUsdc(reserves[1]);
        setAmmOracle({ price: oraclePx[0], updatedAt: oraclePx[1] });
        setAmmMaxAge(maxAge);
      } else {
        setAmmPrice(0n);
        setAmmEth(0n);
        setAmmUsdc(0n);
        setAmmOracle({ price: 0n, updatedAt: 0n });
        setAmmMaxAge(0n);
      }

      // Above-the-fold shell (balances, faucets, swap, margin, open-position form)
      // is ready → drop the skeleton now. Positions stream in below afterwards,
      // so a slow positions read can't delay the whole page.
      setPageLoading(false);

      const ids = await safeRead(contracts.exchange.getUserPositions(addr) as Promise<bigint[]>, []);
      // 三個 view 之前是逐一 await：N 個倉位就是 3N 個往返。getPosition 併發拿完，
      // 其餘兩個再一起併發，總延遲降到 2 個往返。
      const rawPositions = await Promise.all(
        ids.map(id => safeRead(contracts.exchange.getPosition(id) as unknown as Promise<RawPos | null>, null)),
      );
      const settled = await Promise.allSettled(
        ids.map(async (id, i): Promise<PositionRow | null> => {
          const raw = rawPositions[i];
          if (!raw || !raw.isOpen) return null;
          const [pnl, pr] = await Promise.all([
            safeRead(contracts.exchange.getUnrealizedPnL(id) as Promise<bigint>, 0n),
            safeRead(contracts.oracle.getPrice(raw.asset) as unknown as Promise<[bigint, bigint]>, [0n, 0n] as [bigint, bigint]),
          ]);
          return {
            id, asset: raw.asset, isLong: raw.isLong,
            entryPrice: raw.entryPrice, margin: raw.margin, leverage: raw.leverage,
            unrealizedPnL: pnl, currentPrice: pr[0] * 10n ** 10n,
            openedAt: raw.openedAt ?? 0n,
          };
        })
      );
      setPositions(
        settled
          .map(r => (r.status === 'fulfilled' ? r.value : null))
          .filter((r): r is PositionRow => r !== null),
      );
    } finally {
      setPageLoading(false);
    }
  }, [contracts, wallet.address, wallet.provider]);

  useEffect(() => {
    if (!contracts) return;
    let cancelled = false;
    void (async () => {
      const pr = await safeRead(
        contracts.oracle.getPrice(selAsset) as unknown as Promise<[bigint, bigint]>,
        [0n, 0n] as [bigint, bigint],
      );
      if (!cancelled) setCurPrice(pr[0] * 10n ** 10n);
    })();
    return () => { cancelled = true; };
  }, [contracts, selAsset]);

  useEffect(() => { void fetchAll() }, [fetchAll]);

  // 防呆保險：掛載後最多 10 秒一定關掉骨架，避免任何未來路徑再卡死。
  useEffect(() => {
    const t = setTimeout(() => setPageLoading(false), 10000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => { setHistory([]); setEsgConfirmed(false); }, [selAsset]);

  // Fetch ESG reward status for high-ESG positions
  useEffect(() => {
    const addr = getAddresses(wallet.chainId);
    if (addr?.EsgRewardDistributor === '0x0000000000000000000000000000000000000000') return;
    if (!contracts?.esgRewardDistributor || !positions.length) return;

    const highEsgPositions = positions.filter(r => (esg[r.asset]?.composite ?? 0) >= 70);
    if (!highEsgPositions.length) return;

    let cancelled = false;
    void (async () => {
      const results = await Promise.allSettled(
        highEsgPositions.map(async row => {
          const [isRewarded, preview] = await Promise.all([
            contracts.esgRewardDistributor.rewarded(row.id) as Promise<boolean>,
            contracts.esgRewardDistributor.previewReward(row.id) as Promise<bigint>,
          ]);
          return { id: String(row.id), isRewarded, preview };
        })
      );
      if (cancelled) return;
      const newRewarded: Record<string, boolean> = {};
      const newPreview:  Record<string, bigint>  = {};
      for (const r of results) {
        if (r.status === 'fulfilled') {
          newRewarded[r.value.id] = r.value.isRewarded;
          newPreview[r.value.id]  = r.value.preview;
        }
      }
      setEsgRewardedMap(newRewarded);
      setEsgPreviewMap(newPreview);

      // EsgRewardDistributor 現在要求倉位 isOpen 且已滿最短持有期（預設 30 天），
      // 而 previewReward 對不合格的情況一律回 0。沒有 minHoldSeconds 的話，
      // 使用者只會看到一顆寫著「0.0 PEPE」的按鈕，按下去 revert HoldTooShort，
      // 完全不知道自己只是抱得不夠久。
      const mh = await safeRead(contracts.esgRewardDistributor.minHoldSeconds() as Promise<bigint>, 0n);
      if (!cancelled) setEsgMinHold(mh);
    })();
    return () => { cancelled = true; };
  }, [contracts, positions, esg, wallet.chainId]);

  // Track history for chart
  useEffect(() => {
    const p = livePrices[selAsset]?.usd;
    if (p !== undefined) {
      setHistory(prev => {
        const next = [...prev, { time: new Date().toLocaleTimeString(), price: p }];
        return next.slice(-30);
      });
    }
  }, [livePrices[selAsset]?.usd, selAsset]);

  // ── Live AMM quote (constant-product → 有滑點) ──────────────────────────────
  // quote 現在是 x*y=k 的實際輸出，不是 oracle × 數量。除了金額之外還要把
  // 價格衝擊算出來給使用者看，否則大額兌換會在毫無預警下吃掉好幾個百分點。
  useEffect(() => {
    if (!contracts?.pepeAMM || String(contracts.pepeAMM.target) === ZERO_ADDR
        || !payAmount || parseFloat(payAmount) <= 0) {
      setReceiveAmount('');
      setImpactBps(null);
      setQuotedOut(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const parsed = parseEther(payAmount);
        const isEthIn = swapMode === 'eth-to-usdc';
        const out = isEthIn
          ? await contracts.pepeAMM.quoteETHForUSDC(parsed) as bigint
          : await contracts.pepeAMM.quoteUSDCForETH(parsed) as bigint;
        if (cancelled) return;
        setQuotedOut(out);
        setReceiveAmount((Number(out) / 1e18).toFixed(isEthIn ? 2 : 6));
        setImpactBps(priceImpactBps({
          amountIn:   parsed,
          amountOut:  out,
          reserveIn:  isEthIn ? ammEth : ammUsdc,
          reserveOut: isEthIn ? ammUsdc : ammEth,
        }));
      } catch {
        // quote 也會 revert（InsufficientLiquidity / InsufficientInput）——那代表
        // 這筆金額根本換不成，顯示空白比顯示一個假數字誠實。
        if (!cancelled) { setReceiveAmount(''); setImpactBps(null); setQuotedOut(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [contracts?.pepeAMM, payAmount, swapMode, ammEth, ammUsdc]);

  // ── Transactions ────────────────────────────────────────────────────────────
  const ammDeployed = !!contracts && String(contracts.pepeAMM.target) !== ZERO_ADDR;

  // swap 會在 oracle 過期（> maxOracleAge，預設 1h）時 revert StaleOraclePrice。
  // 和開倉的 stale 擋單同樣的道理：能在按下去之前就知道的事，不要讓使用者付 gas 才知道。
  const ammOracleStale = isOracleStale(ammOracle.updatedAt, ammMaxAge, Date.now() / 1000);
  const AMM_STALE_MSG = t.exchange.tx.ammStale;

  // ETH ↔ USDC swap via PepeAMM (constant product). minOut 一律以**當下的 quote**
  // 為基準打 DEFAULT_SLIPPAGE_BPS，而不是 oracle 價——池子有滑點，拿 oracle 價
  // 打 0.5% 當底線會讓任何稍大的單子必定 revert InsufficientOutput。
  // 這 0.5% 只負責吸收「送出 → 上鏈」之間別人動過池子的那一點差。
  const doSwap = async () => {
    if (!contracts || !wallet.address || !ammDeployed) return;
    const amt = parseFloat(payAmount);
    if (!amt || amt <= 0) { notify(t.exchange.tx.enterValidAmount, false); return; }
    // 事前擋掉必定 revert 的兩種情況，不讓使用者白付 gas。
    if (ammOracleStale) { notify(AMM_STALE_MSG, false); return; }
    const amm = String(contracts.pepeAMM.target);

    setLoad('swap', true);
    try {
      if (swapMode === 'eth-to-usdc') {
        const ethIn  = parseEther(payAmount);
        const quoted = await contracts.pepeAMM.quoteETHForUSDC(ethIn) as bigint;
        const minOut = minOutWithSlippage(quoted);
        const tx = asTx(await contracts.pepeAMM.swapETHForUSDC(minOut, { value: ethIn }));
        await tx.wait();
        notify(
          interpolate(t.exchange.tx.swappedEthForToken, {
            amount: payAmount,
            received: (Number(quoted) / 1e18).toFixed(2),
            token: STABLE_LABEL,
          }),
          true,
          tx.hash
        );
      } else {
        const usdcIn = parseEther(payAmount);
        const currentAllowance = await contracts.usdc.allowance(wallet.address, amm) as bigint;
        if (currentAllowance < usdcIn) {
          notify(interpolate(t.exchange.tx.approving, { token: STABLE_LABEL }), true);
          const approveTx = asTx(await contracts.usdc.approve(amm, usdcIn));
          await approveTx.wait();
        }
        const quoted    = await contracts.pepeAMM.quoteUSDCForETH(usdcIn) as bigint;
        const minEthOut = minOutWithSlippage(quoted);
        const tx = asTx(await contracts.pepeAMM.swapUSDCForETH(usdcIn, minEthOut));
        await tx.wait();
        notify(
          interpolate(t.exchange.tx.swappedTokenForEth, {
            amount: payAmount,
            token: STABLE_LABEL,
            received: (Number(quoted) / 1e18).toFixed(6),
          }),
          true,
          tx.hash
        );
      }
      setPayAmount('');
      await new Promise(r => setTimeout(r, 1500));
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('swap', false); }
  };

  // Testnet on-ramp for the mock margin stablecoin (USDC = MockUSDC) — users can
  // also self-serve from the faucet, then Approve & Deposit as margin.
  const claimFaucet = async () => {
    if (!contracts) return;
    setLoad('faucet', true);
    try {
      const tx = asTx(await contracts.usdc.faucet());
      await tx.wait();
      notify(interpolate(t.exchange.tx.faucetStable, { token: STABLE_LABEL }), true, tx.hash);
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('faucet', false); }
  };

  // Testnet faucet for MockUSDT. Separate token from the USDC margin
  // stablecoin — hold / swap only, not accepted as margin (see note in the
  // Margin Account card). Guarded: skip when undeployed.
  const usdtDeployed = !!contracts && String(contracts.usdt.target) !== ZERO_ADDR;
  const claimUsdt = async () => {
    if (!contracts || !usdtDeployed) return;
    setLoad('usdt', true);
    try {
      const tx = asTx(await contracts.usdt.faucet());
      await tx.wait();
      notify(
        interpolate(t.exchange.tx.faucetAltStable, { alt: ALT_STABLE_LABEL, token: STABLE_LABEL }),
        true,
        tx.hash
      );
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('usdt', false); }
  };

  // Testnet faucet for the platform token PEPE (guarded: skip if undeployed).
  const pepeDeployed = !!contracts && String(contracts.pepeToken.target) !== ZERO_ADDR;
  const claimPepe = async () => {
    if (!contracts || !pepeDeployed) return;
    setLoad('pepe', true);
    try {
      const tx = asTx(await contracts.pepeToken.faucet());
      await tx.wait();
      notify(t.exchange.tx.faucetPepe, true, tx.hash);
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('pepe', false); }
  };

  const addToWallet = async () => {
    if (!contracts || !window.ethereum) return;
    try {
      await window.ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address: contracts.usdc.target,
            symbol: STABLE_LABEL,
            decimals: 18,
          },
        },
      });
    } catch (e) {
      console.error('Add to wallet failed', e);
    }
  };

  const approveDeposit = async () => {
    if (!contracts) return;
    const amt = tryParse(depositAmt);
    if (!amt) { notify(t.exchange.tx.enterValidAmount, false); return; }
    setLoad('deposit', true);
    try {
      const approveTx = asTx(await contracts.usdc.approve(String(contracts.exchange.target), amt));
      await approveTx.wait();
      const depositTx = asTx(await contracts.exchange.depositMargin(amt));
      await depositTx.wait();
      notify(
        interpolate(t.exchange.tx.deposited, { amount: depositAmt, token: STABLE_LABEL }),
        true,
        depositTx.hash
      );
      setDepositAmt('');
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('deposit', false); }
  };

  const doWithdraw = async () => {
    if (!contracts) return;
    const amt = tryParse(withdrawAmt);
    if (!amt) { notify(t.exchange.tx.enterValidAmount, false); return; }
    setLoad('withdraw', true);
    try {
      const tx = asTx(await contracts.exchange.withdrawMargin(amt));
      await tx.wait();
      notify(
        interpolate(t.exchange.tx.withdrew, { amount: withdrawAmt, token: STABLE_LABEL }),
        true,
        tx.hash
      );
      setWithdrawAmt('');
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('withdraw', false); }
  };

  const openPosition = async () => {
    if (!contracts) return;
    const amt = tryParse(openMgn);
    if (!amt) { notify(t.exchange.tx.enterValidMargin, false); return; }
    if (amt > freeMgn) {
      notify(t.exchange.tx.insufficientMargin, false);
      return;
    }
    // F-1：鏈上價過期時 openPosition 會 revert StalePrice。按鈕已經是 disabled，
    // 這裡是第二道防線——鍵盤送出、UI 狀態還沒重繪的那一瞬間都要擋住。
    if (openStaleNotice) { notify(openStaleNotice, false); return; }
    setLoad('open', true);
    try {
      const execFee = (await contracts.exchange.executionFee()) as bigint;
      const tx = asTx(await contracts.exchange.openPosition(selAsset, isLong, amt, BigInt(leverage), { value: execFee }));
      await tx.wait();
      notify(
        interpolate(t.exchange.tx.positionOpened, {
          side: isLong ? t.exchange.side.long : t.exchange.side.short,
          asset: ASSET_LABEL[selAsset] ?? selAsset,
        }),
        true,
        tx.hash
      );
      setOpenMgn('');
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('open', false); }
  };

  // M1：平倉走的是同一顆 oracle，一樣會被 StalePrice 擋。以該倉位自己的標的
  // 判斷，而不是拿當前選中的資產去猜——持倉表裡每一列可能是不同標的。
  const staleNoticeForAsset = (asset: string): string | null =>
    stalenessNotice(livePrices[asset as AssetId]?.freshness, ASSET_LABEL[asset as AssetId] ?? undefined);

  const closePos = async (id: bigint, asset: string) => {
    if (!contracts) return;
    const blocked = staleNoticeForAsset(asset);
    if (blocked) { notify(blocked, false); return; }
    const key = `close_${id}`;
    setLoad(key, true);
    try {
      const tx = asTx(await contracts.exchange.closePosition(id));
      await tx.wait();
      notify(t.exchange.tx.positionClosed, true, tx.hash);
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad(key, false); }
  };

  const claimEsgReward = async (id: bigint) => {
    if (!contracts) return;
    const key = `claim_${id}`;
    setLoad(key, true);
    try {
      const tx = asTx(await contracts.esgRewardDistributor.claimEsgReward(id));
      await tx.wait();
      setEsgRewardedMap(prev => ({ ...prev, [String(id)]: true }));
      notify(t.exchange.tx.esgClaimed, true, tx.hash);
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad(key, false); }
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const selectedAssetMeta     = ASSET_META[selAsset];
  const kycRequired           = selectedAssetMeta?.regulated ?? false;
  const kycBlocked            = kycRequired && !isKYCVerified;
  const hasEsgRewardDistributor = getAddresses(wallet.chainId)?.EsgRewardDistributor
    !== '0x0000000000000000000000000000000000000000';

  const selEsg   = esg[selAsset as string] ?? null;
  const isLowEsg = selEsg !== null && selEsg.composite < 50;

  const openMgnBig = tryParse(openMgn);
  const notional   = openMgnBig !== null ? openMgnBig * BigInt(leverage) : 0n;

  // 清算價公式集中在 lib/pepefi/liquidation.ts，和終端機共用同一份
  // （之前這頁含 5.1% buffer、終端機沒有，同一個倉位在兩頁看到兩個數字）。
  const liqPrice = estimateLiquidationPrice({ entryPrice: curPrice, isLong, leverage: BigInt(leverage) });

  const livePositions = positions.map(p => {
    const liveUsd = livePrices[p.asset as AssetId]?.usd;
    const currentLivePrice = liveUsd ? BigInt(Math.round(liveUsd * 1e8)) * 10n**10n : p.currentPrice;

    // entryPrice 為 0 代表這筆讀取失敗或倉位資料異常；除下去會是 division by zero。
    // 同檔另外兩處早就有這個守衛，只有這裡漏掉。
    const notional = p.margin * p.leverage;
    const size = p.entryPrice > 0n ? (notional * 10n**18n) / p.entryPrice : 0n;
    const priceChange = currentLivePrice - p.entryPrice;
    let livePnL = p.entryPrice > 0n ? (priceChange * size) / 10n**18n : 0n;
    if (!p.isLong) livePnL = -livePnL;

    return { ...p, currentLivePrice, livePnL };
  });

  const totalUnrealizedPnL = livePositions.reduce((acc, p) => acc + p.livePnL, 0n);
  const accountEquity = freeMgn + totalUnrealizedPnL;

  const activeTask = Object.entries(busy).find(([_, v]) => v)?.[0];
  const isBusy = !!activeTask;
  let loadingMsg = t.exchange.loading.fallback;
  if (activeTask) {
    if (activeTask === 'swap') loadingMsg = interpolate(swapMode === 'eth-to-usdc' ? t.exchange.loading.swapEthToToken : t.exchange.loading.swapTokenToEth, { token: STABLE_LABEL });
    else if (activeTask === 'faucet') loadingMsg = interpolate(t.exchange.loading.faucetStable, { token: STABLE_LABEL });
    else if (activeTask === 'pepe') loadingMsg = t.exchange.loading.faucetPepe;
    else if (activeTask === 'deposit') loadingMsg = t.exchange.loading.deposit;
    else if (activeTask === 'withdraw') loadingMsg = t.exchange.loading.withdraw;
    else if (activeTask === 'open') loadingMsg = t.exchange.loading.open;
    else if (activeTask.startsWith('close')) loadingMsg = t.exchange.loading.close;
  }

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">{t.exchange.connectWallet}</Typography>
      </Box>
    );
  }

  if (pageLoading) {
    return (
      <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Skeleton height={100} variant="rectangular" />
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, md: 6 }}>
            <Skeleton height={200} variant="rectangular" />
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <Skeleton height={200} variant="rectangular" />
          </Grid>
        </Grid>
        <Skeleton height={250} variant="rectangular" />
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 100 }}>
          <Typography color="text.secondary">{t.exchange.loadingChainData}</Typography>
        </Box>
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Global Transaction Overlay */}
      <Backdrop
        open={isBusy}
        sx={{
          color: '#fff',
          zIndex: (theme) => theme.zIndex.drawer + 999,
          flexDirection: 'column',
          gap: 3,
          bgcolor: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(4px)',
        }}
      >
        <Box sx={{ position: 'relative', display: 'inline-flex' }}>
          <CircularProgress size={64} color="primary" />
          <Box
            sx={{
              top: 0,
              left: 0,
              bottom: 0,
              right: 0,
              position: 'absolute',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.5rem',
            }}
          >
            🐸
          </Box>
        </Box>
        <Box sx={{ textAlign: 'center' }}>
          <Typography variant="h5" sx={{ fontWeight: 'bold', mb: 1 }}>{loadingMsg}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 300, mx: 'auto' }}>
            {t.exchange.confirmInWallet}
          </Typography>
        </Box>
      </Backdrop>

      <Box sx={{ display: 'flex', mb: 1 }}>
        <PaperTradingBadge />
      </Box>

      {/* Pointer to the ERC-20 layer. Positions opened here are ledger entries
          on PerpetualExchange, so nothing lands in the wallet; /tokens is where
          real transferable tokens are minted. */}
      <Alert severity="info" sx={{ mb: 2 }}>
        {t.exchange.markup.syntheticPositionBefore}<b>{t.exchange.markup.syntheticPositionBold}</b>{t.exchange.markup.syntheticPositionAfter}
        <Link component={RouterLink} to={paths.pepefi.tokens} sx={{ ml: 0.5, fontWeight: 'bold' }}>
          {t.exchange.markup.tokenizedAssetsLink}
        </Link>
      </Alert>

      {/* Onboarding guide */}
      <Alert
        severity="info"
        variant="outlined"
        sx={{
          bgcolor: 'rgba(0, 184, 217, 0.08)',
          borderColor: 'rgba(0, 184, 217, 0.24)',
          color: 'info.main',
          '& .MuiAlert-icon': { color: 'info.main' },
        }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 1 }}>
          {t.exchange.guide.title}
        </Typography>
        <Typography variant="body2" component="ol" sx={{ pl: 2, m: 0, '& li': { mb: 0.5 } }}>
          <li><strong>{t.exchange.markup.stepGetTokensLabel}</strong> {interpolate(t.exchange.markup.stepGetTokensBody, { token: STABLE_LABEL })}</li>
          <li><strong>{t.exchange.markup.stepMarginLabel}</strong> {interpolate(t.exchange.markup.stepMarginBody, { token: STABLE_LABEL })}</li>
          <li><strong>{t.exchange.markup.stepOpenLabel}</strong> {t.exchange.markup.stepOpenBody}</li>
          <li><strong>{t.exchange.markup.stepPnlLabel}</strong> {t.exchange.markup.stepPnlBody}</li>
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {t.exchange.markup.currencyNoteLine1Before}<b>{STABLE_LABEL}</b>{t.exchange.markup.currencyNoteLine1After}
          <b>x402</b>{t.exchange.markup.currencyNoteLine2After}<b>{X402_STABLE_LABEL}</b>{t.exchange.markup.currencyNoteLine2End}
        </Typography>
      </Alert>

      {/* Get Test Tokens — faucets (full-width, above swap + margin) */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{t.exchange.faucet.title}</Typography>
              <Typography variant="caption" color="text.secondary">
                {interpolate(t.exchange.faucet.intro, {
                  stable: STABLE_LABEL,
                  x402Stable: X402_STABLE_LABEL,
                })}
              </Typography>
            </Box>

            {/* USDC — mock margin stablecoin */}
            <Box sx={{ bgcolor: 'background.neutral', borderRadius: 2, p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
                  {STABLE_LABEL} <Typography component="span" variant="caption" color="text.secondary">{t.exchange.faucet.stableNote}</Typography>
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                  {interpolate(t.exchange.faucet.balance, { amount: f18(usdcBal) })}
                </Typography>
              </Box>
              <Button
                variant="contained"
                onClick={() => void claimFaucet()}
                disabled={busy['faucet']}
                startIcon={<span>🚰</span>}
                sx={{ textTransform: 'none', fontWeight: 'bold', whiteSpace: 'nowrap' }}
              >
                {busy['faucet']
                  ? t.exchange.faucet.claiming
                  : interpolate(t.exchange.faucet.claimToken, { token: STABLE_LABEL })}
              </Button>
            </Box>

            {/* USDT — second mock stablecoin (hold / swap only, not margin) */}
            <Box sx={{ bgcolor: 'background.neutral', borderRadius: 2, p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
                  {ALT_STABLE_LABEL} <Typography component="span" variant="caption" color="text.secondary">{t.exchange.faucet.altStableNote}</Typography>
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                  {usdtDeployed
                    ? interpolate(t.exchange.faucet.balance, { amount: f18(usdtBal) })
                    : t.exchange.faucet.notDeployed}
                </Typography>
              </Box>
              {usdtDeployed ? (
                <Button
                  variant="contained"
                  color="info"
                  onClick={() => void claimUsdt()}
                  disabled={busy['usdt']}
                  startIcon={<span>🚰</span>}
                  sx={{ textTransform: 'none', fontWeight: 'bold', whiteSpace: 'nowrap' }}
                >
                  {busy['usdt']
                    ? t.exchange.faucet.claiming
                    : interpolate(t.exchange.faucet.claimToken, { token: ALT_STABLE_LABEL })}
                </Button>
              ) : (
                <Chip size="small" label={t.exchange.faucet.notDeployedChip} variant="outlined" />
              )}
            </Box>

            {/* PEPE — platform token */}
            <Box sx={{ bgcolor: 'background.neutral', borderRadius: 2, p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
                  PEPE <Typography component="span" variant="caption" color="text.secondary">{t.exchange.faucet.pepeNote}</Typography>
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                  {pepeDeployed
                    ? interpolate(t.exchange.faucet.balance, { amount: f18(pepeBal) })
                    : t.exchange.faucet.notDeployed}
                </Typography>
              </Box>
              {pepeDeployed ? (
                <Button
                  variant="contained"
                  color="success"
                  onClick={() => void claimPepe()}
                  disabled={busy['pepe']}
                  startIcon={<span>🐸</span>}
                  sx={{ textTransform: 'none', fontWeight: 'bold', whiteSpace: 'nowrap' }}
                >
                  {busy['pepe']
                    ? t.exchange.faucet.claiming
                    : interpolate(t.exchange.faucet.claimToken, { token: 'PEPE' })}
                </Button>
              ) : (
                <Chip size="small" label={t.exchange.faucet.notDeployedChip} variant="outlined" />
              )}
            </Box>
            {!pepeDeployed && (
              <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
                <Typography variant="caption">
                  {t.exchange.faucet.pepeUndeployed}
                </Typography>
              </Alert>
            )}

            <Typography variant="caption" color="text.secondary">
              {t.exchange.markup.ethBalanceBefore}<Box component="span" sx={{ fontFamily: MONO, color: 'text.primary' }}>{ethBal}</Box>{t.exchange.markup.ethBalanceAfter}
            </Typography>

            {/* faucet() 現在要求 msg.sender == tx.origin：合約錢包按下去必定
                revert FaucetCallerMustBeEOA。這是水龍頭唯一一個使用者自己無法
                從錯誤訊息推理出來的限制，所以寫在按鈕旁邊而不是只放在 toast。 */}
            <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
              <Typography variant="caption">
                {t.exchange.markup.faucetEoaLine1}<b>{t.exchange.markup.faucetEoaBold1}</b>{t.exchange.markup.faucetEoaLine1After}
                <code>{t.exchange.markup.faucetEoaCode1}</code>{t.exchange.markup.faucetEoaLine2Mid}<b>{t.exchange.markup.faucetEoaBold2}</b>
                {t.exchange.markup.faucetEoaLine3}<code>{t.exchange.markup.faucetEoaCode2}</code>{t.exchange.markup.faucetEoaLine3After}
              </Typography>
            </Alert>

            <Button
              variant="text"
              size="small"
              onClick={() => void addToWallet()}
              startIcon={<Icon icon="solar:wallet-bold-duotone" />}
              sx={{ textTransform: 'none', color: 'info.main', fontSize: '0.75rem', alignSelf: 'flex-start' }}
            >
              {interpolate(t.exchange.faucet.addToWallet, { token: STABLE_LABEL })}
            </Button>
      </Card>

      {/* A & B — Swap + Margin */}
      <Grid container spacing={3}>
        {/* A. Swap (ETH ↔ USDC via PepeAMM) */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card
            sx={{
              p: 2,
              bgcolor: '#0D111C',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 3,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              height: '100%',
            }}
          >
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', px: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: 'white' }}>{t.exchange.swap.title}</Typography>
              {/* 池子是恆定乘積，不是 oracle 定價。舊的「● Oracle-priced」徽章
                  現在是錯的，而且錯在會讓人以為大額換匯沒有滑點。 */}
              <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 'bold' }}>{t.exchange.swap.poolBadge}</Typography>
            </Box>

            {!ammDeployed ? (
              <Alert severity="info" variant="outlined" sx={{ m: 1 }}>
                <Typography variant="caption">{t.exchange.swap.notDeployed}</Typography>
              </Alert>
            ) : (
              <>
                {/* Pay block */}
                <Box sx={{ bgcolor: '#131A2A', borderRadius: 2, p: 2 }}>
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>{t.exchange.swap.youPay}</Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <input
                      type="number"
                      placeholder="0"
                      value={payAmount}
                      onChange={e => setPayAmount(e.target.value)}
                      style={{ width: '100%', background: 'transparent', border: 'none', fontSize: '2rem', color: 'white', outline: 'none', fontWeight: 700, fontFamily: MONO }}
                    />
                    <Chip
                      label={swapMode === 'eth-to-usdc' ? 'ETH' : STABLE_LABEL}
                      sx={{ bgcolor: '#293249', color: 'white', fontWeight: 'bold' }}
                    />
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {interpolate(t.exchange.swap.balance, {
                        amount: swapMode === 'eth-to-usdc' ? ethBal : f18(usdcBal),
                      })}
                    </Typography>
                  </Box>
                </Box>

                {/* Switch direction */}
                <Box sx={{ display: 'flex', justifyContent: 'center', my: -1.5, zIndex: 2 }}>
                  <Button
                    onClick={() => { setSwapMode(m => m === 'eth-to-usdc' ? 'usdc-to-eth' : 'eth-to-usdc'); setPayAmount(''); setReceiveAmount(''); }}
                    sx={{ minWidth: 0, p: 1, bgcolor: '#131A2A', border: '4px solid #0D111C', color: 'white', borderRadius: 2, '&:hover': { bgcolor: '#1e2a45' } }}
                  >
                    <Icon icon="solar:transfer-vertical-bold-duotone" width={18} />
                  </Button>
                </Box>

                {/* Receive block */}
                <Box sx={{ bgcolor: '#131A2A', borderRadius: 2, p: 2 }}>
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>{t.exchange.swap.youReceive}</Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Typography sx={{ flex: 1, fontSize: '2rem', color: 'white', fontWeight: 700, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {receiveAmount || '0'}
                    </Typography>
                    <Chip
                      label={swapMode === 'eth-to-usdc' ? STABLE_LABEL : 'ETH'}
                      sx={{ bgcolor: '#293249', color: 'white', fontWeight: 'bold' }}
                    />
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {interpolate(t.exchange.swap.balance, {
                        amount: swapMode === 'eth-to-usdc' ? f18(usdcBal) : ethBal,
                      })}
                    </Typography>
                  </Box>
                </Box>

                {/* Pool info。getPrice() 是**池內現價**（儲備比例），oraclePrice()
                    才是 oracle 參考價——兩個都顯示，因為它們分岔到超過
                    maxOracleDeviationBps 時合約就會擋下兌換。 */}
                <Box sx={{ px: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    {t.exchange.swap.poolPrice}: <Box component="span" sx={{ color: 'white', fontFamily: MONO, fontWeight: 'bold' }}>1 ETH = {ammPrice > 0n ? (Number(ammPrice) / 1e18).toFixed(2) : '–'} {STABLE_LABEL}</Box>
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t.exchange.swap.oracleRef}: <Box component="span" sx={{ color: 'white', fontFamily: MONO }}>1 ETH = {ammOracle.price > 0n ? (Number(ammOracle.price) / 1e18).toFixed(2) : '–'} {STABLE_LABEL}</Box>
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t.exchange.swap.poolReserves}: <Box component="span" sx={{ color: 'white', fontFamily: MONO }}>{(Number(ammEth) / 1e18).toFixed(4)} ETH</Box> / <Box component="span" sx={{ color: 'white', fontFamily: MONO }}>{(Number(ammUsdc) / 1e18).toFixed(2)} {STABLE_LABEL}</Box>
                  </Typography>
                  {impactBps !== null && (
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: impactBps >= HIGH_IMPACT_BPS ? 'bold' : 'normal',
                        color: impactBps >= SEVERE_IMPACT_BPS
                          ? 'error.main'
                          : impactBps >= HIGH_IMPACT_BPS ? 'warning.main' : 'text.secondary',
                      }}
                    >
                      {t.exchange.swap.priceImpact}: <Box component="span" sx={{ fontFamily: MONO }}>{(impactBps / 100).toFixed(2)}%</Box>
                    </Typography>
                  )}
                  {quotedOut !== null && quotedOut > 0n && (
                    <Typography variant="caption" color="text.secondary">
                      {interpolate(t.exchange.swap.minimumReceived, {
                        tolerance: (DEFAULT_SLIPPAGE_BPS / 100).toFixed(1),
                      })}:{' '}
                      <Box component="span" sx={{ color: 'white', fontFamily: MONO }}>
                        {(Number(minOutWithSlippage(quotedOut)) / 1e18).toFixed(swapMode === 'eth-to-usdc' ? 2 : 6)}{' '}
                        {swapMode === 'eth-to-usdc' ? STABLE_LABEL : 'ETH'}
                      </Box>
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {t.exchange.swap.constantProductNote}
                  </Typography>
                </Box>

                {impactBps !== null && impactBps >= SEVERE_IMPACT_BPS && (
                  <Alert severity="error" variant="outlined" sx={{ py: 0.5 }}>
                    <Typography variant="caption">
                      {t.exchange.markup.priceImpactBefore}<b>{(impactBps / 100).toFixed(2)}%</b>{t.exchange.markup.priceImpactAfter}<code>{t.exchange.markup.priceImpactCode}</code>{t.exchange.markup.priceImpactLine2After}
                    </Typography>
                  </Alert>
                )}

                {ammOracleStale && (
                  <Alert severity="warning" variant="outlined" sx={{ py: 0.5 }}>
                    <Typography variant="caption">⛔ {AMM_STALE_MSG}</Typography>
                  </Alert>
                )}

                <Button
                  variant="contained"
                  fullWidth
                  onClick={() => void doSwap()}
                  disabled={busy['swap'] || !payAmount || parseFloat(payAmount) <= 0 || ammOracleStale}
                  sx={{ py: 1.6, borderRadius: 2, fontWeight: 'bold', fontSize: '1.05rem' }}
                >
                  {busy['swap']
                    ? t.exchange.swap.swapping
                    : ammOracleStale
                      ? t.exchange.swap.oracleStale
                      : !payAmount || parseFloat(payAmount) <= 0
                        ? t.exchange.swap.enterAmount
                        : interpolate(
                            swapMode === 'eth-to-usdc'
                              ? t.exchange.swap.ethToToken
                              : t.exchange.swap.tokenToEth,
                            { token: STABLE_LABEL },
                          )}
                </Button>
              </>
            )}
          </Card>
        </Grid>

        {/* B. Margin & Account Equity */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3, height: '100%' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <Box>
                <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold' }}>
                  {t.exchange.margin.accountEquity}
                </Typography>
                <Typography variant="h4" sx={{ fontWeight: 800, fontFamily: MONO, mt: 0.5 }}>
                  {fUsd(accountEquity)}{' '}
                  <Typography component="span" variant="subtitle2" color="text.secondary">
                    {interpolate(t.exchange.margin.equityUnit, { token: STABLE_LABEL })}
                  </Typography>
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'right' }}>
                <Typography variant="caption" color="text.secondary" display="block">{t.exchange.margin.freeMargin}</Typography>
                <Typography sx={{ fontFamily: MONO, fontWeight: 'bold' }}>{f18(freeMgn)}</Typography>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>{t.exchange.margin.unrealizedPnl}</Typography>
                <Typography sx={{ fontFamily: MONO, fontWeight: 'bold', color: pnlColor(totalUnrealizedPnL) }}>
                  {fPnL(totalUnrealizedPnL)}
                </Typography>
              </Box>
            </Box>

            <Divider />

            <Stack spacing={2}>
              {/* Stablecoin selector. Balances follow the selection; margin does
                  not — PerpetualExchange only accepts MockUSDC, so the note
                  below says so rather than letting the toggle imply otherwise. */}
              <Box>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                  {t.exchange.margin.stablecoin}
                </Typography>
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={stable}
                  onChange={(_, v) => v && setStable(v)}
                >
                  <ToggleButton value="USDC" sx={{ textTransform: 'none', px: 2 }}>{STABLE_LABEL}</ToggleButton>
                  <ToggleButton value="USDT" sx={{ textTransform: 'none', px: 2 }}>{ALT_STABLE_LABEL}</ToggleButton>
                </ToggleButtonGroup>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75, fontFamily: MONO }}>
                  {interpolate(t.exchange.margin.balance, {
                    token: stable === 'USDC' ? STABLE_LABEL : ALT_STABLE_LABEL,
                  })}: {f18(stable === 'USDC' ? usdcBal : usdtBal)}
                </Typography>
                <Typography variant="caption" color="warning.main" display="block" sx={{ mt: 0.5 }}>
                  {t.exchange.markup.marginNoteBefore}<b>{STABLE_LABEL}</b>{interpolate(t.exchange.markup.marginNoteAfter, { altToken: ALT_STABLE_LABEL })}
                </Typography>
              </Box>

              <Box sx={{ display: 'flex', gap: 1 }}>
                <TextField
                  placeholder={t.exchange.margin.depositPlaceholder}
                  size="small"
                  fullWidth
                  type="number"
                  value={depositAmt}
                  onChange={e => setDepositAmt(e.target.value)}
                  disabled={busy['deposit']}
                />
                <Button
                  variant="contained"
                  color="success"
                  onClick={() => void approveDeposit()}
                  disabled={busy['deposit']}
                  sx={{ fontWeight: 'bold', minWidth: 160 }}
                >
                  {busy['deposit'] ? t.exchange.working : t.exchange.margin.approveDeposit}
                </Button>
              </Box>

              <Box sx={{ display: 'flex', gap: 1 }}>
                <TextField
                  placeholder={t.exchange.margin.withdrawPlaceholder}
                  size="small"
                  fullWidth
                  type="number"
                  value={withdrawAmt}
                  onChange={e => setWithdrawAmt(e.target.value)}
                  disabled={busy['withdraw']}
                />
                <Button
                  variant="contained"
                  color="error"
                  onClick={() => void doWithdraw()}
                  disabled={busy['withdraw']}
                  sx={{ fontWeight: 'bold', minWidth: 160 }}
                >
                  {busy['withdraw'] ? t.exchange.working : t.exchange.margin.withdraw}
                </Button>
              </Box>
            </Stack>
          </Card>
        </Grid>
      </Grid>

      {/* C. Open Position —— 永續開倉面板，跟著 SHOW_PERPETUALS 走。
          旗標關閉時這一頁只剩「入金與兌換」：水龍頭、ETH↔USDC、保證金。
          買賣資產走 /tokens 的 AssetVault mint/redeem，那是現貨。 */}
      {SHOW_PERPETUALS && (
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3.5 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          {t.exchange.open.title}
        </Typography>

        {riskOpen ? (
          <Alert severity="info" variant="outlined" onClose={() => setRiskOpen(false)} sx={{ py: 0.5 }}>
            {t.exchange.open.riskNotice}
          </Alert>
        ) : (
          <Button size="small" variant="text" onClick={() => setRiskOpen(true)} sx={{ alignSelf: 'flex-start', textTransform: 'none', color: 'text.secondary' }}>
            {t.exchange.open.showRiskNotice}
          </Button>
        )}

        {freeMgn === 0n && (
          <Alert severity="warning">
            {interpolate(t.exchange.markup.noFreeMarginBefore, { token: STABLE_LABEL })}<strong>{t.exchange.markup.noFreeMarginBold}</strong>{t.exchange.markup.noFreeMarginAfter}
          </Alert>
        )}

        {/* F-1 · 價格過期。放在 KYC / ESG 之前，因為它是最硬的擋單條件：
            不管有沒有 KYC、確不確認 ESG，鏈上都會 revert。 */}
        {openStaleNotice && (
          <Alert severity="error">
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
              {t.exchange.open.staleTitle}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block' }}>
              {openStaleNotice}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, fontFamily: MONO }}>
              {interpolate(t.exchange.open.staleIndexAge, {
                age: openFreshness?.label ?? t.exchange.open.ageUnknown,
              })}
            </Typography>
          </Alert>
        )}

        {kycStatusUnknown && kycRequired && (
          <Alert severity="warning">
            <Typography variant="caption">
              {t.exchange.open.kycUnknown}
            </Typography>
          </Alert>
        )}

        {/* KYCRegistry 改成審核制：送出 ≠ 通過。「審核中」和「還沒送」要說不同的話，
            否則使用者會一直重送同一份表單、以為自己哪裡填錯。 */}
        {kycBlocked && !kycStatusUnknown && kycPending && (
          <Alert severity="info">
            <Typography variant="caption">
              {t.exchange.markup.kycPendingBefore}<b>{t.exchange.markup.kycPendingBold}</b>{t.exchange.markup.kycPendingMid}<strong>{selectedAssetMeta?.symbol}</strong>{t.exchange.markup.kycPendingLine2After}
            </Typography>
          </Alert>
        )}

        {kycBlocked && !kycStatusUnknown && !kycPending && (
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" variant="outlined" onClick={() => setShowKYCModal(true)} sx={{ fontWeight: 'bold' }}>
                {t.exchange.open.kycSubmit}
              </Button>
            }
          >
            {t.exchange.markup.kycRequiredBefore}<strong>{selectedAssetMeta?.symbol}</strong>{t.exchange.markup.kycRequiredAfter}
          </Alert>
        )}

        {isLowEsg && (
          <Alert severity="error" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
              {interpolate(t.exchange.open.esgWarningTitle, {
                composite: selEsg!.composite,
                rating: selEsg!.rating,
              })}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              {t.exchange.open.esgWarningBody}
            </Typography>
            <FormControlLabel
              control={
                <Checkbox
                  checked={esgConfirmed}
                  onChange={e => setEsgConfirmed(e.target.checked)}
                  color="error"
                  size="small"
                />
              }
              label={
                <Typography variant="caption" sx={{ fontWeight: 'bold' }}>
                  {t.exchange.open.esgConfirm}
                </Typography>
              }
            />
          </Alert>
        )}

        <Grid container spacing={2}>
          {/* Asset Select */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <FormControl fullWidth>
              <InputLabel id="asset-select-label">{t.exchange.open.asset}</InputLabel>
              <Select
                labelId="asset-select-label"
                value={selAsset}
                onChange={e => setSelAsset(e.target.value as AssetId)}
                label={t.exchange.open.asset}
                renderValue={(selected) => {
                  const meta = ASSET_META[selected as string];
                  return (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <AssetIcon symbol={meta?.symbol ?? ''} size={24} />
                      <Typography variant="body1" sx={{ fontWeight: 'bold' }}>
                        {meta?.symbol}
                      </Typography>
                    </Box>
                  );
                }}
              >
                {ASSETS.map(a => (
                  <MenuItem key={a.id} value={a.id}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.5 }}>
                      <AssetIcon symbol={a.symbol} size={28} />
                      <Box>
                        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          {a.regulated ? '🔒 ' : ''}{a.symbol}
                          {a.category === 'etf' ? ' [ETF]' : ''}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {a.name}
                        </Typography>
                      </Box>
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {selEsg ? (
              <Box sx={{ mt: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <ESGBadge composite={selEsg.composite} rating={selEsg.rating} size="sm" />
                  <Typography variant="caption" sx={{ fontWeight: 'bold', color: selEsg.composite >= 65 ? 'success.main' : 'warning.main' }}>
                    {selEsg.composite >= 65
                      ? t.exchange.open.esgHighRating
                      : t.exchange.open.esgLowRating}
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', gap: 1.5 }}>
                  <Typography variant="caption" color="text.secondary">E: <Box component="span" sx={{ color: 'text.primary', fontFamily: MONO }}>{selEsg.environmental}</Box></Typography>
                  <Typography variant="caption" color="text.secondary">S: <Box component="span" sx={{ color: 'text.primary', fontFamily: MONO }}>{selEsg.social}</Box></Typography>
                  <Typography variant="caption" color="text.secondary">G: <Box component="span" sx={{ color: 'text.primary', fontFamily: MONO }}>{selEsg.governance}</Box></Typography>
                </Box>
              </Box>
            ) : esgUnavailable ? (
              // Base Sepolia 上 ESGRegistry = 0x0。舊版在這裡永遠顯示「載入中…」，
              // 因為它根本沒有能結束的載入——說清楚是這條鏈沒有這份資料。
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {t.exchange.open.esgUnavailable}
              </Typography>
            ) : contracts && !esgLoaded ? (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {t.exchange.open.esgLoading}
              </Typography>
            ) : contracts ? (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {t.exchange.open.esgNone}
              </Typography>
            ) : null}
          </Grid>

          {/* Direction */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <Stack spacing={1}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', fontWeight: 'bold' }}>
                {t.exchange.open.direction}
              </Typography>
              <Box sx={{ display: 'flex', border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden', height: 40 }}>
                <Button
                  fullWidth
                  variant={isLong ? 'contained' : 'text'}
                  color="success"
                  onClick={() => setIsLong(true)}
                  sx={{ borderRadius: 0, fontWeight: 'bold' }}
                >
                  {t.exchange.open.long}
                </Button>
                <Button
                  fullWidth
                  variant={!isLong ? 'contained' : 'text'}
                  color="error"
                  onClick={() => setIsLong(false)}
                  sx={{ borderRadius: 0, fontWeight: 'bold' }}
                >
                  {t.exchange.open.short}
                </Button>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5 }}>
                <Typography variant="caption" color="text.secondary">{t.exchange.open.orderType}</Typography>
                <Typography variant="caption" color="primary.main" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Icon icon="solar:dollar-bold" />{' '}
                  {interpolate(t.exchange.open.executionFee, { fee: execFee.eth })}
                  {!execFee.loaded && (
                    <Box component="span" sx={{ opacity: 0.6 }}>
                      {t.exchange.open.executionFeeDefault}
                    </Box>
                  )}
                </Typography>
              </Box>
            </Stack>
          </Grid>

          {/* Leverage —— 旗標關閉時整格不渲染 */}
          {SHOW_LEVERAGE && (
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <Stack spacing={1}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', fontWeight: 'bold' }}>
                {t.exchange.open.leverage}
              </Typography>
              <Box sx={{ display: 'flex', border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden', height: 40 }}>
                {[1, 2, 5].map(lv => (
                  <Button
                    key={lv}
                    fullWidth
                    disabled={lv > maxLev}
                    variant={leverage === lv ? 'contained' : 'text'}
                    color="warning"
                    onClick={() => setLeverage(lv)}
                    sx={{ borderRadius: 0, fontWeight: 'bold' }}
                  >
                    {lv}×
                  </Button>
                ))}
              </Box>
              {maxLev < 5 && (
                <Typography variant="caption" color="warning.main" sx={{ fontFamily: MONO }}>
                  {interpolate(t.exchange.open.maxLeverage, { max: maxLev })}
                </Typography>
              )}
            </Stack>
          </Grid>
          )}

          {/* Margin Input */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <TextField
              label={t.exchange.open.marginLabel}
              type="number"
              fullWidth
              placeholder={t.exchange.open.marginPlaceholder}
              value={openMgn}
              onChange={e => setOpenMgn(e.target.value)}
              slotProps={{
                input: {
                  endAdornment: <InputAdornment position="end">{STABLE_LABEL}</InputAdornment>,
                },
              }}
            />
          </Grid>
        </Grid>

        {/* Live quote values */}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, fontSize: '0.8125rem', color: 'text.secondary', pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {t.exchange.open.entryOracle}: <Box component="span" sx={{ color: 'text.primary', fontWeight: 'bold', fontFamily: MONO }}>{fUsd(curPrice)}</Box>
          </Typography>
          {livePrices[selAsset] && (
            <Typography variant="body2" color="text.secondary">
              {t.exchange.open.liveMarket}:{' '}
              <Box component="span" sx={{ fontWeight: 'bold', fontFamily: MONO, color: livePrices[selAsset].isMock ? 'warning.main' : 'success.main' }}>
                ${livePrices[selAsset].usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </Box>
              {livePrices[selAsset].isMock && <Box component="span" sx={{ opacity: 0.6, fontSize: '0.6875rem', ml: 0.5 }}>{t.exchange.open.simulated}</Box>}
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            {t.exchange.open.notional}: <Box component="span" sx={{ color: 'text.primary', fontWeight: 'bold', fontFamily: MONO }}>{f18(notional)} {STABLE_LABEL}</Box>
          </Typography>
          {(() => {
            const fi = fundingData[selAsset];
            if (!fi) return null;
            const rateNum = Number(fi.rate);
            const ratePct = (rateNum / 100).toFixed(4);
            return (
              <Typography variant="body2" sx={{ fontWeight: 'medium', color: rateNum > 0 ? 'error.main' : rateNum < 0 ? 'success.main' : 'text.secondary' }}>
                {t.exchange.open.fundingRate}:{' '}
                <Box component="span" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>{rateNum >= 0 ? '+' : ''}{ratePct}%</Box>
                {' '}
                {rateNum > 0
                  ? t.exchange.open.fundingLongsPay
                  : rateNum < 0
                    ? t.exchange.open.fundingShortsPay
                    : t.exchange.open.fundingBalanced}
              </Typography>
            );
          })()}
          {openMgn && (
            <Chip
              label={interpolate(t.exchange.open.estLiquidation, { price: fUsd(liqPrice) })}
              color="error"
              size="small"
              variant="outlined"
              // 清算不再是 100% 沒收：扣掉虧損、費用、清算獎勵與
              // liquidationPenaltyBps 之後的殘值會退還給倉位所有者。
              title={t.exchange.open.liquidationTooltip}
              sx={{ fontFamily: MONO, fontWeight: 'bold', bgcolor: 'rgba(255, 86, 48, 0.08)' }}
            />
          )}
        </Box>

        {/* Live Sparkline */}
        {history.length > 1 && (
          <Box sx={{ width: '100%', height: 100, mt: 1 }}>
            <ResponsiveContainer width="100%" height={100}>
              <LineChart data={history}>
                <YAxis domain={['dataMin', 'dataMax']} hide />
                <Line
                  type="monotone"
                  dataKey="price"
                  stroke="#22c55e"
                  strokeWidth={2.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </Box>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', opacity: 0.7 }}>
          {t.exchange.markup.oracleAdminBefore}{' '}
          <Link component={RouterLink} to="/admin/oracle" sx={{ color: 'primary.main', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>{t.exchange.markup.oracleAdminLink}</Link>{' '}
          {t.exchange.markup.oracleAdminAfter}
        </Typography>

        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 'medium' }}>
            {t.exchange.open.freeMargin}: <Box component="span" sx={{ color: 'text.primary', fontFamily: MONO, fontWeight: 'bold' }}>{f18(freeMgn)} {STABLE_LABEL}</Box>
            {openMgnBig !== null && openMgnBig > freeMgn && (
              <Box component="span" sx={{ color: 'error.main', fontWeight: 'bold', ml: 2 }}>
                {interpolate(t.exchange.open.insufficient, {
                  amount: f18(openMgnBig - freeMgn),
                  token: STABLE_LABEL,
                })}
              </Box>
            )}
          </Typography>

          <Button
            onClick={() => kycBlocked && !kycStatusUnknown && !kycPending ? setShowKYCModal(true) : void openPosition()}
            disabled={
              busy['open'] ||
              openStaleBlocked ||
              !openMgn ||
              (openMgnBig !== null && openMgnBig > freeMgn) ||
              (kycBlocked && !openMgn) ||
              // 審核中：既不能下單（合約會 revert），也沒有「再送一次申請」這個
              // 可行動的下一步——把 CTA 關掉，由上方的 Alert 說明狀態。
              (kycBlocked && kycPending) ||
              (isLowEsg && !esgConfirmed)
            }
            variant="contained"
            color={openStaleBlocked ? 'inherit' : kycBlocked ? 'warning' : isLowEsg && !esgConfirmed ? 'inherit' : isLong ? 'success' : 'error'}
            sx={{
              fontWeight: 'bold',
              px: 4,
              py: 1.2,
              borderRadius: 1,
            }}
          >
            {busy['open']
              ? t.exchange.open.submitting
              : openStaleBlocked
                ? t.exchange.open.ctaStale
                : kycBlocked
                  ? kycStatusUnknown
                    ? t.exchange.open.ctaKycUnknown
                    : kycPending
                      ? t.exchange.open.ctaKycPending
                      : interpolate(t.exchange.open.ctaKycRequired, {
                          asset: ASSET_LABEL[selAsset] ?? '',
                        })
                  : isLowEsg && !esgConfirmed
                    ? t.exchange.open.ctaEsgUnconfirmed
                    : interpolate(t.exchange.open.ctaOpen, {
                        side: isLong ? t.exchange.side.long : t.exchange.side.short,
                        asset: ASSET_LABEL[selAsset] ?? '',
                      })}
          </Button>
        </Box>
      </Card>
      )}

      {/* KYC Modal Dialog */}
      <KYCModal
        isOpen={showKYCModal}
        onClose={() => setShowKYCModal(false)}
        onSuccess={() => { void refetchKYC(); }}
        kycRegistry={contracts?.kycRegistry ?? null}
        isPending={kycPending}
      />

      {/* ESG Leaderboard */}
      {Object.keys(esg).length > 0 && (
        <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            {t.exchange.esgLeaderboard.title}
          </Typography>
          <Stack spacing={2}>
            {Object.entries(esg)
              .sort(([, a], [, b]) => b.composite - a.composite)
              .map(([id, info]) => {
                const label = ASSET_LABEL[id as AssetId] ?? id.slice(0, 8);
                const barColor =
                  info.composite >= 80 ? 'success.main' :
                  info.composite >= 60 ? 'info.main'    :
                  info.composite >= 40 ? 'warning.main'   :
                                         'error.main';
                return (
                  <Box key={id} sx={{ display: 'grid', gridTemplateColumns: '120px 1fr auto', gap: 3, alignItems: 'center' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <AssetIcon symbol={label} size={24} />
                      <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                        {label}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                      {[
                        { label: 'E', val: info.environmental },
                        { label: 'S', val: info.social        },
                        { label: 'G', val: info.governance    },
                      ].map(({ label: l, val }) => (
                        <Box key={l} sx={{ flexGrow: 1 }}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                            <Typography variant="caption" sx={{ fontSize: '0.625rem', color: 'text.secondary', fontWeight: 'bold' }}>{l}</Typography>
                            <Typography variant="caption" sx={{ fontSize: '0.625rem', color: 'text.secondary', fontFamily: MONO }}>{val}</Typography>
                          </Box>
                          <LinearProgress
                            variant="determinate"
                            value={val}
                            sx={{
                              height: 6,
                              borderRadius: 3,
                              bgcolor: 'background.neutral',
                              '& .MuiLinearProgress-bar': {
                                bgcolor: barColor,
                                borderRadius: 3,
                              },
                            }}
                          />
                        </Box>
                      ))}
                    </Box>
                    <ESGBadge composite={info.composite} rating={info.rating} size="sm" />
                  </Box>
                );
              })}
          </Stack>
        </Card>
      )}

      {/* D. Open Positions */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            {t.exchange.positions.title}
          </Typography>
          <Button
            size="small"
            variant="text"
            color="inherit"
            onClick={() => void fetchAll()}
            startIcon={<Icon icon="solar:restart-bold-duotone" />}
            sx={{ textTransform: 'none', color: 'text.secondary' }}
          >
            {t.exchange.positions.refresh}
          </Button>
        </Box>

        {positions.length === 0 ? (
          <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 4, fontStyle: 'italic' }}>
            {t.exchange.positions.empty}
          </Typography>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {[
                    t.exchange.positions.column.asset,
                    t.exchange.positions.column.side,
                    t.exchange.positions.column.entry,
                    t.exchange.positions.column.current,
                    t.exchange.positions.column.size,
                    t.exchange.positions.column.margin,
                    // 槓桿欄跟著旗標走——1× 固定值的欄位只是噪音，但表頭與
                    // 表格列必須同一個條件，否則欄數會對不上。
                    ...(SHOW_LEVERAGE ? [t.exchange.positions.column.leverage] : []),
                    t.exchange.positions.column.pnl,
                    '',
                  ].map(h => (
                    <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold', fontSize: '0.75rem', py: 1.5 }}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {livePositions.map(row => {
                  const size     = row.entryPrice > 0n
                    ? (row.margin * row.leverage * 10n ** 18n) / row.entryPrice
                    : 0n;
                  const closeKey = `close_${row.id}`;
                  // M1：平倉也讀 oracle，過期一樣 revert。逐列判斷，因為每列可能是不同標的。
                  const rowStale = staleNoticeForAsset(row.asset);
                  return (
                    <TableRow key={String(row.id)} sx={{ '&:hover': { bgcolor: 'action.hover' } }}>
                      <TableCell sx={{ py: 1 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <AssetIcon symbol={ASSET_LABEL[row.asset as AssetId] ?? ''} size={24} />
                          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', fontFamily: MONO }}>
                            {ASSET_LABEL[row.asset as AssetId] ?? row.asset.slice(0, 8)}
                          </Typography>
                        </Box>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={row.isLong ? t.exchange.positions.long : t.exchange.positions.short}
                          size="small"
                          sx={{
                            fontWeight: 'bold',
                            fontSize: '0.75rem',
                            bgcolor: row.isLong ? 'rgba(34,197,94,0.12)' : 'rgba(255,86,48,0.12)',
                            color: row.isLong ? 'success.main' : 'error.main',
                            borderColor: row.isLong ? 'rgba(34,197,94,0.2)' : 'rgba(255,86,48,0.2)',
                            border: '1px solid',
                          }}
                        />
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO }}>{fUsd(row.entryPrice)}</TableCell>
                      <TableCell sx={{ fontFamily: MONO }}>{fUsd(row.currentLivePrice)}</TableCell>
                      <TableCell sx={{ fontFamily: MONO, color: 'text.secondary' }}>{f18(size, 6)}</TableCell>
                      <TableCell sx={{ fontFamily: MONO }}>{f18(row.margin)}</TableCell>
                      {SHOW_LEVERAGE && <TableCell>{String(row.leverage)}×</TableCell>}
                      <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', color: pnlColor(row.livePnL) }}>
                        {fPnL(row.livePnL)}
                      </TableCell>
                      <TableCell>
                        <Stack spacing={1} alignItems="flex-start">
                          <Button
                            size="small"
                            variant="outlined"
                            color="inherit"
                            onClick={() => void closePos(row.id, row.asset)}
                            disabled={busy[closeKey] || !!rowStale}
                            title={rowStale ?? undefined}
                            sx={{
                              borderColor: 'divider',
                              fontSize: '0.75rem',
                              fontWeight: 'bold',
                              '&:hover': {
                                bgcolor: 'rgba(255,86,48,0.08)',
                                color: 'error.main',
                                borderColor: 'error.light',
                              },
                            }}
                          >
                            {busy[closeKey]
                              ? t.exchange.working
                              : rowStale
                                ? t.exchange.positions.stale
                                : t.exchange.positions.close}
                          </Button>
                          {rowStale && (
                            <Typography variant="caption" color="error.main" sx={{ fontSize: '0.625rem', maxWidth: 220, display: 'block' }}>
                              {interpolate(t.exchange.positions.staleNote, {
                                age:
                                  livePrices[row.asset as AssetId]?.freshness.label ??
                                  t.exchange.positions.staleAgeUnknown,
                              })}
                            </Typography>
                          )}

                          {hasEsgRewardDistributor && (esg[row.asset]?.composite ?? 0) >= 70 && (() => {
                            const isRewarded = esgRewardedMap[String(row.id)];
                            const claimKey   = `claim_${row.id}`;
                            if (isRewarded === true) {
                              return (
                                <Chip
                                  label={t.exchange.positions.esgRewarded}
                                  size="small"
                                  color="success"
                                  variant="outlined"
                                  sx={{ fontSize: '0.625rem', fontWeight: 'bold' }}
                                />
                              );
                            }
                            if (isRewarded === false) {
                              const preview = esgPreviewMap[String(row.id)] ?? 0n;
                              // previewReward 回 0 = 還不符合資格。最常見的原因是
                              // 最短持有期沒到（合約會 revert HoldTooShort），所以
                              // 這裡把「還差多久」算出來，而不是給一顆按了就失敗
                              // 的「0.0 PEPE」按鈕。
                              if (preview === 0n) {
                                const heldFor  = BigInt(Math.floor(Date.now() / 1000)) - row.openedAt;
                                const remain   = esgMinHold > 0n && row.openedAt > 0n ? esgMinHold - heldFor : 0n;
                                const remainDays = remain > 0n ? Math.ceil(Number(remain) / 86_400) : 0;
                                return (
                                  <Chip
                                    size="small"
                                    variant="outlined"
                                    color="default"
                                    label={
                                      remainDays > 0
                                        ? interpolate(t.exchange.positions.esgHoldLonger, {
                                            days: remainDays,
                                          })
                                        : t.exchange.positions.esgIneligible
                                    }
                                    title={
                                      remainDays > 0
                                        ? interpolate(t.exchange.positions.esgHoldLongerTooltip, {
                                            days: Math.round(Number(esgMinHold) / 86_400),
                                          })
                                        : t.exchange.positions.esgIneligibleTooltip
                                    }
                                    sx={{ fontSize: '0.625rem', fontWeight: 'bold' }}
                                  />
                                );
                              }
                              return (
                                <Button
                                  size="small"
                                  variant="contained"
                                  color="success"
                                  onClick={() => void claimEsgReward(row.id)}
                                  disabled={busy[claimKey]}
                                  startIcon={<span>🌱</span>}
                                  sx={{
                                    fontSize: '0.625rem',
                                    fontWeight: 'bold',
                                    py: 0.25,
                                    px: 1,
                                    borderRadius: 0.5,
                                    bgcolor: 'success.dark',
                                    '&:hover': { bgcolor: 'success.main' },
                                  }}
                                >
                                  {busy[claimKey] ? t.exchange.working : `${f18(preview)} PEPE`}
                                </Button>
                              );
                            }
                            return null;
                          })()}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>
    </Container>
  );
}

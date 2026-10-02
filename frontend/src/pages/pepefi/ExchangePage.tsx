import { MONO } from 'src/components/pepefi/brandKit'
import { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { Contract, type Provider } from 'ethers';
import { useContracts } from 'src/hooks/useContracts';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { t, interpolate } from 'src/locales';
import { prettyError } from 'src/lib/pepefi/errorMessages';
import { safeRead } from 'src/lib/pepefi/safeRead';
import { FEATURE_PEPE_REWARDS } from 'src/lib/pepefi/featureFlags';
import { SyntheticDisclosure } from 'src/components/pepefi/SyntheticDisclosure';
import { STABLE_LABEL, ALT_STABLE_LABEL, X402_STABLE_LABEL } from 'src/lib/pepefi/tokenLabel';
import {
  isOracleStale,
  HIGH_IMPACT_BPS,
  SEVERE_IMPACT_BPS,
  minOutWithSlippage,
  DEFAULT_SLIPPAGE_BPS,
} from 'src/lib/pepefi/ammQuote';
import {
  type Cell,
  type PoolReads,
  type QuoteSlot,
  parseAmountIn,
  mergePoolReads,
  resolveLiveQuote,
  sameCapabilities,
  buildSwapCardView,
  UNKNOWN_CAPABILITIES,
  type AmmCapabilities,
} from 'src/lib/pepefi/ammPoolView';
import {
  ammCacheKey,
  executeSwap,
  type AmmReader,
  loadAmmSnapshot,
  type SwapGateway,
  readQuoteSnapshot,
  type QuoteSnapshot,
  scheduleAmmRefresh,
} from 'src/lib/pepefi/ammSwapFlow';
import { useESG } from 'src/hooks/useESG';
import ESGBadge from 'src/components/pepefi/ESGBadge';
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta';
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
import Alert from '@mui/material/Alert';
import LinearProgress from '@mui/material/LinearProgress';
import Backdrop from '@mui/material/Backdrop';
import CircularProgress from '@mui/material/CircularProgress';
import { Icon } from '@iconify/react';

// ── Config ────────────────────────────────────────────────────────────────────
type AssetId = `0x${string}`;


// ── Types ─────────────────────────────────────────────────────────────────────
interface ESGAssetInfo {
  composite: number;
  rating: string;
  environmental: number;
  social: number;
  governance: number;
}

// ── Formatting ────────────────────────────────────────────────────────────────
const f18    = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d);

type TxResp = { wait(): Promise<unknown>; hash: string };
const asTx = (tx: unknown): TxResp => tx as TxResp;

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const EMPTY_POOL_READS: PoolReads = { getPrice: null, reserves: null, oraclePrice: null };

/**
 * 兌換卡的池子讀數與報價每隔這麼久重讀一次。oracle 每幾分鐘更新一次；頁面若只在載入時
 * 讀一次，放著不動 20 分鐘後畫面上的兌換價與衝擊基準都是舊的（#215 審查 M1）。
 */
const AMM_REFRESH_MS = 15_000;

/**
 * 報價寫進 state 超過這麼久還沒被新的取代，就視為 pending、不拿來送出（PR #223 L3）。
 * 前景時每 AMM_REFRESH_MS 換一次，留一輪的餘裕避免 RPC 稍慢時閃爍；分頁回前景另外由
 * onResume 直接標成 pending。
 */
const QUOTE_MAX_AGE_MS = 2 * AMM_REFRESH_MS;

const ORACLE_PRICE_ABI = ['function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)'];

/**
 * 把 ethers 的 PepeAMM Contract 接成 ammSwapFlow 要的讀取介面。這裡不做逾時與錯誤處理
 * （那是 ammSwapFlow 的事），每個方法失敗就 reject。
 */
function makeAmmReader(amm: Contract, provider: Provider): AmmReader {
  // AMM 自己指向的 oracle 與資產代號：只讀一次；讀失敗就清掉，下次重試。
  let oracleRef: Promise<{ oracle: Contract; assetId: string }> | null = null;
  return {
    getCode: () => provider.getCode(String(amm.target)),
    getPrice: () => amm.getPrice() as Promise<bigint>,
    getReserves: async () => {
      const r = (await amm.getReserves()) as [bigint, bigint];
      return [r[0], r[1]] as const;
    },
    oraclePrice: async () => {
      const r = (await amm.oraclePrice()) as unknown as [bigint, bigint];
      return [r[0], r[1]] as const;
    },
    maxOracleAge: () => amm.maxOracleAge() as Promise<bigint>,
    oracleEthPrice8: async () => {
      oracleRef ??= (async () => {
        const [addr, assetId] = await Promise.all([amm.oracle() as Promise<string>, amm.ETH_ASSET_ID() as Promise<string>]);
        return { oracle: new Contract(addr, ORACLE_PRICE_ABI, provider), assetId };
      })();
      try {
        const { oracle, assetId } = await oracleRef;
        const r = (await oracle.getPrice(assetId)) as [bigint, bigint];
        return r[0];
      } catch (e) {
        oracleRef = null;
        throw e;
      }
    },
    quote: (isEthIn, amountIn) =>
      (isEthIn ? amm.quoteETHForUSDC(amountIn) : amm.quoteUSDCForETH(amountIn)) as Promise<bigint>,
  };
}

// safeRead now lives in src/lib/pepefi/safeRead.ts so every page shares one
// implementation — this file was the only place that had the guard.

export default function ExchangePage() {
  const wallet = usePepefiWallet();
  const contracts    = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const { data: esgData } = useESG(contracts?.esgRegistry ?? null);

  const esg = (esgData ?? {}) as unknown as Record<string, ESGAssetInfo>;

  const [usdcBal,   setUsdcBal]   = useState(0n);
  const [usdtBal,   setUsdtBal]   = useState(0n);
  const [ethBal,    setEthBal]    = useState('0.0000');
  /** 未經四捨五入的 ETH 餘額。ethBal 是給畫面看的 4 位小數字串,拿去比大小會失準。 */
  const [ethBalRaw, setEthBalRaw] = useState(0n);
  const [pageLoading, setPageLoading] = useState(true);

  const [pepeBal,   setPepeBal]   = useState(0n);

  // AMM swap (PepeAMM — deployed + funded on Base Sepolia)
  //
  // #165：`getPrice()` 的意義取決於線上是哪一版 PepeAMM——原始碼最新版（恆定乘積）
  // 是儲備比例，但 Base Sepolia 上跑的是更早的 oracle 定價版，getPrice() 是 oracle
  // 報價、而且沒有 oraclePrice()。所以先從 bytecode 探測版本（ammCaps），再由
  // ammPoolView 決定每一格顯示什麼；讀失敗一律存 null，不存 0。
  const [swapMode,  setSwapMode]  = useState<'eth-to-usdc' | 'usdc-to-eth'>('eth-to-usdc');
  const [payAmount, setPayAmount] = useState('');
  const [ammCaps,   setAmmCaps]   = useState<AmmCapabilities>(UNKNOWN_CAPABILITIES);
  /** 版本探測還沒回來。true 時畫面說「正在確認」，而不是「無法確認」（#215 L2）。 */
  const [ammProbing, setAmmProbing] = useState(true);
  const [ammReads,  setAmmReads]  = useState<PoolReads>(EMPTY_POOL_READS);
  /** oraclePrice() 的 updatedAt；只有新版合約有，舊版維持 0（＝不擋單，舊版也不檢查）。 */
  const [ammOracleUpdatedAt, setAmmOracleUpdatedAt] = useState(0n);
  const [ammMaxAge, setAmmMaxAge] = useState(0n);   // maxOracleAge()，預設 1h
  /**
   * 目前顯示的報價，連同**與它同一次讀到**的衝擊基準、儲備與衝擊（#215 M1）。
   * 「你將收到」、價格衝擊、最低收到數量都從這一筆算出來，不會各自停在不同時間點。
   * 連同它是替哪個方向＋金額問的一起存（#220）：金額改了、新報價回來之前不採用。
   */
  const [quote, setQuote] = useState<QuoteSlot<QuoteSnapshot> | null>(null);
  /** 定時器每次加一，讓報價重讀。 */
  const [refreshTick, setRefreshTick] = useState(0);

  const [busy,         setBusy]        = useState<Record<string, boolean>>({});
  /** 兌換進行中（同步可讀；busy state 要等下一次 render 才反映到按鈕）。 */
  const swapInFlight = useRef(false);


  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }));
  const { notify } = useToast();

  // ── PepeAMM 讀取 ──────────────────────────────────────────────────────────
  const ammTarget = contracts ? String(contracts.pepeAMM.target) : ZERO_ADDR;
  const ammReader = useMemo(
    () => (contracts && wallet.provider && ammTarget !== ZERO_ADDR
      ? makeAmmReader(contracts.pepeAMM, wallet.provider)
      : null),
    [contracts, wallet.provider, ammTarget],
  );
  /** 版本判斷的快取鍵：chainId＋位址。bytecode 不會變，成功判斷過就不再讀（#215 L1）。 */
  const ammKey = ammCacheKey(wallet.chainId, ammTarget);
  const ammLoadedFor = useRef<string | null>(null);
  const ammLoadSeq = useRef(0);

  const refreshAmm = useCallback(async () => {
    ammLoadSeq.current += 1;
    const seq = ammLoadSeq.current;
    const loadingFor = `${wallet.chainId}:${ammTarget}`;
    if (ammLoadedFor.current !== loadingFor) {
      // 換鏈／換合約：上一個合約的版本與讀數不能留在畫面上。
      ammLoadedFor.current = loadingFor;
      setAmmProbing(true);
      setAmmCaps(UNKNOWN_CAPABILITIES);
      setAmmReads(EMPTY_POOL_READS);
      setAmmOracleUpdatedAt(0n);
      setAmmMaxAge(0n);
    }
    if (!ammReader) {
      setAmmProbing(false);
      return;
    }
    // 版本探測（getCode）與池子讀數並行；每個讀取各自隔離（8 秒逾時），不會 reject。
    const snap = await loadAmmSnapshot(ammReader, ammKey);
    if (seq !== ammLoadSeq.current) return;   // 有更新的一輪在跑，這一輪的結果作廢
    setAmmCaps(prev => (sameCapabilities(prev, snap.caps) ? prev : snap.caps));
    setAmmReads(snap.reads);
    setAmmOracleUpdatedAt(snap.oracleUpdatedAt);
    setAmmMaxAge(snap.maxOracleAge);
    setAmmProbing(false);
  }, [ammReader, ammKey, ammTarget, wallet.chainId]);

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
      // 兌換池（含版本探測）和餘額並行讀，不排在餘額後面等（#215 L2）。
      // PepeAMM 未部署（0x0）時 refreshAmm 不會發出任何呼叫。
      const ammLoad = refreshAmm();

      const [bal, eBal] = await Promise.all([
        safeRead(contracts.usdc.balanceOf(addr) as Promise<bigint>, 0n),
        safeRead(provider.getBalance(addr), 0n),
      ]);
      setUsdcBal(bal);
      setEthBal(f18(eBal, 4));
      setEthBalRaw(eBal);

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

      // AMM 版本／儲備／價格 —— 上面已經並行開讀，這裡只是等它回來。每個讀取各自
      // 隔離，慢或失敗的呼叫不會卡住頁面。
      await ammLoad;

      // 骨架撤掉的時機：餘額、水龍頭、兌換面板都備妥即可。#148 之後這一頁
      // 不再讀部位，所以沒有任何「晚點才串進來」的區塊。
      setPageLoading(false);
    } finally {
      setPageLoading(false);
    }
  }, [contracts, wallet.address, wallet.provider, refreshAmm]);

  useEffect(() => { void fetchAll() }, [fetchAll]);

  // 防呆保險：掛載後最多 10 秒一定關掉骨架，避免任何未來路徑再卡死。
  useEffect(() => {
    const t = setTimeout(() => setPageLoading(false), 10000);
    return () => clearTimeout(t);
  }, []);

  // 定時重讀池子與報價（#215 M1）：頁面放著不動時，兌換價、儲備、報價與衝擊一起更新，
  // 不會出現「報價是即時的、基準卻是 20 分鐘前的」。分頁在背景時不讀；回到前景時立刻
  // 重讀一次，不等下一次定時器（#220）；回前景時先把報價標成 pending，背景前的報價在新報價
  // 回來前不能按（PR #223 L3）。回前景的重讀有節流。
  useEffect(() => {
    if (!ammReader) return undefined;
    return scheduleAmmRefresh(
      () => {
        void refreshAmm();
        setRefreshTick(n => n + 1);
      },
      AMM_REFRESH_MS,
      typeof document !== 'undefined' ? document : null,
      { onResume: () => setQuote(null) },
    );
  }, [ammReader, refreshAmm]);

  // ── Live AMM quote ──────────────────────────────────────────────────────────
  // 新版合約的 quote 是 x*y=k 的實際輸出，除了金額之外還要把價格衝擊算出來給使用者看，
  // 否則大額兌換會在毫無預警下吃掉好幾個百分點。
  //
  // #215 M1：衝擊的基準（舊版讀 getPrice()、恆定乘積版讀 getReserves()）在 readQuoteSnapshot
  // 裡和 quote **同一次**讀取，不用頁面載入時存下來的 ammReads。結果存進 quote 這個
  // 獨立的 state——這個 effect 不寫 ammReads，也不依賴它，否則會無限重跑。
  const isEthIn = swapMode === 'eth-to-usdc';
  /** 輸入框的金額（18 位小數）；沒有有效金額 → null。bigint 是原始值，可直接當 effect 依賴。 */
  const amountIn = parseAmountIn(payAmount);
  useEffect(() => {
    if (!ammReader || amountIn === null) {
      setQuote(null);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const snap = await readQuoteSnapshot(ammReader, ammCaps, isEthIn, amountIn);
        if (!cancelled) setQuote({ isEthIn, amountIn, quote: snap, fetchedAt: Date.now() });
      } catch {
        // quote 也會 revert（InsufficientLiquidity / InsufficientInput）——那代表
        // 這筆金額根本換不成，顯示空白比顯示一個假數字誠實。記下「這組金額失敗」，
        // 和「還在等報價」分開（按鈕文字不同）。
        if (!cancelled) setQuote({ isEthIn, amountIn, quote: null, fetchedAt: Date.now() });
      }
    })();
    return () => { cancelled = true; };
  }, [ammReader, amountIn, isEthIn, ammCaps, refreshTick]);

  // ── Transactions ────────────────────────────────────────────────────────────
  const ammDeployed = !!contracts && String(contracts.pepeAMM.target) !== ZERO_ADDR;
  /**
   * 只認「目前方向、**目前金額**」的那筆報價（#220）。金額從 30 改成 60、60 的報價回來
   * 之前是 pending：不顯示 30 的收到數量／衝擊／最低收到，按鈕停用。放太久沒換新的報價
   * 也當 pending（PR #223 L3）。
   */
  const live = resolveLiveQuote(quote, isEthIn, amountIn, { now: Date.now(), maxAgeMs: QUOTE_MAX_AGE_MS });
  const liveQuote = live.status === 'ready' ? live.quote : null;

  // swap 會在 oracle 過期（> maxOracleAge，預設 1h）時 revert StaleOraclePrice。
  // 和開倉的 stale 擋單同樣的道理：能在按下去之前就知道的事，不要讓使用者付 gas 才知道。
  const ammOracleStale = isOracleStale(liveQuote?.oracleUpdatedAt ?? ammOracleUpdatedAt, ammMaxAge, Date.now() / 1000);

  // 兌換卡的畫面模型（#165、#215）：每一格顯示什麼、按鈕能不能按，都由 ammPoolView 決定。
  // 有報價時，池子資訊用**和報價同一次讀到**的值，畫面上的兌換價就是衝擊的基準。
  const card = buildSwapCardView({
    probing: ammProbing,
    caps: ammCaps,
    reads: liveQuote ? mergePoolReads(ammReads, liveQuote.reads) : ammReads,
    isEthIn,
    live,
    oracleStale: ammOracleStale,
    busy: !!busy['swap'],
  });
  const poolView = card.pool;
  const cellText = (c: Cell['kind']) => (c === 'loading' ? t.exchange.swap.loadingValue : t.exchange.swap.unavailable);
  const priceText = (c: Cell) => (c.kind === 'value' ? `1 ETH = ${c.text} ${STABLE_LABEL}` : cellText(c.kind));
  const poolNote = card.notes.map(k => t.exchange.swap[k]).join(' ');
  const outToken = isEthIn ? STABLE_LABEL : 'ETH';
  const outDecimals = isEthIn ? 2 : 6;
  const inventoryMessage = (needed: bigint, available: bigint) =>
    interpolate(t.exchange.swap.exceedsInventoryDetail, {
      needed: f18(needed, outDecimals),
      available: f18(available, outDecimals),
      token: outToken,
    });
  const AMM_STALE_MSG = t.exchange.tx.ammStale;

  // ETH ↔ USDC swap via PepeAMM (constant product). minOut 以**畫面上顯示的那筆 quote**
  // 為基準打 DEFAULT_SLIPPAGE_BPS（＝畫面上的「最低收到數量」），而不是 oracle 價——池子
  // 有滑點，拿 oracle 價打 0.5% 當底線會讓任何稍大的單子必定 revert InsufficientOutput。
  // 這 0.5% 只負責吸收「確認 → 上鏈」之間價格的那一點差；差更多就停下來讓使用者重新確認
  // （#220：不再於 approve 之後換成新 quote 的 minOut）。
  //
  // #215 M2：送出任何交易（含 approve）之前，executeSwap 會先確認庫存、餘額、再以 eth_call
  // 模擬 swap；必定失敗就一筆都不送。實際送出的 minOut 是 max(畫面最低收到, 即時報價 × 0.995)
  // （PR #223 M1/M2）。
  //
  // 連按：按鈕在 busy 時停用；busy 是 state，這裡再以 ref 擋同一輪 render 內的第二次點擊。
  const doSwap = async () => {
    if (swapInFlight.current) return;
    if (!contracts || !wallet.address || !ammDeployed || !ammReader) return;
    if (amountIn === null) { notify(t.exchange.tx.enterValidAmount, false); return; }
    // 畫面上沒有這組金額的報價（還在讀、換不成、或放太久）就不送——minOut 的底線由它算出
    // （#220）。按下這一刻再判一次新鮮度（render 之後可能已經過了一段時間）。
    const atPress = resolveLiveQuote(quote, isEthIn, amountIn, { now: Date.now(), maxAgeMs: QUOTE_MAX_AGE_MS });
    if (atPress.status !== 'ready' || atPress.quote.out <= 0n) {
      if (atPress.status === 'pending') setRefreshTick(n => n + 1);
      return;
    }
    const displayed = atPress.quote;
    // 事前擋掉必定 revert 的兩種情況，不讓使用者白付 gas。
    if (ammOracleStale) { notify(AMM_STALE_MSG, false); return; }
    // 餘額不足是第三種必定失敗的情況,而且最常見。這裡用頁面上次讀到的餘額先擋一次;
    // executeSwap 在 approve 之前還會再讀一次即時的 balanceOf（#220）。
    const payRaw = amountIn;
    const balRaw = swapMode === 'eth-to-usdc' ? ethBalRaw : usdcBal;
    if (payRaw > balRaw) {
      notify(interpolate(t.exchange.tx.insufficientBalance, {
        token:   swapMode === 'eth-to-usdc' ? 'ETH' : STABLE_LABEL,
        balance: f18(balRaw, swapMode === 'eth-to-usdc' ? 4 : 2),
      }), false);
      return;
    }
    const amm = String(contracts.pepeAMM.target);
    const owner = wallet.address;
    const pool = contracts.pepeAMM;
    const gateway: SwapGateway = {
      quote: ammReader.quote,
      getReserves: ammReader.getReserves,
      allowance: () => contracts.usdc.allowance(owner, amm) as Promise<bigint>,
      balance: () => contracts.usdc.balanceOf(owner) as Promise<bigint>,
      // eth_call（from = 使用者的 signer），不送交易。
      simulateSwap: (ethIn, amountIn, minOut) =>
        ethIn
          ? pool.swapETHForUSDC.staticCall(minOut, { value: amountIn })
          : pool.swapUSDCForETH.staticCall(amountIn, minOut),
      approve: async (amount) => asTx(await contracts.usdc.approve(amm, amount)),
      swap: async (ethIn, amountIn, minOut) =>
        asTx(ethIn
          ? await pool.swapETHForUSDC(minOut, { value: amountIn })
          : await pool.swapUSDCForETH(amountIn, minOut)),
    };

    swapInFlight.current = true;
    setLoad('swap', true);
    try {
      const result = await executeSwap(gateway, ammCaps, displayed, {
        onApproving: () => notify(interpolate(t.exchange.tx.approving, { token: STABLE_LABEL }), true),
      });
      if (!result.ok) {
        if (result.stage === 'busy') {
          // 上一筆還在跑（重入保護）：什麼都沒做，不必提示。
        } else if (result.stage === 'inventory') {
          notify(inventoryMessage(result.needed, result.available), false);
        } else if (result.stage === 'zeroMinOut') {
          notify(t.exchange.tx.zeroMinOut, false);
        } else if (result.stage === 'balance') {
          setUsdcBal(result.available);
          notify(interpolate(t.exchange.tx.insufficientBalance, {
            token:   STABLE_LABEL,
            balance: f18(result.available, 2),
          }), false);
        } else if (result.stage === 'priceMoved') {
          // 價格變差、swap 沒送：立刻重讀，讓畫面換成新報價，使用者看過再按一次。
          notify(
            interpolate(
              result.approved ? t.exchange.tx.priceMovedAfterApprove : t.exchange.tx.priceMoved,
              {
                quoted: f18(result.quoted, outDecimals),
                minOut: f18(result.minOut, outDecimals),
                token: outToken,
              },
            ),
            false,
          );
          // 舊報價立刻作廢（pending）：新報價回來之前按鈕停用，不能拿同一筆舊報價重按
          // （PR #223 L2）。fetchAll 連同池子一起重讀；approve 已付的 gas 也反映到餘額上。
          setQuote(null);
          void fetchAll();
          setRefreshTick(n => n + 1);
        } else {
          notify(
            interpolate(
              result.approved ? t.exchange.tx.preflightBlockedAfterApprove : t.exchange.tx.preflightBlocked,
              { reason: prettyError(result.error) },
            ),
            false,
          );
        }
        return;
      }
      notify(
        isEthIn
          ? interpolate(t.exchange.tx.swappedEthForToken, {
              amount: payAmount,
              received: f18(result.quoted, 2),
              token: STABLE_LABEL,
            })
          : interpolate(t.exchange.tx.swappedTokenForEth, {
              amount: payAmount,
              token: STABLE_LABEL,
              received: f18(result.quoted, 6),
            }),
        true,
        result.hash
      );
      setPayAmount('');
      await new Promise(r => setTimeout(r, 1500));
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { swapInFlight.current = false; setLoad('swap', false); }
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

  // ── Derived ───────────────────────────────────────────────────────────────

  const activeTask = Object.entries(busy).find(([_, v]) => v)?.[0];
  const isBusy = !!activeTask;
  let loadingMsg = t.exchange.loading.fallback;
  if (activeTask) {
    if (activeTask === 'swap') loadingMsg = interpolate(swapMode === 'eth-to-usdc' ? t.exchange.loading.swapEthToToken : t.exchange.loading.swapTokenToEth, { token: STABLE_LABEL });
    else if (activeTask === 'faucet') loadingMsg = interpolate(t.exchange.loading.faucetStable, { token: STABLE_LABEL });
    else if (activeTask === 'pepe') loadingMsg = t.exchange.loading.faucetPepe;
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
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <SyntheticDisclosure />

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

      {/* Onboarding guide.
          #148 之後這一頁不論 SHOW_PERPETUALS 開關都沒有開倉面板(開倉在 /terminal),
          所以只剩現貨這一條路線:領幣 → 到資產頁買 → 回投資組合看配置,
          中間沒有「保證金帳戶」也沒有「開倉」。 */}
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
          {t.exchange.guide.spotTitle}
        </Typography>
        <Typography variant="body2" component="ol" sx={{ pl: 2, m: 0, '& li': { mb: 0.5 } }}>
          <li><strong>{t.exchange.markup.stepGetTokensLabel}</strong> {interpolate(t.exchange.markup.stepGetTokensBody, { token: STABLE_LABEL })}</li>
          <li><strong>{t.exchange.markup.stepBuyLabel}</strong> {interpolate(t.exchange.markup.stepBuyBody, { token: STABLE_LABEL })}</li>
          <li><strong>{t.exchange.markup.stepPortfolioLabel}</strong> {t.exchange.markup.stepPortfolioBody}</li>
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
                {interpolate(FEATURE_PEPE_REWARDS ? t.exchange.faucet.intro : t.exchange.faucet.introNoPepe, {
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

            {/* PEPE — platform token。跟著 FEATURE_PEPE_REWARDS 走（商業版預設關）。 */}
            {FEATURE_PEPE_REWARDS && (<>
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
            </>)}

            <Typography variant="caption" color="text.secondary">
              {t.exchange.markup.ethBalanceBefore}<Box component="span" sx={{ fontFamily: MONO, color: 'text.primary' }}>{ethBal}</Box>{t.exchange.markup.ethBalanceAfterSpot}
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

      {/* Swap (ETH ↔ USDC via PepeAMM) —— #148 之後這一頁只剩水龍頭與兌換。
          開倉走 /terminal（ticket/OrderTicket）；平倉在 /terminal 的 PositionsTable 或
          /portfolio 的部位頁籤（SHOW_PERPETUALS 關閉時後者是唯一入口），
          保證金存入同樣在那裡（ticket/AccountPanel），提領在 /portfolio 的部位頁。
          這一頁不再是「交易」入口，而是「拿到測試幣、換成 USDC」那一段。 */}
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
          {/* 徽章跟著線上合約版本走（#165）：原始碼最新版是恆定乘積、有滑點；
              Base Sepolia 上的舊版是 oracle 定價、無滑點。版本不明就不掛徽章。 */}
          {card.badge && (
            <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 'bold' }}>
              {t.exchange.swap[card.badge]}
            </Typography>
          )}
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
                onClick={() => { setSwapMode(m => m === 'eth-to-usdc' ? 'usdc-to-eth' : 'eth-to-usdc'); setPayAmount(''); setQuote(null); }}
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
                  {/* 換不成的金額（讀不到報價、或超過池內庫存）顯示 0，不顯示一個換不到的數字。
                      金額剛改、新報價還沒回來 → 顯示讀取中，不顯示上一個金額的數字（#220）。 */}
                  {card.quotePending
                    ? t.exchange.swap.loadingValue
                    : card.receive !== null ? f18(card.receive, outDecimals) : '0'}
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

            {/* Pool info（#165）。每一格由 ammPoolView 依合約版本決定：
                value → 數字；unavailable → 「無法取得」；unsupported → 整列不顯示，
                改由下方說明交代為什麼沒有。不顯示任何意義不明的數字。 */}
            <Box sx={{ px: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              {poolView.poolPrice.kind !== 'unsupported' && (
                <Typography variant="caption" color="text.secondary">
                  {t.exchange.swap.poolPrice}: <Box component="span" sx={{ color: 'white', fontFamily: MONO, fontWeight: 'bold' }}>{priceText(poolView.poolPrice)}</Box>
                </Typography>
              )}
              {poolView.oracleRate.kind !== 'unsupported' && (
                <Typography variant="caption" color="text.secondary">
                  {t.exchange.swap.oracleRate}: <Box component="span" sx={{ color: 'white', fontFamily: MONO, fontWeight: 'bold' }}>{priceText(poolView.oracleRate)}</Box>
                </Typography>
              )}
              {poolView.oracleRef.kind !== 'unsupported' && (
                <Typography variant="caption" color="text.secondary">
                  {t.exchange.swap.oracleRef}: <Box component="span" sx={{ color: 'white', fontFamily: MONO }}>{priceText(poolView.oracleRef)}</Box>
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary">
                {t.exchange.swap[card.reservesLabel]}:{' '}
                {poolView.reserves.kind === 'value' ? (
                  <>
                    <Box component="span" sx={{ color: 'white', fontFamily: MONO }}>{poolView.reserves.eth} ETH</Box>
                    {' / '}
                    <Box component="span" sx={{ color: 'white', fontFamily: MONO }}>{poolView.reserves.usdc} {STABLE_LABEL}</Box>
                  </>
                ) : (
                  <Box component="span" sx={{ color: 'white', fontFamily: MONO }}>{cellText(poolView.reserves.kind)}</Box>
                )}
              </Typography>
              {card.impactBps !== null && (
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: card.impactBps >= HIGH_IMPACT_BPS ? 'bold' : 'normal',
                    color: card.impactBps >= SEVERE_IMPACT_BPS
                      ? 'error.main'
                      : card.impactBps >= HIGH_IMPACT_BPS ? 'warning.main' : 'text.secondary',
                  }}
                >
                  {t.exchange.swap.priceImpact}: <Box component="span" sx={{ fontFamily: MONO }}>{(card.impactBps / 100).toFixed(2)}%</Box>
                </Typography>
              )}
              {card.minReceivedBase !== null && (
                <Typography variant="caption" color="text.secondary">
                  {interpolate(t.exchange.swap.minimumReceived, {
                    tolerance: (DEFAULT_SLIPPAGE_BPS / 100).toFixed(1),
                  })}:{' '}
                  <Box component="span" sx={{ color: 'white', fontFamily: MONO }}>
                    {f18(minOutWithSlippage(card.minReceivedBase), outDecimals)}{' '}
                    {outToken}
                  </Box>
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary">
                {poolNote}
              </Typography>
            </Box>

            {/* #215 M2：舊版合約的報價不看庫存。超過輸出側庫存的金額送出必定失敗，
                所以在這裡直接說清楚並停用按鈕，而不是顯示一個換不到的數字。 */}
            {card.inventoryExceeded && (
              <Alert severity="error" variant="outlined" sx={{ py: 0.5 }}>
                <Typography variant="caption">
                  ⛔ {inventoryMessage(card.inventoryExceeded.needed, card.inventoryExceeded.available)}
                </Typography>
              </Alert>
            )}

            {card.impactBps !== null && card.impactBps >= SEVERE_IMPACT_BPS && (
              <Alert severity="error" variant="outlined" sx={{ py: 0.5 }}>
                <Typography variant="caption">
                  {t.exchange.markup.priceImpactBefore}<b>{(card.impactBps / 100).toFixed(2)}%</b>{t.exchange.markup.priceImpactAfter}<code>{t.exchange.markup.priceImpactCode}</code>{t.exchange.markup.priceImpactLine2After}
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
              disabled={card.button.disabled}
              sx={{ py: 1.6, borderRadius: 2, fontWeight: 'bold', fontSize: '1.05rem' }}
            >
              {card.button.label === 'swap'
                ? interpolate(
                    isEthIn ? t.exchange.swap.ethToToken : t.exchange.swap.tokenToEth,
                    { token: STABLE_LABEL },
                  )
                : t.exchange.swap[card.button.label]}
            </Button>
          </>
        )}
      </Card>
    </Container>
  );
}

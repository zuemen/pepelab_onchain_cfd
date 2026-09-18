import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react';
import { Link as RouterLink } from 'react-router';
import { parseEther } from 'ethers';
import { useContracts } from 'src/hooks/useContracts';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { paths } from 'src/routes/paths';
import { t, interpolate } from 'src/locales';
import { prettyError } from 'src/lib/pepefi/errorMessages';
import { safeRead } from 'src/lib/pepefi/safeRead';
import { STABLE_LABEL, ALT_STABLE_LABEL, X402_STABLE_LABEL } from 'src/lib/pepefi/tokenLabel';
import { SHOW_PERPETUALS } from 'src/lib/pepefi/featureFlags';
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
import Link from '@mui/material/Link';
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

  const [busy,         setBusy]        = useState<Record<string, boolean>>({});


  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }));
  const { notify } = useToast();

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

      // 骨架撤掉的時機：餘額、水龍頭、兌換面板都備妥即可。#148 之後這一頁
      // 不再讀部位，所以沒有任何「晚點才串進來」的區塊。
      setPageLoading(false);
    } finally {
      setPageLoading(false);
    }
  }, [contracts, wallet.address, wallet.provider]);

  useEffect(() => { void fetchAll() }, [fetchAll]);

  // 防呆保險：掛載後最多 10 秒一定關掉骨架，避免任何未來路徑再卡死。
  useEffect(() => {
    const t = setTimeout(() => setPageLoading(false), 10000);
    return () => clearTimeout(t);
  }, []);

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
    // 餘額不足是第三種必定失敗的情況,而且最常見。少了這道檢查,USDC→ETH 會先送出
    // approve 叫出錢包、等使用者簽完付掉 gas,才在 swap 那一步失敗——白付一筆。
    const payRaw = parseEther(payAmount);
    const balRaw = swapMode === 'eth-to-usdc' ? ethBalRaw : usdcBal;
    if (payRaw > balRaw) {
      notify(interpolate(t.exchange.tx.insufficientBalance, {
        token:   swapMode === 'eth-to-usdc' ? 'ETH' : STABLE_LABEL,
        balance: f18(balRaw, swapMode === 'eth-to-usdc' ? 4 : 2),
      }), false);
      return;
    }
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
      {/* 「本頁開倉為合成持倉」——存在的目的是解釋這一頁的部位與 ERC-20 代幣
          的差別。SHOW_PERPETUALS 關閉時這一頁沒有部位可解釋,留著只會憑空
          introduce 一個看不到的概念。 */}
      {SHOW_PERPETUALS && (
      <Alert severity="info" sx={{ mb: 2 }}>
        {t.exchange.markup.syntheticPositionBefore}<b>{t.exchange.markup.syntheticPositionBold}</b>{t.exchange.markup.syntheticPositionAfter}
        <Link component={RouterLink} to={paths.pepefi.tokens} sx={{ ml: 0.5, fontWeight: 'bold' }}>
          {t.exchange.markup.tokenizedAssetsLink}
        </Link>
      </Alert>
      )}

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
          {SHOW_PERPETUALS ? t.exchange.guide.title : t.exchange.guide.spotTitle}
        </Typography>
        <Typography variant="body2" component="ol" sx={{ pl: 2, m: 0, '& li': { mb: 0.5 } }}>
          {/* 兩條路線的步驟不一樣,不是同一份文字加減幾句:現貨的流程是
              領幣 → 到資產交易頁買 → 回投資組合看配置,中間沒有「保證金帳戶」
              也沒有「開倉」。 */}
          <li><strong>{t.exchange.markup.stepGetTokensLabel}</strong> {interpolate(t.exchange.markup.stepGetTokensBody, { token: STABLE_LABEL })}</li>
          {SHOW_PERPETUALS ? (
            <>
              <li><strong>{t.exchange.markup.stepMarginLabel}</strong> {interpolate(t.exchange.markup.stepMarginBody, { token: STABLE_LABEL })}</li>
              <li><strong>{t.exchange.markup.stepOpenLabel}</strong> {t.exchange.markup.stepOpenBody}</li>
              <li><strong>{t.exchange.markup.stepPnlLabel}</strong> {t.exchange.markup.stepPnlBody}</li>
            </>
          ) : (
            <>
              <li><strong>{t.exchange.markup.stepBuyLabel}</strong> {interpolate(t.exchange.markup.stepBuyBody, { token: STABLE_LABEL })}</li>
              <li><strong>{t.exchange.markup.stepPortfolioLabel}</strong> {t.exchange.markup.stepPortfolioBody}</li>
            </>
          )}
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
              {t.exchange.markup.ethBalanceBefore}<Box component="span" sx={{ fontFamily: MONO, color: 'text.primary' }}>{ethBal}</Box>{SHOW_PERPETUALS ? t.exchange.markup.ethBalanceAfter : t.exchange.markup.ethBalanceAfterSpot}
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
          開倉與平倉走 /terminal（ticket/OrderTicket、positions/PositionsTable），
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
    </Container>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { Link as RouterLink } from 'react-router';
import { parseEther } from 'ethers';
import { useContracts } from 'src/hooks/useContracts';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { useLivePrices } from 'src/hooks/useLivePrices';
import { useFundingData } from 'src/hooks/useFundingData';
import { LineChart, Line, YAxis, ResponsiveContainer } from 'recharts';
import { ASSET_IDS, getAddresses } from 'src/contracts/addresses';
import { prettyError } from 'src/lib/pepefi/errorMessages';
import { useESG } from 'src/hooks/useESG';
import ESGBadge from 'src/components/pepefi/ESGBadge';
import { ASSETS_LIST, ASSET_LABEL, ASSET_META } from 'src/lib/pepefi/assetMeta';
import { useKYC } from 'src/hooks/useKYC';
import KYCModal from 'src/components/pepefi/KYCModal';
import Skeleton from 'src/components/pepefi/Skeleton';
import AssetIcon from 'src/components/pepefi/AssetIcon';

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
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
import Snackbar from '@mui/material/Snackbar';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import InputLabel from '@mui/material/InputLabel';
import InputAdornment from '@mui/material/InputAdornment';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
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
}

interface RawPos {
  asset: string; isLong: boolean; isOpen: boolean;
  entryPrice: bigint; margin: bigint; leverage: bigint;
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
  return (n >= 0 ? '+' : '') + n.toFixed(4) + ' USDC';
};
const pnlColor = (v: bigint) => Number(v) >= 0 ? 'success.main' : 'error.main';
const tryParse = (s: string): bigint | null => {
  try { return s ? parseEther(s) : null; } catch { return null; }
};

type TxResp = { wait(): Promise<unknown>; hash: string };
const asTx = (tx: unknown): TxResp => tx as TxResp;

export default function ExchangePage() {
  const wallet = usePepefiWallet();
  const contracts    = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const livePrices   = useLivePrices();
  const fundingData  = useFundingData(contracts?.exchange ?? null);
  const { data: esgData } = useESG(contracts?.esgRegistry ?? null);
  
  const esg = (esgData ?? {}) as unknown as Record<string, ESGAssetInfo>;

  const [usdcBal,   setUsdcBal]   = useState(0n);
  const [ethBal,    setEthBal]    = useState('0.0000');
  const [freeMgn,   setFreeMgn]   = useState(0n);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [curPrice,  setCurPrice]  = useState(0n);
  const [pageLoading, setPageLoading] = useState(true);

  const [swapMode,  setSwapMode]  = useState<'eth-to-usdc' | 'usdc-to-eth'>('eth-to-usdc');
  const [payAmount, setPayAmount] = useState('');
  const [ammPrice,  setAmmPrice]  = useState(0n);
  const [ammEth,    setAmmEth]    = useState(0n);
  const [ammUsdc,   setAmmUsdc]   = useState(0n);
  const [receiveAmount,  setReceiveAmount]  = useState('');
  const [depositAmt,       setDepositAmt]        = useState('');
  const [withdrawAmt, setWithdrawAmt] = useState('');
  const [selAsset,    setSelAsset]    = useState<AssetId>(ASSET_IDS.sBTC);
  const [isLong,      setIsLong]      = useState(true);
  const [leverage,    setLeverage]    = useState(1);
  const [openMgn,     setOpenMgn]     = useState('');
  const [history,     setHistory]     = useState<{ time: string; price: number }[]>([]);

  const [busy,         setBusy]        = useState<Record<string, boolean>>({});
  const [toast,        setToast]       = useState<{ msg: string; ok: boolean; hash?: string } | null>(null);
  const [showKYCModal, setShowKYCModal] = useState(false);
  const [esgConfirmed, setEsgConfirmed] = useState(false);

  const [esgRewardedMap, setEsgRewardedMap] = useState<Record<string, boolean>>({});
  const [esgPreviewMap,  setEsgPreviewMap]  = useState<Record<string, bigint>>({});

  const { isVerified: isKYCVerified, refetch: refetchKYC } = useKYC(
    contracts?.kycRegistry ?? null,
    wallet.address ?? null
  );

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }));
  const notify  = useCallback((msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash });
  }, []);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.address || !wallet.provider) return;
    try {
      const [bal, mgn, eBal] = await Promise.all([
        contracts.usdc.balanceOf(wallet.address),
        contracts.exchange.freeMargin(wallet.address),
        wallet.provider!.getBalance(wallet.address),
      ]);
      setUsdcBal(bal as bigint);
      setFreeMgn(mgn as bigint);
      setEthBal(f18(eBal as bigint, 4));

      let price = 0n;
      let reserves: [bigint, bigint] = [0n, 0n];
      try {
        price    = await contracts.pepeAMM.getPrice() as bigint;
        reserves = await contracts.pepeAMM.getReserves() as [bigint, bigint];
      } catch (e) {
        console.warn('[AMM] unavailable:', e);
      }
      setAmmPrice(price);
      const [ethR, usdcR] = reserves;
      setAmmEth(ethR);
      setAmmUsdc(usdcR);

      const ids = (await contracts.exchange.getUserPositions(wallet.address)) as bigint[];
      const maybeRows = await Promise.all(
        ids.map(async (id): Promise<PositionRow | null> => {
          try {
            const raw = (await contracts.exchange.getPosition(id)) as unknown as RawPos;
            if (!raw.isOpen) return null;
            const pnl = (await contracts.exchange.getUnrealizedPnL(id)) as bigint;
            const pr  = (await contracts.oracle.getPrice(raw.asset)) as unknown as [bigint, bigint];
            return {
              id, asset: raw.asset, isLong: raw.isLong,
              entryPrice: raw.entryPrice, margin: raw.margin, leverage: raw.leverage,
              unrealizedPnL: pnl, currentPrice: pr[0] * 10n ** 10n,
            };
          } catch { return null; }
        })
      );
      setPositions(maybeRows.filter((r): r is PositionRow => r !== null));
    } catch (e) {
      console.error('[exchange fetch]', e);
      notify(prettyError(e), false);
    } finally {
      setPageLoading(false);
    }
  }, [contracts, wallet.address, notify]);

  useEffect(() => {
    if (!contracts) return;
    void (async () => {
      try {
        const pr = (await contracts.oracle.getPrice(selAsset)) as unknown as [bigint, bigint];
        setCurPrice(pr[0] * 10n ** 10n);
      } catch (e) { console.error('[price fetch]', e); }
    })();
  }, [contracts, selAsset]);

  useEffect(() => { void fetchAll() }, [fetchAll]);

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

  // ── Live AMM quote ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!contracts?.pepeAMM || !payAmount || parseFloat(payAmount) <= 0) {
      setReceiveAmount('');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const parsed = parseEther(payAmount);
        const out = swapMode === 'eth-to-usdc'
          ? await contracts.pepeAMM.quoteETHForUSDC(parsed) as bigint
          : await contracts.pepeAMM.quoteUSDCForETH(parsed) as bigint;
        if (!cancelled) {
          setReceiveAmount((Number(out) / 1e18).toFixed(swapMode === 'eth-to-usdc' ? 2 : 6));
        }
      } catch {
        if (!cancelled) { setReceiveAmount(''); }
      }
    })();
    return () => { cancelled = true; };
  }, [contracts?.pepeAMM, payAmount, swapMode]);

  // ── Transactions ────────────────────────────────────────────────────────────
  const doSwap = async () => {
    if (!contracts || !wallet.address) return;
    const amt = parseFloat(payAmount);
    if (!amt || amt <= 0) { notify('Enter a valid amount', false); return; }

    setLoad('swap', true);
    try {
      if (swapMode === 'eth-to-usdc') {
        const ethIn  = parseEther(payAmount);
        const quoted = await contracts.pepeAMM.quoteETHForUSDC(ethIn) as bigint;
        const minOut = quoted * 99n / 100n;
        const tx = asTx(await contracts.pepeAMM.swapETHForUSDC(minOut, { value: ethIn }));
        await tx.wait();
        notify(`Swapped ${payAmount} ETH for ~${(Number(quoted) / 1e18).toFixed(2)} mUSDC ✓`, true, tx.hash);
      } else {
        const usdcIn = parseEther(payAmount);

        const currentAllowance = await contracts.usdc.allowance(
          wallet.address!,
          String(contracts.pepeAMM.target)
        ) as bigint;

        if (currentAllowance < usdcIn) {
          notify('Approving mUSDC...', true);
          const approveTx = asTx(await contracts.usdc.approve(String(contracts.pepeAMM.target), usdcIn));
          await approveTx.wait();
        }

        const quoted    = await contracts.pepeAMM.quoteUSDCForETH(usdcIn) as bigint;
        const minEthOut = quoted * 99n / 100n;
        const tx = asTx(await contracts.pepeAMM.swapUSDCForETH(usdcIn, minEthOut));
        await tx.wait();
        notify(`Swapped ${payAmount} mUSDC for ~${(Number(quoted) / 1e18).toFixed(6)} ETH ✓`, true, tx.hash);
      }
      setPayAmount('');
      await new Promise(r => setTimeout(r, 1500));
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('swap', false); }
  };

  const addToWallet = async () => {
    if (!contracts || !(window as any).ethereum) return;
    try {
      await (window as any).ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address: contracts.usdc.target,
            symbol: 'mUSDC',
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
    if (!amt) { notify('Enter a valid amount', false); return; }
    setLoad('deposit', true);
    try {
      const approveTx = asTx(await contracts.usdc.approve(String(contracts.exchange.target), amt));
      await approveTx.wait();
      const depositTx = asTx(await contracts.exchange.depositMargin(amt));
      await depositTx.wait();
      notify(`Deposited ${depositAmt} mUSDC ✓`, true, depositTx.hash);
      setDepositAmt('');
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('deposit', false); }
  };

  const doWithdraw = async () => {
    if (!contracts) return;
    const amt = tryParse(withdrawAmt);
    if (!amt) { notify('Enter a valid amount', false); return; }
    setLoad('withdraw', true);
    try {
      const tx = asTx(await contracts.exchange.withdrawMargin(amt));
      await tx.wait();
      notify(`Withdrew ${withdrawAmt} mUSDC ✓`, true, tx.hash);
      setWithdrawAmt('');
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('withdraw', false); }
  };

  const openPosition = async () => {
    if (!contracts) return;
    const amt = tryParse(openMgn);
    if (!amt) { notify('Enter a valid margin', false); return; }
    if (amt > freeMgn) {
      notify('保證金不足，請先在 Margin Account 區塊 Approve & Deposit', false);
      return;
    }
    setLoad('open', true);
    try {
      const tx = asTx(await contracts.exchange.openPosition(selAsset, isLong, amt, BigInt(leverage), { value: parseEther('0.001') }));
      await tx.wait();
      notify(`${isLong ? 'Long' : 'Short'} ${ASSET_LABEL[selAsset] ?? selAsset} opened ✓`, true, tx.hash);
      setOpenMgn('');
      await fetchAll();
    } catch (e) {
      notify(prettyError(e), false);
    } finally { setLoad('open', false); }
  };

  const closePos = async (id: bigint) => {
    if (!contracts) return;
    const key = `close_${id}`;
    setLoad(key, true);
    try {
      const tx = asTx(await contracts.exchange.closePosition(id));
      await tx.wait();
      notify('Position closed ✓', true, tx.hash);
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
      notify('🌱 ESG 獎勵領取成功！', true, tx.hash);
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
  
  const liqPrice   = isLong 
    ? curPrice - (curPrice / BigInt(leverage))
    : curPrice + (curPrice / BigInt(leverage));

  const livePositions = positions.map(p => {
    const liveUsd = livePrices[p.asset as AssetId]?.usd;
    const currentLivePrice = liveUsd ? BigInt(Math.round(liveUsd * 1e8)) * 10n**10n : p.currentPrice;
    
    const notional = p.margin * p.leverage;
    const size = (notional * 10n**18n) / p.entryPrice;
    const priceChange = currentLivePrice - p.entryPrice;
    let livePnL = (priceChange * size) / 10n**18n;
    if (!p.isLong) livePnL = -livePnL;
    
    return { ...p, currentLivePrice, livePnL };
  });

  const totalUnrealizedPnL = livePositions.reduce((acc, p) => acc + p.livePnL, 0n);
  const accountEquity = freeMgn + totalUnrealizedPnL;

  const activeTask = Object.entries(busy).find(([_, v]) => v)?.[0];
  const isBusy = !!activeTask;
  let loadingMsg = 'Processing transaction...';
  if (activeTask) {
    if (activeTask === 'swap') loadingMsg = swapMode === 'eth-to-usdc' ? 'Swapping ETH to mUSDC...' : 'Swapping mUSDC to ETH...';
    else if (activeTask === 'deposit') loadingMsg = 'Depositing Margin...';
    else if (activeTask === 'withdraw') loadingMsg = 'Withdrawing Margin...';
    else if (activeTask === 'open') loadingMsg = 'Opening Position...';
    else if (activeTask.startsWith('close')) loadingMsg = 'Closing Position...';
  }

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to access the exchange.</Typography>
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
          <Typography color="text.secondary">Loading blockchain data...</Typography>
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
            Please confirm the transaction in your wallet and wait for block confirmation.
          </Typography>
        </Box>
      </Backdrop>

      {/* Toast Notification */}
      <Snackbar
        open={!!toast}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        message={toast?.msg}
        action={
          toast?.hash && wallet.chainId === 11155111 ? (
            <Button
              color="primary"
              size="small"
              component="a"
              href={`https://sepolia.etherscan.io/tx/${toast.hash}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Etherscan
            </Button>
          ) : null
        }
      />

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
          How CFD trading works on PepeFi
        </Typography>
        <Typography variant="body2" component="ol" sx={{ pl: 2, m: 0, '& li': { mb: 0.5 } }}>
          <li><strong>Swap:</strong> Swap ETH for mUSDC to get your stablecoin collateral.</li>
          <li><strong>Margin Account:</strong> Approve &amp; deposit mUSDC into PerpetualExchange. This becomes your free margin.</li>
          <li><strong>Open Position:</strong> Use free margin to open long/short on 11 synthetic assets — crypto (sBTC, sETH), equity (sAAPL, sTSLA, sNVDA, sMSFT, sGOOGL), commodity (sGOLD), bond (sBOND), and ESG ETFs (sICLN, sESGU). 🔒 = KYC required.</li>
          <li><strong>PnL:</strong> Price moves → position value changes → close to realize PnL.</li>
        </Typography>
      </Alert>

      {/* A & B — Swap + Margin */}
      <Grid container spacing={3}>
        {/* A. Swap (Uniswap Style) */}
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
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: 'white' }}>Swap</Typography>
              <IconButton size="small" sx={{ color: 'text.secondary' }}>
                <Icon icon="solar:settings-bold-duotone" width={20} />
              </IconButton>
            </Box>

            {/* Pay block */}
            <Box sx={{ bgcolor: '#131A2A', borderRadius: 2, p: 2, border: '1px solid transparent', '&:hover': { borderColor: 'rgba(255,255,255,0.08)' } }}>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>You pay</Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <input
                  type="number"
                  placeholder="0"
                  value={payAmount}
                  onChange={e => setPayAmount(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'transparent',
                    border: 'none',
                    fontSize: '2rem',
                    color: 'white',
                    outline: 'none',
                    fontWeight: 700,
                    fontFamily: 'monospace',
                  }}
                />
                {swapMode === 'eth-to-usdc' ? (
                  <Chip
                    avatar={<Box component="span" sx={{ width: 20, height: 20, borderRadius: "50%", bgcolor: "#627eea", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.625rem", fontWeight: "bold", color: "white" }}>Ξ</Box>}
                    label="ETH"
                    onClick={() => {}}
                    sx={{ bgcolor: '#293249', color: 'white', fontWeight: 'bold', '&:hover': { bgcolor: '#323D59' } }}
                  />
                ) : (
                  <Chip
                    avatar={<Box sx={{ width: 20, height: 20, borderRadius: '50%', bgcolor: 'primary.main', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.625rem', fontWeight: 'bold', color: 'white' }}>m</Box>}
                    label="mUSDC"
                    onClick={() => {}}
                    sx={{ bgcolor: '#293249', color: 'white', fontWeight: 'bold', '&:hover': { bgcolor: '#323D59' } }}
                  />
                )}
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1.5 }}>
                <Typography variant="caption" color="text.secondary">
                  $ {swapMode === 'eth-to-usdc'
                    ? (parseFloat(payAmount || '0') * Number(ammPrice) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : parseFloat(payAmount || '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ cursor: 'pointer', '&:hover': { color: 'white' } }}>
                  Balance: {swapMode === 'eth-to-usdc' ? ethBal : f18(usdcBal)}
                </Typography>
              </Box>
            </Box>

            {/* Switch direction button */}
            <Box sx={{ display: 'flex', justifyContent: 'center', my: -2.5, zIndex: 2 }}>
              <IconButton
                onClick={() => { setSwapMode(m => m === 'eth-to-usdc' ? 'usdc-to-eth' : 'eth-to-usdc'); setPayAmount(''); setReceiveAmount(''); }}
                sx={{
                  bgcolor: '#131A2A',
                  border: '4px solid #0D111C',
                  color: 'white',
                  '&:hover': { bgcolor: '#1e2a45' },
                  p: 1,
                }}
              >
                <Icon icon="solar:transfer-vertical-bold-duotone" width={18} />
              </IconButton>
            </Box>

            {/* Receive Block */}
            <Box sx={{ bgcolor: '#131A2A', borderRadius: 2, p: 2, border: '1px solid transparent', '&:hover': { borderColor: 'rgba(255,255,255,0.08)' } }}>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>You receive</Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <input
                  type="number"
                  placeholder="0"
                  value={receiveAmount}
                  onChange={e => {
                    const v = e.target.value;
                    setReceiveAmount(v);
                    const r = parseFloat(v || '0');
                    const price = Number(ammPrice) / 1e18;
                    if (r > 0 && price > 0) {
                      if (swapMode === 'eth-to-usdc') setPayAmount((r / price).toFixed(6));
                      else setPayAmount((r * price).toFixed(2));
                    } else {
                      setPayAmount('');
                    }
                  }}
                  style={{
                    width: '100%',
                    background: 'transparent',
                    border: 'none',
                    fontSize: '2rem',
                    color: 'white',
                    outline: 'none',
                    fontWeight: 700,
                    fontFamily: 'monospace',
                  }}
                />
                {swapMode === 'eth-to-usdc' ? (
                  <Chip
                    avatar={<Box sx={{ width: 20, height: 20, borderRadius: '50%', bgcolor: 'primary.main', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.625rem', fontWeight: 'bold', color: 'white' }}>m</Box>}
                    label="mUSDC"
                    onClick={() => {}}
                    sx={{ bgcolor: '#293249', color: 'white', fontWeight: 'bold', '&:hover': { bgcolor: '#323D59' } }}
                  />
                ) : (
                  <Chip
                    avatar={<Box component="span" sx={{ width: 20, height: 20, borderRadius: "50%", bgcolor: "#627eea", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.625rem", fontWeight: "bold", color: "white" }}>Ξ</Box>}
                    label="ETH"
                    onClick={() => {}}
                    sx={{ bgcolor: '#293249', color: 'white', fontWeight: 'bold', '&:hover': { bgcolor: '#323D59' } }}
                  />
                )}
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1.5 }}>
                <Typography variant="caption" color="text.secondary">
                  $ {swapMode === 'eth-to-usdc'
                    ? parseFloat(receiveAmount || '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : (parseFloat(receiveAmount || '0') * Number(ammPrice) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ cursor: 'pointer', '&:hover': { color: 'white' } }}>
                  Balance: {swapMode === 'eth-to-usdc' ? f18(usdcBal) : ethBal}
                </Typography>
              </Box>
            </Box>

            {/* AMM pool info */}
            <Box sx={{ px: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                Rate: <Box component="span" sx={{ color: 'white', fontFamily: 'monospace' }}>1 ETH = {ammPrice > 0n ? (Number(ammPrice) / 1e18).toFixed(2) : '–'} mUSDC</Box>
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Pool: <Box component="span" sx={{ color: 'white', fontFamily: 'monospace' }}>{ammEth > 0n ? (Number(ammEth) / 1e18).toFixed(4) : '–'} ETH</Box> / <Box component="span" sx={{ color: 'white', fontFamily: 'monospace' }}>{ammUsdc > 0n ? (Number(ammUsdc) / 1e18).toFixed(2) : '–'} mUSDC</Box>
              </Typography>
            </Box>

            {ammEth === 0n && (
              <Alert severity="warning" variant="outlined" sx={{ py: 0, px: 2 }}>
                流動性不足，暫無法兌換
              </Alert>
            )}

            <Button
              variant="contained"
              fullWidth
              onClick={() => void doSwap()}
              disabled={busy['swap'] || ammEth === 0n || !payAmount || parseFloat(payAmount) <= 0}
              sx={{
                py: 1.8,
                borderRadius: 2,
                fontWeight: 'bold',
                fontSize: '1.125rem',
                bgcolor: ammEth === 0n || !payAmount || parseFloat(payAmount) <= 0 ? 'rgba(255,255,255,0.03)' : 'primary.main',
                color: ammEth === 0n || !payAmount || parseFloat(payAmount) <= 0 ? 'text.disabled' : 'white',
              }}
            >
              {busy['swap']
                ? 'Swapping…'
                : ammEth === 0n
                  ? '流動性不足'
                  : !payAmount || parseFloat(payAmount) <= 0
                    ? 'Enter an amount'
                    : swapMode === 'eth-to-usdc' ? 'Swap ETH → mUSDC' : 'Swap mUSDC → ETH'}
            </Button>

            <Button
              variant="text"
              size="small"
              onClick={() => void addToWallet()}
              startIcon={<Icon icon="solar:wallet-bold-duotone" />}
              sx={{ textTransform: 'none', color: 'info.main', fontSize: '0.75rem', mt: 0.5 }}
            >
              Don't see mUSDC? Add to MetaMask
            </Button>
          </Card>
        </Grid>

        {/* B. Margin & Account Equity */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3, height: '100%' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <Box>
                <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold' }}>
                  Account Equity
                </Typography>
                <Typography variant="h4" sx={{ fontWeight: 800, fontFamily: 'monospace', mt: 0.5 }}>
                  {fUsd(accountEquity)}{' '}
                  <Typography component="span" variant="subtitle2" color="text.secondary">mUSDC</Typography>
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'right' }}>
                <Typography variant="caption" color="text.secondary" display="block">Free Margin</Typography>
                <Typography sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>{f18(freeMgn)}</Typography>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>Unrealized PnL</Typography>
                <Typography sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: pnlColor(totalUnrealizedPnL) }}>
                  {fPnL(totalUnrealizedPnL)}
                </Typography>
              </Box>
            </Box>

            <Divider />

            <Stack spacing={2}>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <TextField
                  placeholder="Amount to deposit"
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
                  {busy['deposit'] ? '…' : 'Approve & Deposit'}
                </Button>
              </Box>

              <Box sx={{ display: 'flex', gap: 1 }}>
                <TextField
                  placeholder="Amount to withdraw"
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
                  {busy['withdraw'] ? '…' : 'Withdraw'}
                </Button>
              </Box>
            </Stack>
          </Card>
        </Grid>
      </Grid>

      {/* C. Open Position */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3.5 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Open Position
        </Typography>

        {freeMgn === 0n && (
          <Alert severity="warning">
            You have no free margin. Deposit mUSDC in the <strong>Margin Account</strong> section above first.
          </Alert>
        )}

        {kycBlocked && (
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" variant="outlined" onClick={() => setShowKYCModal(true)} sx={{ fontWeight: 'bold' }}>
                完成 KYC
              </Button>
            }
          >
            🔒 <strong>{selectedAssetMeta?.symbol}</strong> 是股票 / 債券 / ETF 類資產，需要完成 KYC 驗證才能交易。
          </Alert>
        )}

        {isLowEsg && (
          <Alert severity="error" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
              ⚠ ESG 警告：此資產評分偏低（{selEsg!.composite}/100 · {selEsg!.rating}）
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              此資產 ESG 評分偏低，可能涉及較高環境、社會或治理風險，請謹慎評估永續投資風險後再決定是否開倉。
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
                  我已了解此資產的 ESG 風險，仍要繼續交易
                </Typography>
              }
            />
          </Alert>
        )}

        <Grid container spacing={2}>
          {/* Asset Select */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <FormControl fullWidth>
              <InputLabel id="asset-select-label">Asset</InputLabel>
              <Select
                labelId="asset-select-label"
                value={selAsset}
                onChange={e => setSelAsset(e.target.value as AssetId)}
                label="Asset"
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
                    {selEsg.composite >= 65 ? '高永續評級' : '低永續評級'}
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', gap: 1.5 }}>
                  <Typography variant="caption" color="text.secondary">E: <Box component="span" sx={{ color: 'text.primary', fontFamily: 'monospace' }}>{selEsg.environmental}</Box></Typography>
                  <Typography variant="caption" color="text.secondary">S: <Box component="span" sx={{ color: 'text.primary', fontFamily: 'monospace' }}>{selEsg.social}</Box></Typography>
                  <Typography variant="caption" color="text.secondary">G: <Box component="span" sx={{ color: 'text.primary', fontFamily: 'monospace' }}>{selEsg.governance}</Box></Typography>
                </Box>
              </Box>
            ) : contracts ? (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                ESG 資料載入中…
              </Typography>
            ) : null}
          </Grid>

          {/* Direction */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <Stack spacing={1}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', fontWeight: 'bold' }}>
                Direction
              </Typography>
              <Box sx={{ display: 'flex', border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden', height: 40 }}>
                <Button
                  fullWidth
                  variant={isLong ? 'contained' : 'text'}
                  color="success"
                  onClick={() => setIsLong(true)}
                  sx={{ borderRadius: 0, fontWeight: 'bold' }}
                >
                  LONG ↑
                </Button>
                <Button
                  fullWidth
                  variant={!isLong ? 'contained' : 'text'}
                  color="error"
                  onClick={() => setIsLong(false)}
                  sx={{ borderRadius: 0, fontWeight: 'bold' }}
                >
                  SHORT ↓
                </Button>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5 }}>
                <Typography variant="caption" color="text.secondary">Order Type: Market</Typography>
                <Typography variant="caption" color="primary.main" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Icon icon="solar:dollar-bold" /> Execution Fee: 0.001 ETH
                </Typography>
              </Box>
            </Stack>
          </Grid>

          {/* Leverage */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <Stack spacing={1}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', fontWeight: 'bold' }}>
                Leverage
              </Typography>
              <Box sx={{ display: 'flex', border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden', height: 40 }}>
                {[1, 2, 5].map(lv => (
                  <Button
                    key={lv}
                    fullWidth
                    variant={leverage === lv ? 'contained' : 'text'}
                    color="warning"
                    onClick={() => setLeverage(lv)}
                    sx={{ borderRadius: 0, fontWeight: 'bold' }}
                  >
                    {lv}×
                  </Button>
                ))}
              </Box>
            </Stack>
          </Grid>

          {/* Margin Input */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <TextField
              label="Margin"
              type="number"
              fullWidth
              placeholder="e.g. 100"
              value={openMgn}
              onChange={e => setOpenMgn(e.target.value)}
              slotProps={{
                input: {
                  endAdornment: <InputAdornment position="end">mUSDC</InputAdornment>,
                },
              }}
            />
          </Grid>
        </Grid>

        {/* Live quote values */}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, fontSize: '0.8125rem', color: 'text.secondary', pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Entry (oracle): <Box component="span" sx={{ color: 'text.primary', fontWeight: 'bold', fontFamily: 'monospace' }}>{fUsd(curPrice)}</Box>
          </Typography>
          {livePrices[selAsset] && (
            <Typography variant="body2" color="text.secondary">
              Live market:{' '}
              <Box component="span" sx={{ fontWeight: 'bold', fontFamily: 'monospace', color: livePrices[selAsset].isMock ? 'warning.main' : 'success.main' }}>
                ${livePrices[selAsset].usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </Box>
              {livePrices[selAsset].isMock && <Box component="span" sx={{ opacity: 0.6, fontSize: '0.6875rem', ml: 0.5 }}>(simulated)</Box>}
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            Notional: <Box component="span" sx={{ color: 'text.primary', fontWeight: 'bold', fontFamily: 'monospace' }}>{f18(notional)} mUSDC</Box>
          </Typography>
          {(() => {
            const fi = fundingData[selAsset];
            if (!fi) return null;
            const rateNum = Number(fi.rate);
            const ratePct = (rateNum / 100).toFixed(4);
            return (
              <Typography variant="body2" sx={{ fontWeight: 'medium', color: rateNum > 0 ? 'error.main' : rateNum < 0 ? 'success.main' : 'text.secondary' }}>
                Funding rate (8h):{' '}
                <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>{rateNum >= 0 ? '+' : ''}{ratePct}%</Box>
                {' '}{rateNum > 0 ? '(longs pay)' : rateNum < 0 ? '(shorts pay)' : '(balanced)'}
              </Typography>
            );
          })()}
          {openMgn && (
            <Chip
              label={`Est. Liquidation: ${fUsd(liqPrice)}`}
              color="error"
              size="small"
              variant="outlined"
              sx={{ fontFamily: 'monospace', fontWeight: 'bold', bgcolor: 'rgba(255, 86, 48, 0.08)' }}
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
          PnL is calculated using on-chain oracle price. Live market shown for reference.
          Admin can sync oracle to live market on the{' '}
          <Link component={RouterLink} to="/admin/oracle" sx={{ color: 'primary.main', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>Oracle Admin</Link> page.
        </Typography>

        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 'medium' }}>
            Free margin: <Box component="span" sx={{ color: 'text.primary', fontFamily: 'monospace', fontWeight: 'bold' }}>{f18(freeMgn)} mUSDC</Box>
            {openMgnBig !== null && openMgnBig > freeMgn && (
              <Box component="span" sx={{ color: 'error.main', fontWeight: 'bold', ml: 2 }}>
                ⚠ Insufficient — deposit at least {f18(openMgnBig - freeMgn)} more mUSDC first
              </Box>
            )}
          </Typography>

          <Button
            onClick={() => kycBlocked ? setShowKYCModal(true) : void openPosition()}
            disabled={
              busy['open'] ||
              !openMgn ||
              (openMgnBig !== null && openMgnBig > freeMgn) ||
              (kycBlocked && !openMgn) ||
              (isLowEsg && !esgConfirmed)
            }
            variant="contained"
            color={kycBlocked ? 'warning' : isLowEsg && !esgConfirmed ? 'inherit' : isLong ? 'success' : 'error'}
            sx={{
              fontWeight: 'bold',
              px: 4,
              py: 1.2,
              borderRadius: 1,
            }}
          >
            {busy['open']
              ? 'Opening…'
              : kycBlocked
                ? `🔒 完成 KYC 才能交易 ${ASSET_LABEL[selAsset] ?? ''}`
                : isLowEsg && !esgConfirmed
                  ? '請先確認 ESG 風險'
                  : `Open ${isLong ? 'Long' : 'Short'} ${ASSET_LABEL[selAsset] ?? ''}`}
          </Button>
        </Box>
      </Card>

      {/* KYC Modal Dialog */}
      <KYCModal
        isOpen={showKYCModal}
        onClose={() => setShowKYCModal(false)}
        onSuccess={() => { refetchKYC(); setShowKYCModal(false); }}
        kycRegistry={contracts?.kycRegistry ?? null}
      />

      {/* ESG Leaderboard */}
      {Object.keys(esg).length > 0 && (
        <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            ESG Leaderboard
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
                      <Typography variant="caption" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
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
                            <Typography variant="caption" sx={{ fontSize: '0.625rem', color: 'text.secondary', fontFamily: 'monospace' }}>{val}</Typography>
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
            Open Positions
          </Typography>
          <Button
            size="small"
            variant="text"
            color="inherit"
            onClick={() => void fetchAll()}
            startIcon={<Icon icon="solar:restart-bold-duotone" />}
            sx={{ textTransform: 'none', color: 'text.secondary' }}
          >
            Refresh
          </Button>
        </Box>

        {positions.length === 0 ? (
          <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 4, fontStyle: 'italic' }}>
            No open positions.
          </Typography>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {['Asset','Side','Entry','Current','Size','Margin','Lev','PnL',''].map(h => (
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
                  return (
                    <TableRow key={String(row.id)} sx={{ '&:hover': { bgcolor: 'action.hover' } }}>
                      <TableCell sx={{ py: 1 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <AssetIcon symbol={ASSET_LABEL[row.asset as AssetId] ?? ''} size={24} />
                          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', fontFamily: 'monospace' }}>
                            {ASSET_LABEL[row.asset as AssetId] ?? row.asset.slice(0, 8)}
                          </Typography>
                        </Box>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={row.isLong ? 'LONG' : 'SHORT'}
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
                      <TableCell sx={{ fontFamily: 'monospace' }}>{fUsd(row.entryPrice)}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{fUsd(row.currentLivePrice)}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>{f18(size, 6)}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{f18(row.margin)}</TableCell>
                      <TableCell>{String(row.leverage)}×</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: pnlColor(row.livePnL) }}>
                        {fPnL(row.livePnL)}
                      </TableCell>
                      <TableCell>
                        <Stack spacing={1} alignItems="flex-start">
                          <Button
                            size="small"
                            variant="outlined"
                            color="inherit"
                            onClick={() => void closePos(row.id)}
                            disabled={busy[closeKey]}
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
                            {busy[closeKey] ? '…' : 'Close'}
                          </Button>

                          {hasEsgRewardDistributor && (esg[row.asset]?.composite ?? 0) >= 70 && (() => {
                            const isRewarded = esgRewardedMap[String(row.id)];
                            const claimKey   = `claim_${row.id}`;
                            if (isRewarded === true) {
                              return (
                                <Chip
                                  label="✓ 已領 ESG 獎勵"
                                  size="small"
                                  color="success"
                                  variant="outlined"
                                  sx={{ fontSize: '0.625rem', fontWeight: 'bold' }}
                                />
                              );
                            }
                            if (isRewarded === false) {
                              const preview = esgPreviewMap[String(row.id)] ?? 0n;
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
                                  {busy[claimKey] ? '…' : `${f18(preview)} PEPE`}
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

import { useState, useEffect, useCallback } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { Icon } from '@iconify/react';

import { t, interpolate } from 'src/locales';
import { useContracts } from 'src/hooks/useContracts';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { isDeployed } from 'src/lib/pepefi/safeRead';
import { MONO } from 'src/components/pepefi/brandKit';
import Skeleton from 'src/components/pepefi/Skeleton';

// ----------------------------------------------------------------------
// PEPE 餘額與空投領取。
//
// 從 DashboardPage 搬過來的。搬移的原因是首頁不該同時是 DeFi 儀表板和 GameFi
// 中心；領獎屬於 /rewards，那裡已經有交易挖礦、等級獎勵、跟單獎勵與每日簽到。
//
// 搬移方式刻意是「整包搬」而不是「把 state 拆散再重接」：這是**鏈上寫入**
// （pepeClaim.claim()），而且全 repo 只有這一處在用 pepeClaim。漏掉任何一個
// 狀態或錯誤分支，畫面都不會報錯——只有真的按下「領取」的人才會發現壞了。
// 所以整個資料流（讀餘額、KYC、獎池、送交易、錯誤訊息）都收在這個元件裡，
// 呼叫端只要掛上去就好，沒有需要一起搬的外部狀態。

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const POLL_MS = 30_000;

export default function PepeTokenCard() {
  const wallet = usePepefiWallet();
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId);

  const [pepeBal,      setPepeBal]      = useState<bigint | null>(null);
  const [pepeClaimed,  setPepeClaimed]  = useState<boolean | null>(null);
  const [pepeAmount,   setPepeAmount]   = useState<bigint>(1000n * 10n ** 18n);
  const [pepeKyc,      setPepeKyc]      = useState(false);
  const [pepePoolBal,  setPepePoolBal]  = useState<bigint | null>(null);
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimError,   setClaimError]   = useState<string | null>(null);
  const [watchError,   setWatchError]   = useState<string | null>(null);

  const pepeReady = !!(contracts &&
    String(contracts.pepeToken.target).toLowerCase() !== ZERO_ADDR &&
    String(contracts.pepeClaim.target).toLowerCase() !== ZERO_ADDR);

  const fetchPepe = useCallback(async () => {
    if (!contracts || !wallet.address) return;
    if (String(contracts.pepeToken.target).toLowerCase() === ZERO_ADDR) return;
    if (String(contracts.pepeClaim.target).toLowerCase()  === ZERO_ADDR) return;
    const [balR, claimedR, amountR, kycR, poolR] = await Promise.allSettled([
      contracts.pepeToken.balanceOf(wallet.address),
      contracts.pepeClaim.claimed(wallet.address),
      contracts.pepeClaim.claimAmount(),
      contracts.kycRegistry.isVerified(wallet.address),
      contracts.pepeToken.balanceOf(contracts.pepeClaim.target),
    ]);
    if (balR.status     === 'fulfilled') setPepeBal(balR.value as bigint);
    if (claimedR.status === 'fulfilled') setPepeClaimed(claimedR.value as boolean);
    if (amountR.status  === 'fulfilled') setPepeAmount(amountR.value as bigint);
    // Fail closed: an unreadable registry means we cannot confirm eligibility,
    // which is not the same as being eligible.
    setPepeKyc(kycR.status === 'fulfilled' ? Boolean(kycR.value) : false);
    if (poolR.status    === 'fulfilled') setPepePoolBal(poolR.value as bigint);
  }, [contracts, wallet.address]);

  useEffect(() => {
    void fetchPepe();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void fetchPepe();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [fetchPepe]);

  const doClaimPepe = useCallback(async () => {
    if (!contracts) return;
    setClaimLoading(true);
    setClaimError(null);
    try {
      const tx = await contracts.pepeClaim.claim();
      await (tx as { wait: () => Promise<unknown> }).wait();
      await fetchPepe();
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      const match = raw.match(/revert[^"]*"([^"]+)"/) ?? raw.match(/"([^"]+)"/);
      setClaimError(match ? match[1] : raw.slice(0, 100));
    } finally {
      setClaimLoading(false);
    }
  }, [contracts, fetchPepe]);

  // 位址一定要跟著目前這條鏈走。舊版寫死 Sepolia 的 PepeToken，Base 使用者
  // 加進 MetaMask 的是另一條鏈上的合約，餘額永遠 0 而且看不出原因。
  const addPepeToWallet = async () => {
    if (!window.ethereum || !contracts) return;
    const pepeAddr = String(contracts.pepeToken.target);
    if (!isDeployed(pepeAddr)) {
      // 搬家前這裡用的是 DashboardPage 的 toast。這個元件沒有那個 toast，
      // 訊息就顯示在自己身上——沉默地什麼都不做才是最糟的選項。
      setWatchError(t.rewards.pepeToken.notDeployed);
      return;
    }
    setWatchError(null);
    try {
      await window.ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: { address: pepeAddr, symbol: 'PEPE', decimals: 18 },
        },
      });
    } catch (e) { console.error('Add PEPE to wallet failed', e); }
  };

  return (
    <Card
      sx={{
        p: 3,
        background: 'linear-gradient(135deg, rgba(0, 167, 111, 0.08), rgba(0, 167, 111, 0.01))',
        borderColor: 'rgba(0, 167, 111, 0.2)',
        borderWidth: 1,
        borderStyle: 'solid',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="overline" sx={{ color: 'primary.main', fontWeight: 'bold', display: 'block', letterSpacing: 1 }}>
            {t.rewards.pepeToken.label}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {t.rewards.pepeToken.subtitle}
          </Typography>
        </Box>
        {pepeReady && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Button
              size="small"
              variant="text"
              color="info"
              onClick={() => void addPepeToWallet()}
              startIcon={<Icon icon="solar:wallet-bold-duotone" />}
              sx={{ textTransform: 'none', fontSize: '0.75rem', fontWeight: 'bold' }}
            >
              {t.rewards.pepeToken.addToWallet}
            </Button>
            <IconButton
              size="small"
              onClick={() => void fetchPepe()}
              color="inherit"
              aria-label={t.rewards.pepeToken.reloadAria}
            >
              <Icon icon="solar:restart-bold-duotone" width={16} />
            </IconButton>
          </Box>
        )}
      </Box>

      {watchError && (
        <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 'bold' }}>
          {watchError}
        </Typography>
      )}

      {!pepeReady ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1, fontStyle: 'italic' }}>
          {t.rewards.pepeToken.notAvailable}
        </Typography>
      ) : pepeBal === null ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
          <Box>
            <Typography variant="overline" color="text.secondary" display="block">{t.rewards.pepeToken.balance}</Typography>
            <Skeleton width={120} height={32} />
          </Box>
          <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />
          <Box>
            <Typography variant="overline" color="text.secondary" display="block">{t.rewards.pepeToken.airdrop}</Typography>
            <Skeleton width={160} height={40} />
          </Box>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
          {/* Balance */}
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', fontWeight: 'bold', display: 'block' }}>
              {t.rewards.pepeToken.balance}
            </Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, color: 'primary.light', fontFamily: MONO, mt: 0.5 }}>
              {(Number(pepeBal) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 })}{' '}
              <Typography component="span" variant="subtitle2" color="text.secondary">PEPE</Typography>
            </Typography>
          </Box>

          <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' }, borderColor: 'rgba(0, 167, 111, 0.15)' }} />

          {/* Claim */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', fontWeight: 'bold', display: 'block', mb: 0.5 }}>
              {t.rewards.pepeToken.airdrop}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
              {pepeClaimed ? (
                <Chip
                  label={t.rewards.pepeToken.claimed}
                  color="success"
                  variant="outlined"
                  sx={{ fontWeight: 'bold', px: 1, height: 38, borderRadius: 1 }}
                />
              ) : pepePoolBal !== null && pepePoolBal < pepeAmount ? (
                <Button
                  disabled
                  variant="contained"
                  color="inherit"
                  sx={{ py: 1, px: 3, fontWeight: 'bold', borderRadius: 1 }}
                >
                  {t.rewards.pepeToken.poolEmpty}
                </Button>
              ) : (
                <Button
                  variant="contained"
                  color="primary"
                  onClick={() => void doClaimPepe()}
                  disabled={claimLoading || !pepeKyc}
                  title={!pepeKyc ? t.rewards.pepeToken.kycTooltip : undefined}
                  startIcon={claimLoading ? <Icon icon="line-md:loading-twotone-loop" /> : <span>🐸</span>}
                  sx={{
                    py: 1,
                    px: 3,
                    fontWeight: 'bold',
                    borderRadius: 1,
                    bgcolor: 'primary.main',
                    boxShadow: '0 8px 16px 0 rgba(0, 167, 111, 0.2)',
                    '&:hover': { bgcolor: 'primary.dark' },
                  }}
                >
                  {claimLoading
                    ? t.rewards.pepeToken.claiming
                    : interpolate(t.rewards.pepeToken.claim, { amount: (Number(pepeAmount) / 1e18).toLocaleString() })}
                </Button>
              )}

              {!pepeKyc && !pepeClaimed && !(pepePoolBal !== null && pepePoolBal < pepeAmount) && (
                <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 'bold' }}>
                  {t.rewards.pepeToken.kycRequired}
                </Typography>
              )}
            </Box>
            {claimError && (
              <Typography variant="caption" color="error" sx={{ fontWeight: 'bold', mt: 0.5 }}>
                {claimError}
              </Typography>
            )}
          </Box>
        </Box>
      )}
    </Card>
  );
}

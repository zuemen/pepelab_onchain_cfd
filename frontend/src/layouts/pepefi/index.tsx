import { useEffect } from 'react';
import { Outlet, useNavigate, useOutletContext } from 'react-router';

import Box from '@mui/material/Box';

import { usePathname } from 'src/routes/hooks';

import { type WalletAPI } from 'src/hooks/useWallet';

import { useWalletContext } from 'src/contexts/wallet-context';
import { CHAIN_NAMES, isPrimaryChain, PRIMARY_CHAIN_ID } from 'src/contracts/addresses';

import { LoadingScreen } from 'src/components/loading-screen';

// ----------------------------------------------------------------------
// PepefiLayout: 只呼叫一次 useWallet()，透過 outlet context 傳給所有子頁面
//
// Wallet gate:
//   - 未連錢包 → 只能停留在 PUBLIC_PATHS（landing / x402 docs / marketplace），
//     其他內頁一律導回 landing。
//   - 已連錢包 → 停在 landing 時自動進入 app（AFTER_CONNECT_PATH）。
//   - 刷新頁面時 useWallet 會先做靜默 session 恢復（initializing），
//     守衛等它完成才判斷，避免已連線用戶刷新內頁被誤踢回 landing。

// TODO(fix/gamefi): '/pepe' is public only so the lab can be worked on without
// a wallet. REMOVE IT before this branch merges — the page spends PEPE.
const PUBLIC_PATHS = ['/', '/x402', '/marketplace', '/pepe'];
const AFTER_CONNECT_PATH = '/dashboard';

export function PepefiLayout() {
  const wallet = useWalletContext();
  const pathname = usePathname();
  const navigate = useNavigate();

  useEffect(() => {
    if (wallet.initializing) return;
    const isPublic = PUBLIC_PATHS.includes(pathname);
    if (!wallet.isConnected && !isPublic) {
      navigate('/', { replace: true });
    } else if (wallet.isConnected && pathname === '/') {
      navigate(AFTER_CONNECT_PATH, { replace: true });
    }
  }, [wallet.initializing, wallet.isConnected, pathname, navigate]);

  if (wallet.initializing) return <LoadingScreen />;

  return (
    // 讓 MUI theme 的 dark mode 控制背景色
    <Box sx={{ minHeight: '100%', bgcolor: 'background.default', color: 'text.primary' }}>
      {/* Skip link. The app rendered no landmarks at all — 0 <main>, 0 <nav> —
          so a keyboard or screen-reader user had no way past the header on
          every single page; they tabbed through it again on each navigation.
          Visually hidden until focused, which is the point: it appears for the
          people who need it and stays out of the way for everyone else. */}
      <Box
        component="a"
        href="#main-content"
        sx={{
          position: 'absolute',
          left: 8,
          top: -60,
          zIndex: (theme) => theme.zIndex.modal + 1,
          px: 2,
          py: 1.25,
          borderRadius: 1,
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          fontWeight: 700,
          textDecoration: 'none',
          transition: 'top 150ms ease-out',
          '&:focus': { top: 8 },
        }}
      >
        跳到主要內容
      </Box>

      <ChainNotice chainId={wallet.chainId} />

      <Box component="main" id="main-content" tabIndex={-1} sx={{ outline: 'none' }}>
        <Outlet context={wallet} />
      </Box>
    </Box>
  );
}

/**
 * 連到非正式鏈時的一行說明。
 *
 * 兩條鏈不是彼此的鏡像：交易引擎、agent session、x402 只在 Base Sepolia；
 * 代幣化資產層與 V2 硬化金庫只在 Sepolia。先前 UI 沒有任何統一說明，使用者站在
 * 哪一邊只能從「某個頁面突然說本網路未部署」反推。與其讓半個產品靜默消失，
 * 不如直接說現在站在哪裡、少了什麼。
 */
function ChainNotice({ chainId }: { chainId: number | null }) {
  if (chainId === null || isPrimaryChain(chainId)) return null;

  const known = CHAIN_NAMES[chainId];
  return (
    <Box
      role="status"
      sx={{
        px: 2,
        py: 1,
        fontSize: 13,
        textAlign: 'center',
        bgcolor: 'warning.lighter',
        color: 'warning.darker',
        borderBottom: (theme) => `1px solid ${theme.palette.warning.light}`,
      }}
    >
      目前連線於 <b>{known ?? `chainId ${chainId}`}</b>。正式部署鏈是{' '}
      <b>Base Sepolia（{PRIMARY_CHAIN_ID}）</b> —— 交易、agent session 與 x402 只在那裡。
      {chainId === 11155111 && '　Sepolia 保留的是代幣化資產與 V2 金庫展示。'}
    </Box>
  );
}

// 子頁面用這個 hook 拿 wallet（不需要 props 傳遞）
export function usePepefiWallet(): WalletAPI {
  return useOutletContext<WalletAPI>();
}

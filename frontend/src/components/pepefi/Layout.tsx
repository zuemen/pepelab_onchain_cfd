import type { ReactNode } from 'react';
import type { WalletAPI } from 'src/hooks/useWallet';
import type { WhaleAlert } from 'src/hooks/useWhaleAlerts';

import { useState } from 'react';
import { Link as RouterLink, useLocation } from 'react-router';

import Box from '@mui/material/Box';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';
import { Icon } from '@iconify/react';

import { CHAIN_NAMES, getAddresses } from 'src/contracts/addresses';

import WalletButton from './WalletButton';
import WhaleAlertBanner from './WhaleAlertBanner';

const DEMO_OWNER = '0xE80A81360608C1342e66743F70a00f75d792Eb93';

const NAV = [
  { to: '/',            label: 'Home',          icon: 'solar:home-2-bold-duotone' },
  { to: '/dashboard',   label: 'Dashboard',     icon: 'solar:chart-2-bold-duotone' },
  { to: '/exchange',    label: 'Exchange',       icon: 'solar:transfer-horizontal-bold-duotone' },
  { to: '/trader',      label: 'Trader',         icon: 'solar:user-bold-duotone' },
  { to: '/stake',       label: 'Stake',          icon: 'solar:safe-2-bold-duotone' },
  { to: '/marketplace', label: 'Marketplace',    icon: 'solar:shop-bold-duotone' },
  { to: '/esg',         label: 'ESG Explorer',   icon: 'solar:leaf-bold-duotone' },
  { to: '/portfolio',   label: 'Portfolio',      icon: 'solar:wallet-2-bold-duotone' },
  { to: '/vault',       label: 'LP Vault',       icon: 'solar:bank-bold-duotone' },
  { to: '/history',     label: 'History',        icon: 'solar:history-bold-duotone' },
  { to: '/whale',       label: 'Whale Tracker',  icon: 'solar:globus-bold-duotone' },
];

const ADMIN_NAV = [
  { to: '/admin/oracle',   label: 'Oracle & Keeper', icon: 'solar:settings-bold-duotone' },
  { to: '/admin/treasury', label: 'Cash Out',        icon: 'solar:case-bold-duotone' },
];

const PAGE_TITLES: Record<string, string> = {
  '/':               'Home',
  '/dashboard':      'Dashboard',
  '/exchange':       'Exchange',
  '/trader':         'Trader Dashboard',
  '/stake':          'Trader Stake',
  '/marketplace':    'Marketplace',
  '/esg':            'ESG Explorer',
  '/portfolio':      'Portfolio',
  '/vault':          'LP Vault',
  '/history':        'Transaction History',
  '/whale':          'Whale Tracker',
  '/admin/oracle':   'Oracle Admin',
  '/admin/treasury': 'Treasury Admin',
};

interface Props {
  wallet:         WalletAPI;
  children:       ReactNode;
  isKYCVerified?: boolean;
  whaleAlerts?:   WhaleAlert[];
}

const DRAWER_WIDTH = 260;

export default function Layout({ wallet, children, isKYCVerified, whaleAlerts }: Props) {
  const { pathname } = useLocation();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('disclaimer-dismissed') === '1'
  );
  const [demoDismissed, setDemoDismissed] = useState(
    () => localStorage.getItem('demo-banner-dismissed') === '1'
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  const addresses   = getAddresses(wallet.chainId);
  const isOwner     = wallet.address?.toLowerCase() === DEMO_OWNER.toLowerCase();
  const showDemoBanner = isOwner && !demoDismissed;

  const chainLabel = wallet.chainId !== null
    ? (CHAIN_NAMES[wallet.chainId] ?? `Chain ${wallet.chainId}`)
    : null;

  const chainBadgeColor = wallet.chainId === 31337
    ? 'success'
    : wallet.chainId === 11155111
      ? 'warning'
      : 'error';

  const pageTitle = PAGE_TITLES[pathname]
    ?? (pathname.startsWith('/trader/') ? 'Trader Profile'
      : pathname.startsWith('/copy/')   ? 'Copy Trader'
      : 'PepeFi CFD');

  const switchToAnvil = async () => {
    const eth = (window as any).ethereum;
    if (!eth) return;
    setSwitching(true);
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] });
    } catch (err: any) {
      if (err.code === -32002) {
        /* pending — ignore */
      } else if (err.code === 4902) {
        try {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0x7a69',
              chainName: 'Anvil Local',
              rpcUrls: ['http://localhost:8545'],
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            }],
          });
        } catch { /* user rejected */ }
      }
    } finally {
      setSwitching(false);
    }
  };

  const switchToSepolia = async () => {
    const eth = (window as any).ethereum;
    if (!eth) return;
    setSwitching(true);
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
    } catch (err: any) {
      if (err.code === -32002) {
        /* pending — ignore */
      } else if (err.code === 4902) {
        try {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0xaa36a7',
              chainName: 'Sepolia Testnet',
              rpcUrls: ['https://sepolia.infura.io/v3/'],
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              blockExplorerUrls: ['https://sepolia.etherscan.io'],
            }],
          });
        } catch { /* user rejected */ }
      }
    } finally {
      setSwitching(false);
    }
  };

  const renderSidebarContent = () => (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.neutral' }}>
      {/* Header */}
      <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="h5" sx={{ fontWeight: 800, color: 'primary.main', letterSpacing: 0.5 }}>
          PepeFi
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 'medium' }}>
          On-Chain CFD · PoC
        </Typography>
      </Box>

      {/* Nav */}
      <Box sx={{ flexGrow: 1, overflowY: 'auto', px: 1.5, py: 2 }}>
        <List disablePadding>
          {NAV.map(({ to, label, icon }) => {
            const active = pathname === to || (to !== '/' && pathname.startsWith(to));
            return (
              <ListItemButton
                key={to}
                component={RouterLink}
                to={to}
                onClick={() => setMobileOpen(false)}
                selected={active}
                sx={{
                  borderRadius: 1,
                  mb: 0.5,
                  py: 1,
                  px: 1.5,
                  color: active ? 'primary.main' : 'text.secondary',
                  bgcolor: active ? 'rgba(0, 167, 111, 0.08)' : 'transparent',
                  fontWeight: active ? 'bold' : 'medium',
                  '&.Mui-selected': {
                    bgcolor: 'rgba(0, 167, 111, 0.12)',
                    '&:hover': {
                      bgcolor: 'rgba(0, 167, 111, 0.18)',
                    },
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 32, color: active ? 'primary.main' : 'text.secondary' }}>
                  <Icon icon={icon} width={20} height={20} />
                </ListItemIcon>
                <ListItemText
                  primary={label}
                  primaryTypographyProps={{
                    variant: 'body2',
                    fontWeight: active ? 'bold' : 'medium',
                  }}
                />
              </ListItemButton>
            );
          })}

          {/* Admin section */}
          {isOwner ? (
            <>
              <Typography
                variant="overline"
                sx={{
                  display: 'block',
                  px: 1.5,
                  pt: 2,
                  pb: 0.5,
                  color: 'text.secondary',
                  fontWeight: 'bold',
                }}
              >
                Admin
              </Typography>
              {ADMIN_NAV.map(({ to, label, icon }) => {
                const active = pathname === to;
                return (
                  <ListItemButton
                    key={to}
                    component={RouterLink}
                    to={to}
                    onClick={() => setMobileOpen(false)}
                    selected={active}
                    sx={{
                      borderRadius: 1,
                      mb: 0.5,
                      py: 1,
                      px: 1.5,
                      color: active ? 'primary.main' : 'text.secondary',
                      bgcolor: active ? 'rgba(0, 167, 111, 0.08)' : 'transparent',
                      fontWeight: active ? 'bold' : 'medium',
                      '&.Mui-selected': {
                        bgcolor: 'rgba(0, 167, 111, 0.12)',
                        '&:hover': {
                          bgcolor: 'rgba(0, 167, 111, 0.18)',
                        },
                      },
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 32, color: active ? 'primary.main' : 'text.secondary' }}>
                      <Icon icon={icon} width={20} height={20} />
                    </ListItemIcon>
                    <ListItemText
                      primary={label}
                      primaryTypographyProps={{
                        variant: 'body2',
                        fontWeight: active ? 'bold' : 'medium',
                      }}
                    />
                  </ListItemButton>
                );
              })}
            </>
          ) : (
            <ListItemButton
              component={RouterLink}
              to="/pepefi/admin/oracle"
              onClick={() => setMobileOpen(false)}
              selected={pathname.startsWith('/admin')}
              sx={{
                borderRadius: 1,
                mt: 1,
                py: 1,
                px: 1.5,
                color: pathname.startsWith('/admin') ? 'primary.main' : 'text.secondary',
                bgcolor: pathname.startsWith('/admin') ? 'rgba(0, 167, 111, 0.08)' : 'transparent',
                fontWeight: pathname.startsWith('/admin') ? 'bold' : 'medium',
                '&.Mui-selected': {
                  bgcolor: 'rgba(0, 167, 111, 0.12)',
                  '&:hover': {
                    bgcolor: 'rgba(0, 167, 111, 0.18)',
                  },
                },
              }}
            >
              <ListItemIcon sx={{ minWidth: 32, color: pathname.startsWith('/admin') ? 'primary.main' : 'text.secondary' }}>
                <Icon icon="solar:settings-bold-duotone" width={20} height={20} />
              </ListItemIcon>
              <ListItemText
                primary="Admin"
                primaryTypographyProps={{
                  variant: 'body2',
                  fontWeight: pathname.startsWith('/admin') ? 'bold' : 'medium',
                }}
              />
            </ListItemButton>
          )}
        </List>
      </Box>

      {/* Footer Info */}
      <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {chainLabel && (
          <Chip
            label={chainLabel}
            color={chainBadgeColor}
            size="small"
            variant="outlined"
            icon={
              <Box
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  bgcolor: 'currentColor',
                }}
              />
            }
            sx={{ alignSelf: 'flex-start' }}
          />
        )}
        {wallet.isConnected && isKYCVerified !== undefined && (
          <Chip
            label={`KYC ${isKYCVerified ? '已驗證' : '未驗證'}`}
            color={isKYCVerified ? 'success' : 'default'}
            size="small"
            variant="outlined"
            icon={
              <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem' }}>
                {isKYCVerified ? '✓' : '?'}
              </Box>
            }
            sx={{ alignSelf: 'flex-start' }}
          />
        )}
        <Box sx={{ mt: 1 }}>
          <WalletButton wallet={wallet} />
        </Box>
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default', color: 'text.primary' }}>
      {/* Drawer navigation */}
      <Box
        component="nav"
        sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}
      >
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            display: { xs: 'block', md: 'none' },
            '& .MuiDrawer-paper': { boxSizing: 'border-box', width: DRAWER_WIDTH, borderRight: '1px solid', borderColor: 'divider' },
          }}
        >
          {renderSidebarContent()}
        </Drawer>

        <Drawer
          variant="permanent"
          sx={{
            display: { xs: 'none', md: 'block' },
            '& .MuiDrawer-paper': { boxSizing: 'border-box', width: DRAWER_WIDTH, borderRight: '1px solid', borderColor: 'divider' },
          }}
          open
        >
          {renderSidebarContent()}
        </Drawer>
      </Box>

      {/* Main Content Pane */}
      <Box sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
        {!dismissed && (
          <Alert
            severity="info"
            variant="filled"
            onClose={() => {
              setDismissed(true);
              localStorage.setItem('disclaimer-dismissed', '1');
            }}
            sx={{
              borderRadius: 0,
              bgcolor: 'rgba(255, 171, 0, 0.12)',
              color: 'warning.main',
              '& .MuiAlert-icon': { color: 'warning.main' },
              '& .MuiAlert-message': { py: 0, fontSize: '0.75rem' },
            }}
          >
            Research prototype · NCCU Capstone 2026 · No real assets · 僅供學術展示，非投資建議
          </Alert>
        )}

        {/* Whale alerts */}
        {whaleAlerts && whaleAlerts.length > 0 && (
          <WhaleAlertBanner alerts={whaleAlerts} />
        )}

        {/* Demo banner */}
        {showDemoBanner && (
          <Alert
            severity="success"
            variant="filled"
            onClose={() => {
              setDemoDismissed(true);
              localStorage.setItem('demo-banner-dismissed', '1');
            }}
            sx={{
              borderRadius: 0,
              bgcolor: 'rgba(0, 167, 111, 0.12)',
              color: 'primary.main',
              '& .MuiAlert-icon': { color: 'primary.main' },
              '& .MuiAlert-message': { py: 0, fontSize: '0.75rem' },
            }}
          >
            🎬 Live demo mode — admin auto-keeper running, prices update every 60s
          </Alert>
        )}

        {/* Header / Top bar */}
        <AppBar
          position="sticky"
          color="default"
          elevation={0}
          sx={{
            borderBottom: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.paper',
            backgroundImage: 'none',
          }}
        >
          <Toolbar sx={{ px: { xs: 2, md: 3 } }}>
            <IconButton
              color="inherit"
              aria-label="open drawer"
              edge="start"
              onClick={() => setMobileOpen(true)}
              sx={{ mr: 2, display: { md: 'none' } }}
            >
              <Icon icon="solar:menu-hamburger-bold-duotone" width={24} height={24} />
            </IconButton>

            <Typography variant="subtitle1" sx={{ fontWeight: 'bold', flexGrow: 1 }}>
              {pageTitle}
            </Typography>

            {wallet.isConnected && (
              <Box sx={{ display: { xs: 'none', sm: 'flex' }, gap: 1 }}>
                {wallet.chainId !== 11155111 && (
                  <Button
                    size="small"
                    variant="outlined"
                    color="warning"
                    onClick={() => void switchToSepolia()}
                    disabled={switching}
                    sx={{ textTransform: 'none', fontWeight: 'bold' }}
                  >
                    {switching ? '…' : 'Sepolia'}
                  </Button>
                )}
                {import.meta.env.DEV && wallet.chainId !== 31337 && (
                  <Button
                    size="small"
                    variant="outlined"
                    color="success"
                    onClick={() => void switchToAnvil()}
                    disabled={switching}
                    sx={{ textTransform: 'none', fontWeight: 'bold' }}
                  >
                    {switching ? '…' : 'Anvil'}
                  </Button>
                )}
              </Box>
            )}
          </Toolbar>
        </AppBar>

        {/* Page content */}
        <Box sx={{ flexGrow: 1, p: { xs: 2, md: 3 } }}>
          {children}
        </Box>

        {/* Footer */}
        <Box
          component="footer"
          sx={{
            py: 2,
            px: 3,
            borderTop: '1px solid',
            borderColor: 'divider',
            textAlign: 'center',
            color: 'text.secondary',
            fontSize: '0.75rem',
          }}
        >
          <Typography variant="caption" color="text.secondary">
            PepeFi · Research prototype · Sepolia ·{' '}
            {addresses?.PerpetualExchange && wallet.chainId === 11155111 && (
              <>
                <Link
                  href={`https://sepolia.etherscan.io/address/${addresses.PerpetualExchange}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  color="primary"
                  sx={{ mx: 0.5 }}
                >
                  Exchange ↗
                    </Link>{' '}
                ·{' '}
              </>
            )}
            <Link
              href="https://github.com/zuemen/pepelab_onchain_cfd"
              target="_blank"
              rel="noopener noreferrer"
              color="primary"
              sx={{ mx: 0.5 }}
            >
              GitHub ↗
            </Link>
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}

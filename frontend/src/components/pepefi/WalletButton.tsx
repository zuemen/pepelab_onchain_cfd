import type { WalletAPI } from 'src/hooks/useWallet';

import { useLocation, useNavigate } from 'react-router';
import { useState, useEffect } from 'react';

import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Stack from '@mui/material/Stack';
import Link from '@mui/material/Link';
import Card from '@mui/material/Card';
import IconButton from '@mui/material/IconButton';
import { Icon } from '@iconify/react';

interface Props {
  wallet: WalletAPI;
}

export default function WalletButton({ wallet }: Props) {
  const { address, isConnected, isConnecting, error, connect, connectMock, disconnect, switchAccount } = wallet;
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const open = Boolean(anchorEl);

  const { pathname } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (isConnected && dialogOpen) {
      setDialogOpen(false);
      if (pathname === '/') {
        navigate('/dashboard', { replace: true });
      }
    }
  }, [isConnected, dialogOpen, pathname, navigate]);

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleOpenDialog = () => {
    setDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
  };

  if (isConnecting) {
    return (
      <Button
        disabled
        variant="outlined"
        color="inherit"
        startIcon={<CircularProgress size={16} color="inherit" />}
        sx={{ borderRadius: 50, px: 2.5 }}
      >
        Connecting…
      </Button>
    );
  }

  if (isConnected && address) {
    const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
    return (
      <Box>
        <Button
          variant="outlined"
          color="inherit"
          onClick={handleClick}
          startIcon={
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: 'success.main',
                boxShadow: (theme) => `0 0 8px ${theme.palette.success.main}`,
              }}
            />
          }
          endIcon={
            <Icon
              icon={open ? 'eva:chevron-up-fill' : 'eva:chevron-down-fill'}
              width={16}
              height={16}
            />
          }
          sx={{
            borderRadius: 50,
            px: 2,
            fontFamily: 'monospace',
            borderColor: 'divider',
            textTransform: 'none',
            '&:hover': {
              borderColor: 'text.secondary',
            },
          }}
        >
          {short}
        </Button>

        <Menu
          anchorEl={anchorEl}
          open={open}
          onClose={handleClose}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          slotProps={{
            paper: {
              sx: {
                mt: 1,
                width: 220,
                borderRadius: 1.5,
                boxShadow: (theme) => theme.shadows[16],
                border: '1px solid',
                borderColor: 'divider',
              },
            },
          }}
        >
          <Box sx={{ px: 2, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" display="block">
              Connected Wallet
            </Typography>
            <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.primary', wordBreak: 'break-all' }}>
              {address}
            </Typography>
          </Box>
          <MenuItem
            onClick={() => {
              handleClose();
              void switchAccount();
            }}
            sx={{ py: 1, fontSize: '0.875rem' }}
          >
            <Icon icon="eva:swap-fill" width={18} height={18} style={{ marginRight: 8 }} />
            Switch Account
          </MenuItem>
          <MenuItem
            onClick={() => {
              handleClose();
              disconnect();
            }}
            sx={{
              py: 1,
              fontSize: '0.875rem',
              color: 'error.main',
              '&:hover': {
                bgcolor: 'rgba(255, 86, 48, 0.08)',
              },
            }}
          >
            <Icon icon="eva:log-out-fill" width={18} height={18} style={{ marginRight: 8 }} />
            Disconnect
          </MenuItem>
        </Menu>
      </Box>
    );
  }

  const isMetaMaskAvailable = typeof window !== 'undefined' && !!window.ethereum;

  return (
    <>
      <Button
        variant="contained"
        color="primary"
        onClick={handleOpenDialog}
        startIcon={<Icon icon="eva:diagonal-arrow-right-up-fill" width={18} height={18} />}
        sx={{
          borderRadius: 50,
          px: 3,
          py: 1,
          fontWeight: 'bold',
          fontSize: '1rem',
          boxShadow: '0 8px 16px 0 rgba(0, 167, 111, 0.24)',
        }}
      >
        Connect Wallet
      </Button>

      <Dialog
        open={dialogOpen}
        onClose={handleCloseDialog}
        maxWidth="xs"
        fullWidth
        slotProps={{
          paper: {
            sx: {
              borderRadius: 2.5,
              bgcolor: 'background.paper',
              border: '1px solid',
              borderColor: 'divider',
              p: 1.5,
            },
          },
        }}
      >
        <DialogTitle sx={{ m: 0, p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h5" sx={{ fontWeight: 800, background: 'linear-gradient(90deg, #34d399 0%, #a3e635 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            連接帳號 / Connect Wallet
          </Typography>
          <IconButton onClick={handleCloseDialog} size="small" sx={{ color: 'text.secondary' }}>
            <Icon icon="mingcute:close-line" width={20} height={20} />
          </IconButton>
        </DialogTitle>

        <DialogContent sx={{ p: 2, pt: 0 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            選擇您的登入通道以進入 PepeLab 鏈上衍生品系統。
          </Typography>

          <Stack spacing={2}>
            {/* 1. MetaMask Real Web3 Connection */}
            <Card
              onClick={() => void connect()}
              sx={{
                p: 2.5,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: 'rgba(255, 255, 255, 0.01)',
                transition: 'all 0.2s',
                '&:hover': {
                  borderColor: '#f6851b',
                  bgcolor: 'rgba(246, 133, 27, 0.05)',
                  boxShadow: '0 0 16px rgba(246, 133, 27, 0.15)',
                },
              }}
            >
              <Box sx={{ bgcolor: 'rgba(246, 133, 27, 0.1)', p: 1.2, borderRadius: '50%', display: 'flex' }}>
                <Icon icon="logos:metamask-icon" width={32} height={32} />
              </Box>
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: 'text.primary' }}>
                  MetaMask 錢包連線
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  透過 MetaMask 瀏覽器擴充功能連線 (Base Sepolia)
                </Typography>
              </Box>
            </Card>

            {/* Error handling helper if MetaMask is missing or rejected */}
            {error && (
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 1,
                  bgcolor: 'rgba(255, 86, 48, 0.08)',
                  border: '1px solid',
                  borderColor: 'rgba(255, 86, 48, 0.2)',
                }}
              >
                <Typography variant="caption" color="error.main" sx={{ display: 'block', fontWeight: 'bold' }}>
                  ⚠️ {error}
                </Typography>
                {!isMetaMaskAvailable && (
                  <Link
                    href="https://metamask.io/download/"
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      mt: 1,
                      fontSize: '0.75rem',
                      color: 'primary.main',
                      fontWeight: 'bold',
                      textDecoration: 'none',
                      '&:hover': { textDecoration: 'underline' },
                    }}
                  >
                    前往安裝 MetaMask 擴充功能 ↗
                  </Link>
                )}
              </Box>
            )}

            {/* 2. Mock Presentation Connection */}
            <Card
              onClick={connectMock}
              sx={{
                p: 2.5,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                border: '1px solid',
                borderColor: 'rgba(52, 211, 153, 0.2)',
                bgcolor: 'rgba(52, 211, 153, 0.02)',
                transition: 'all 0.2s',
                '&:hover': {
                  borderColor: '#34d399',
                  bgcolor: 'rgba(52, 211, 153, 0.08)',
                  boxShadow: '0 0 16px rgba(52, 211, 153, 0.25)',
                },
              }}
            >
              <Box sx={{ bgcolor: 'rgba(52, 211, 153, 0.15)', p: 1.2, borderRadius: '50%', display: 'flex', color: '#34d399' }}>
                <Icon icon="solar:rocket-bold-duotone" width={32} height={32} />
              </Box>
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: 'primary.main' }}>
                  Pepe 簡報測試通道 (模擬 Web3)
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  無須錢包即可一鍵進入系統、切換 Pepe 蛙頭像與測試跟單
                </Typography>
              </Box>
            </Card>
          </Stack>
        </DialogContent>
      </Dialog>
    </>
  );
}

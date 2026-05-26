import type { WalletAPI } from 'src/hooks/useWallet';

import { useState } from 'react';

import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { Icon } from '@iconify/react';

interface Props {
  wallet: WalletAPI;
}

export default function WalletButton({ wallet }: Props) {
  const { address, isConnected, isConnecting, connect, disconnect, switchAccount } = wallet;
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
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

  return (
    <Button
      variant="contained"
      color="primary"
      onClick={() => void connect()}
      startIcon={<Icon icon="eva:diagonal-arrow-right-up-fill" width={18} height={18} />}
      sx={{
        borderRadius: 50,
        px: 2.5,
        fontWeight: 'bold',
        boxShadow: '0 8px 16px 0 rgba(0, 167, 111, 0.24)',
      }}
    >
      Connect Wallet
    </Button>
  );
}

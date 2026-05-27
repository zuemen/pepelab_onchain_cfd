import type { IconButtonProps } from '@mui/material/IconButton';

import { useState, useEffect } from 'react';
import { useBoolean } from 'minimal-shared/hooks';

import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import MenuItem from '@mui/material/MenuItem';
import MenuList from '@mui/material/MenuList';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';

import { paths } from 'src/routes/paths';
import { usePathname } from 'src/routes/hooks';
import { RouterLink } from 'src/routes/components';

import { useUserAvatar } from 'src/hooks/useUserAvatar';
import { useDisplayName } from 'src/hooks/useDisplayName';

import { useWalletContext } from 'src/contexts/wallet-context';

import { Label } from 'src/components/label';
import { Iconify } from 'src/components/iconify';
import { Scrollbar } from 'src/components/scrollbar';
import { AnimateBorder } from 'src/components/animate';
import { PepeAvatar } from 'src/components/pepefi/PepeAvatar';
import PepeGameFiModal from 'src/components/pepefi/PepeGameFiModal';

import { useMockedUser } from 'src/auth/hooks';

import { AccountButton } from './account-button';
import { SignOutButton } from './sign-out-button';

// ----------------------------------------------------------------------

export type AccountDrawerProps = IconButtonProps & {
  data?: {
    label: string;
    href: string;
    icon?: React.ReactNode;
    info?: React.ReactNode;
  }[];
};

export function AccountDrawer({ data = [], sx, ...other }: AccountDrawerProps) {
  const pathname = usePathname();

  const { user } = useMockedUser();
  const wallet = useWalletContext();
  const { src: avatarUrl } = useUserAvatar(wallet.address || 'mock_user');

  const { value: open, onFalse: onClose, onTrue: onOpen } = useBoolean();
  const [displayName, saveDisplayName] = useDisplayName(wallet.address || 'mock_user');
  const [nameInput, setNameInput] = useState('');
  useEffect(() => { if (open) setNameInput(displayName); }, [open, displayName]);

  const [gamefiOpen, setGamefiOpen] = useState(false);
  const [gamefiTab, setGamefiTab] = useState<'breed' | 'potions' | 'wardrobe'>('breed');

  const renderAvatar = () => (
    <AnimateBorder
      sx={{ mb: 2, p: '6px', width: 96, height: 96, borderRadius: '50%' }}
      slotProps={{
        primaryBorder: { size: 120, sx: { color: 'primary.main' } },
      }}
    >
      <PepeAvatar address={wallet.address || 'mock_user'} size={84} editable />
    </AnimateBorder>
  );

  const renderList = () => (
    <MenuList
      disablePadding
      sx={[
        (theme) => ({
          py: 3,
          px: 2.5,
          borderTop: `dashed 1px ${theme.vars.palette.divider}`,
          borderBottom: `dashed 1px ${theme.vars.palette.divider}`,
          '& li': { p: 0 },
        }),
      ]}
    >
      {data.map((option) => {
        const rootLabel = pathname.includes('/dashboard') ? 'Home' : 'Dashboard';
        const rootHref = pathname.includes('/dashboard') ? '/' : paths.dashboard.root;

        // Dynamic profile link
        let targetHref = option.href;
        if (option.label.includes('Profile') && wallet.address) {
          targetHref = `/trader/${wallet.address}`;
        }

        const isGamefi = option.href.startsWith('#gamefi-');

        const handleClick = (e: React.MouseEvent) => {
          if (isGamefi) {
            e.preventDefault();
            const tab = option.href.replace('#gamefi-', '') as 'breed' | 'potions' | 'wardrobe';
            setGamefiTab(tab);
            setGamefiOpen(true);
            onClose(); // Close drawer
          } else {
            onClose();
          }
        };

        return (
          <MenuItem key={option.label}>
            <Link
              {...(isGamefi ? {} : { component: RouterLink })}
              href={isGamefi ? '#' : (option.label === 'Home' ? rootHref : targetHref)}
              onClick={handleClick}
              color="inherit"
              underline="none"
              sx={{
                p: 1,
                width: 1,
                display: 'flex',
                typography: 'body2',
                alignItems: 'center',
                color: 'text.secondary',
                '& svg': { width: 24, height: 24 },
                '&:hover': { color: 'text.primary' },
                cursor: 'pointer',
              }}
            >
              {option.icon}

              <Box component="span" sx={{ ml: 2 }}>
                {option.label === 'Home' ? rootLabel : option.label}
              </Box>

              {option.info && (
                <Label color="error" sx={{ ml: 1 }}>
                  {option.info}
                </Label>
              )}
            </Link>
          </MenuItem>
        );
      })}
    </MenuList>
  );

  return (
    <>
      <AccountButton
        onClick={onOpen}
        photoURL={avatarUrl}
        displayName={displayName || user?.displayName || ''}
        sx={sx}
        {...other}
      />

      <Drawer
        open={open}
        onClose={onClose}
        anchor="right"
        slotProps={{
          backdrop: { invisible: true },
          paper: { sx: { width: 320 } },
        }}
      >
        <IconButton
          onClick={onClose}
          sx={{
            top: 12,
            left: 12,
            zIndex: 9,
            position: 'absolute',
          }}
        >
          <Iconify icon="mingcute:close-line" />
        </IconButton>

        <Scrollbar>
          <Box
            sx={{
              pt: 8,
              display: 'flex',
              alignItems: 'center',
              flexDirection: 'column',
            }}
          >
            {renderAvatar()}

            <Typography variant="subtitle1" noWrap sx={{ mt: 2 }}>
              {displayName || (wallet.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : user?.displayName)}
            </Typography>

            <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }} noWrap>
              {wallet.address || user?.email}
            </Typography>
          </Box>



          {/* Edit display name */}
          <Box sx={{ px: 2.5, py: 2 }}>
            <TextField
              label="Display Name (編輯暱稱)"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value.slice(0, 20))}
              size="small"
              fullWidth
              inputProps={{ maxLength: 20 }}
              placeholder={wallet.address ? (wallet.address.slice(0, 6) + '…' + wallet.address.slice(-4)) : 'Enter nickname...'}
            />
            <Button
              variant="contained"
              size="small"
              fullWidth
              sx={{ mt: 1 }}
              disabled={!nameInput.trim() || nameInput.trim() === displayName}
              onClick={() => {
                saveDisplayName(nameInput.trim());
                onClose();
              }}
            >
              Save Name (儲存變更)
            </Button>
          </Box>

          {renderList()}

        </Scrollbar>

        <Box sx={{ p: 2.5 }}>
          <SignOutButton onClose={onClose} />
        </Box>
      </Drawer>

      <PepeGameFiModal
        open={gamefiOpen}
        onClose={() => setGamefiOpen(false)}
        defaultTab={gamefiTab}
      />
    </>
  );
}

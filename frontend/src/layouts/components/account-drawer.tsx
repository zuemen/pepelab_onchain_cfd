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

import { RouterLink } from 'src/routes/components';

import { useDisplayName } from 'src/hooks/useDisplayName';

import { t } from 'src/locales';
import { useWalletContext } from 'src/contexts/wallet-context';

import { Label } from 'src/components/label';
import { Iconify } from 'src/components/iconify';
import { Scrollbar } from 'src/components/scrollbar';
import { AnimateBorder } from 'src/components/animate';
import { PepeAvatar } from 'src/components/pepefi/PepeAvatar';

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
  // 範本原本在這裡掛一個寫死的假使用者（_mock 的示範人物與 email）當作
  // 沒連錢包時的名字與 email。帳戶的唯一身分是連線中的錢包位址；沒連就什麼都不顯示。
  const wallet = useWalletContext();
  const shortAddr = wallet.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : '';

  const { value: open, onFalse: onClose, onTrue: onOpen } = useBoolean();
  const [displayName, saveDisplayName] = useDisplayName(wallet.address);
  const [nameInput, setNameInput] = useState('');
  useEffect(() => { if (open) setNameInput(displayName); }, [open, displayName]);

  const renderAvatar = () => (
    <AnimateBorder
      sx={{ mb: 2, p: '6px', width: 96, height: 96, borderRadius: '50%' }}
      slotProps={{
        primaryBorder: { size: 120, sx: { color: 'primary.main' } },
      }}
    >
      <PepeAvatar address={wallet.address ?? undefined} size={84} editable={!!wallet.address} />
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
      {data.map((option) => (
          <MenuItem key={option.label}>
            <Link
              component={RouterLink}
              href={option.href}
              onClick={onClose}
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
                {option.label}
              </Box>

              {option.info && (
                <Label color="error" sx={{ ml: 1 }}>
                  {option.info}
                </Label>
              )}
            </Link>
          </MenuItem>
      ))}
    </MenuList>
  );

  return (
    <>
      <AccountButton
        onClick={onOpen}
        address={wallet.address}
        displayName={displayName}
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
          aria-label={t.common.account.closeAria}
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
              {displayName || shortAddr || t.common.account.notConnected}
            </Typography>

            <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }} noWrap>
              {wallet.address}
            </Typography>
          </Box>



          {/* Edit display name */}
          <Box sx={{ px: 2.5, py: 2 }}>
            <TextField
              label={t.common.account.displayNameLabel}
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value.slice(0, 20))}
              size="small"
              fullWidth
              inputProps={{ maxLength: 20 }}
              disabled={!wallet.address}
              placeholder={shortAddr || t.common.account.nicknamePlaceholder}
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
              {t.common.account.saveName}
            </Button>
          </Box>

          {renderList()}

        </Scrollbar>

        <Box sx={{ p: 2.5 }}>
          <SignOutButton onClose={onClose} />
        </Box>
      </Drawer>
    </>
  );
}

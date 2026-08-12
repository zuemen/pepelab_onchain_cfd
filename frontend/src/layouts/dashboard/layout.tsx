import type { Breakpoint } from '@mui/material/styles';
import type { NavItemProps, NavSectionProps } from 'src/components/nav-section';
import type { MainSectionProps, HeaderSectionProps, LayoutSectionProps } from '../core';

import { merge } from 'es-toolkit';
import { useBoolean } from 'minimal-shared/hooks';

import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import { iconButtonClasses } from '@mui/material/IconButton';

import { useMode } from 'src/contexts/mode-context';
// Direct module import, not the `src/_mock` barrel. Both values live in
// _others.ts, but the barrel re-exports eleven mock modules, so pulling two
// names from it dragged all of them — assets.ts, _job, _user, _invoice and the
// rest — into the production entry chunk. This layout is part of the app shell,
// so that demo fixture data was being downloaded by every real visitor.
import { _contacts, _notifications } from 'src/_mock/_others';
import { useWalletContext } from 'src/contexts/wallet-context';

import { Logo } from 'src/components/logo';
import { useSettingsContext } from 'src/components/settings';
import WalletButton from 'src/components/pepefi/WalletButton';
import { PepeAvatar } from 'src/components/pepefi/PepeAvatar';
import PaperTradingBadge from 'src/components/pepefi/PaperTradingBadge';

import { useMockedUser } from 'src/auth/hooks';

import { NavMobile } from './nav-mobile';
import { VerticalDivider } from './content';
import { NavVertical } from './nav-vertical';
import { NavHorizontal } from './nav-horizontal';
import { Searchbar } from '../components/searchbar';
import { accountNavData } from '../nav-config-account';
import { MenuButton } from '../components/menu-button';
import { AccountDrawer } from '../components/account-drawer';
import { SettingsButton } from '../components/settings-button';
import { ContactsPopover } from '../components/contacts-popover';
import { dashboardLayoutVars, dashboardNavColorVars } from './css-vars';
import { NotificationsDrawer } from '../components/notifications-drawer';
import { MainSection, layoutClasses, HeaderSection, LayoutSection } from '../core';
import { navDataForMode, navData as dashboardNavData } from '../nav-config-dashboard';

// ----------------------------------------------------------------------

type LayoutBaseProps = Pick<LayoutSectionProps, 'sx' | 'children' | 'cssVars'>;

export type DashboardLayoutProps = LayoutBaseProps & {
  layoutQuery?: Breakpoint;
  slotProps?: {
    header?: HeaderSectionProps;
    nav?: {
      data?: NavSectionProps['data'];
    };
    main?: MainSectionProps;
  };
};

export function DashboardLayout({
  sx,
  cssVars,
  children,
  slotProps,
  layoutQuery = 'lg',
}: DashboardLayoutProps) {
  const theme = useTheme();

  const wallet = useWalletContext();

  const { user } = useMockedUser();

  const settings = useSettingsContext();

  const navVars = dashboardNavColorVars(theme, settings.state.navColor, settings.state.navLayout);

  const { value: open, onFalse: onClose, onTrue: onOpen } = useBoolean();
  const { mode, toggle: toggleMode } = useMode();

  // slotProps override (used by callers that need a custom nav) always wins;
  // otherwise the nav follows the mode. Simple/expert existed as a state
  // before this without ever changing the sidebar — 17 items stayed 17 items
  // regardless of which one was selected.
  const navData = slotProps?.nav?.data ?? navDataForMode(mode);
  const totalNavCount = dashboardNavData.flatMap((section) => section.items).length;

  const isNavMini = settings.state.navLayout === 'mini';
  const isNavHorizontal = settings.state.navLayout === 'horizontal';
  const isNavVertical = isNavMini || settings.state.navLayout === 'vertical';

  const canDisplayItemByRole = (allowedRoles: NavItemProps['allowedRoles']): boolean =>
    !allowedRoles?.includes(user?.role);

  // Collapsing the sidebar in simple mode without saying so would read as
  // "some of my features vanished." This turns the toggle in the header into
  // something the sidebar itself points back to, instead of relying on the
  // user to notice a switch in the corner.
  const renderSimpleModeHint = () =>
    mode === 'simple' ? (
      <Box
        component="button"
        type="button"
        onClick={toggleMode}
        sx={{
          display: 'block',
          width: '100%',
          px: 2.5,
          py: 1.75,
          border: 'none',
          borderTop: '1px dashed',
          borderColor: 'divider',
          bgcolor: 'transparent',
          color: 'text.secondary',
          fontSize: '0.75rem',
          fontWeight: 600,
          textAlign: 'left',
          cursor: 'pointer',
          '&:hover': { color: 'primary.main' },
        }}
      >
        切換到專家模式看全部 {totalNavCount} 個功能 →
      </Box>
    ) : null;

  const renderHeader = () => {
    const headerSlotProps: HeaderSectionProps['slotProps'] = {
      container: {
        maxWidth: false,
        sx: {
          ...(isNavVertical && { px: { [layoutQuery]: 5 } }),
          ...(isNavHorizontal && {
            bgcolor: 'var(--layout-nav-bg)',
            height: { [layoutQuery]: 'var(--layout-nav-horizontal-height)' },
            [`& .${iconButtonClasses.root}`]: { color: 'var(--layout-nav-text-secondary-color)' },
          }),
        },
      },
    };

    const headerSlots: HeaderSectionProps['slots'] = {
      topArea: (
        <Alert severity="info" sx={{ display: 'none', borderRadius: 0 }}>
          This is an info Alert.
        </Alert>
      ),
      bottomArea: isNavHorizontal ? (
        <NavHorizontal
          data={navData}
          layoutQuery={layoutQuery}
          cssVars={navVars.section}
          checkPermissions={canDisplayItemByRole}
        />
      ) : null,
      leftArea: (
        <>
          {/** @slot Nav mobile */}
          <MenuButton
            onClick={onOpen}
            sx={{ mr: 1, ml: -1, [theme.breakpoints.up(layoutQuery)]: { display: 'none' } }}
          />
          <NavMobile
            data={navData}
            open={open}
            onClose={onClose}
            cssVars={navVars.section}
            checkPermissions={canDisplayItemByRole}
            slots={{ bottomArea: renderSimpleModeHint() }}
          />

          {/** @slot Logo */}
          {isNavHorizontal && (
            <Logo
              sx={{
                display: 'none',
                [theme.breakpoints.up(layoutQuery)]: { display: 'inline-flex' },
              }}
            />
          )}

          {/** @slot Divider */}
          {isNavHorizontal && (
            <VerticalDivider sx={{ [theme.breakpoints.up(layoutQuery)]: { display: 'flex' } }} />
          )}


        </>
      ),
      rightArea: (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 0, sm: 0.75 } }}>
          {/** @slot Searchbar */}
          <Searchbar data={navData} />



          {/** @slot Notifications popover */}
          <NotificationsDrawer data={_notifications} />

          {/** @slot Contacts popover */}
          <ContactsPopover data={_contacts} />

          {/** @slot Paper trading notice — always visible, hidden on xs for space */}
          <Box sx={{ display: { xs: 'none', md: 'block' } }}>
            <PaperTradingBadge compact />
          </Box>

          {/** @slot Settings button */}
          <SettingsButton />

          {/** @slot Mode toggle
           *
           * Was `display: { xs: 'none', sm: 'flex' }` on the whole group —
           * on mobile the switch didn't just look different, it wasn't in
           * the DOM at all, so the people the "simple" mode is aimed at were
           * the ones who couldn't reach the control that turns it on. Now
           * only the two Chinese labels hide below `sm` to save width; the
           * Switch itself stays reachable at every breakpoint.
           */}
          <Stack direction="row" alignItems="center" gap={0.5}>
            <Typography
              variant="caption"
              sx={{ display: { xs: 'none', sm: 'block' }, color: mode === 'simple' ? 'primary.main' : 'text.disabled', fontWeight: 700, fontSize: '0.7rem' }}
            >
              簡單
            </Typography>
            <Switch
              checked={mode === 'expert'}
              onChange={toggleMode}
              size="small"
              aria-label={mode === 'simple' ? '切換到專家模式' : '切換到簡單模式'}
              sx={{ '& .MuiSwitch-track': { bgcolor: 'primary.main' } }}
            />
            <Typography
              variant="caption"
              sx={{ display: { xs: 'none', sm: 'block' }, color: mode === 'expert' ? 'primary.main' : 'text.disabled', fontWeight: 700, fontSize: '0.7rem' }}
            >
              專家
            </Typography>
          </Stack>

          {/** @slot Wallet connect */}
          <WalletButton wallet={wallet} />

          {/** @slot Pepe avatar picker */}
          {wallet.address && <PepeAvatar address={wallet.address} size={32} editable />}

          {/** @slot Account drawer */}
          <AccountDrawer data={accountNavData(wallet.address)} />
        </Box>
      ),
    };

    return (
      <HeaderSection
        layoutQuery={layoutQuery}
        disableElevation={isNavVertical}
        {...slotProps?.header}
        slots={{ ...headerSlots, ...slotProps?.header?.slots }}
        slotProps={merge(headerSlotProps, slotProps?.header?.slotProps ?? {})}
        sx={slotProps?.header?.sx}
      />
    );
  };

  const renderSidebar = () => (
    <NavVertical
      data={navData}
      isNavMini={isNavMini}
      layoutQuery={layoutQuery}
      cssVars={navVars.section}
      checkPermissions={canDisplayItemByRole}
      // The mini rail is icon-only and has no room for a text hint — the
      // toggle in the header is still reachable there, this is just the
      // sidebar-side reminder.
      slots={{ bottomArea: isNavMini ? null : renderSimpleModeHint() }}
      onToggleNav={() =>
        settings.setField(
          'navLayout',
          settings.state.navLayout === 'vertical' ? 'mini' : 'vertical'
        )
      }
    />
  );

  const renderFooter = () => null;

  const renderMain = () => <MainSection {...slotProps?.main}>{children}</MainSection>;

  return (
    <LayoutSection
      /** **************************************
       * @Header
       *************************************** */
      headerSection={renderHeader()}
      /** **************************************
       * @Sidebar
       *************************************** */
      sidebarSection={isNavHorizontal ? null : renderSidebar()}
      /** **************************************
       * @Footer
       *************************************** */
      footerSection={renderFooter()}
      /** **************************************
       * @Styles
       *************************************** */
      cssVars={{ ...dashboardLayoutVars(theme), ...navVars.layout, ...cssVars }}
      sx={[
        {
          [`& .${layoutClasses.sidebarContainer}`]: {
            [theme.breakpoints.up(layoutQuery)]: {
              pl: isNavMini ? 'var(--layout-nav-mini-width)' : 'var(--layout-nav-vertical-width)',
              transition: theme.transitions.create(['padding-left'], {
                easing: 'var(--layout-transition-easing)',
                duration: 'var(--layout-transition-duration)',
              }),
            },
          },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {renderMain()}
    </LayoutSection>
  );
}

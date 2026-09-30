import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { tenant } from 'src/tenant';
import { t, locale } from 'src/locales';
import { tenantFooterLinks } from 'src/tenant/footer';

// ----------------------------------------------------------------------

/**
 * 白標租戶的頁尾：客服與法律連結。
 *
 * 租戶沒有設定任何連結時（default 租戶）回傳 null，版面與改版前完全相同。
 * 外部連結一律新分頁開啟並帶 noopener noreferrer。
 */
export function TenantFooter() {
  const links = tenantFooterLinks(tenant, locale, t.common.tenant.footer.support);
  if (links.length === 0) return null;

  return (
    <Box
      component="footer"
      data-testid="tenant-footer"
      sx={{ px: { xs: 2, md: 5 }, py: 3, borderTop: 1, borderColor: 'divider' }}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={{ xs: 1, sm: 3 }}
        alignItems={{ sm: 'center' }}
        flexWrap="wrap"
        useFlexGap
      >
        <Typography variant="caption" color="text.secondary">
          © {tenant.brand.name}
        </Typography>
        {links.map((l) => (
          <Link
            key={`${l.kind}:${l.href}`}
            href={l.href}
            target={l.href.startsWith('mailto:') ? undefined : '_blank'}
            rel="noopener noreferrer"
            variant="caption"
            color="text.secondary"
            aria-label={
              l.kind === 'legal' ? `${t.common.tenant.footer.legal}: ${l.label}` : l.label
            }
          >
            {l.label}
          </Link>
        ))}
      </Stack>
    </Box>
  );
}

import { t } from 'src/locales';
import { useMode } from 'src/contexts/mode-context';
import { Iconify } from 'src/components/iconify';
import { custodyContent } from 'src/lib/pepefi/custody';
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';

// ----------------------------------------------------------------------

type IconName = 'solar:shield-check-bold' | 'solar:danger-triangle-bold' | 'solar:info-circle-bold';

const BODY_SX = { color: 'text.primary', lineHeight: 1.7, fontSize: '1rem' } as const;

/** 一段有標題的說明：清單（每條前面一個圖示）或一段文字。圖示只是視覺提示，意思全在文字裡。 */
function Section({
  heading,
  items,
  icon,
  color,
}: {
  heading?: string;
  items: string[];
  icon?: IconName;
  color?: string;
}) {
  return (
    <>
      {heading && (
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 'bold', mb: 1.5, fontSize: '1.05rem' }}>
          {heading}
        </Typography>
      )}
      {icon ? (
        <Stack component="ul" spacing={1.5} sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {items.map((text) => (
            <Stack key={text} component="li" direction="row" spacing={1.5} alignItems="flex-start">
              <Iconify icon={icon} width={20} sx={{ color, mt: '2px', flexShrink: 0 }} />
              <Typography variant="body2" sx={BODY_SX}>
                {text}
              </Typography>
            </Stack>
          ))}
        </Stack>
      ) : (
        items.map((text) => (
          <Typography key={text} variant="body2" sx={BODY_SX}>
            {text}
          </Typography>
        ))
      )}
    </>
  );
}

/**
 * #331「你的資產在哪裡」：只支援使用者自管，以及營運方仍然保有的權限（ADR-023）。
 *
 * Simple 與 Expert 都顯示，各用自己的詞彙；選句子的規則在 src/lib/pepefi/custody.ts。
 * 營運方權限那一段與事實並列、不收合：「自管」不能被讀成「完全不需信任」。
 */
export function CustodyExplainer() {
  const { mode } = useMode();
  const c = custodyContent(mode, FEATURE_COPY_TRADING, t.custody);

  return (
    <Box component="section" aria-labelledby="custody-heading" sx={{ mb: 6 }}>
      <Typography
        id="custody-heading"
        variant="overline"
        component="h2"
        color="text.secondary"
        align="center"
        display="block"
        sx={{ mb: 3, fontWeight: 'bold', letterSpacing: 3, fontSize: '1rem' }}
      >
        {c.heading}
      </Typography>

      <Card sx={{ p: { xs: 2.5, sm: 3.5 }, border: '1px solid', borderColor: 'divider' }}>
        <Typography variant="body1" sx={{ color: 'text.secondary', lineHeight: 1.8, mb: 2.5 }}>
          {c.intro}
        </Typography>
        <Section items={c.facts} icon="solar:shield-check-bold" color="success.main" />

        <Divider sx={{ my: 3 }} />
        <Section heading={c.operatorHeading} items={c.operator} icon="solar:danger-triangle-bold" color="warning.main" />

        <Divider sx={{ my: 3 }} />
        <Section heading={c.whyHeading} items={[c.why]} />

        {c.difference && (
          <>
            <Divider sx={{ my: 3 }} />
            <Section
              heading={c.difference.heading}
              items={c.difference.items}
              icon="solar:info-circle-bold"
              color="info.main"
            />
          </>
        )}
      </Card>
    </Box>
  );
}

// 給不懂區塊鏈的人看的引導：標語與三大支柱、跟單五步驟流程圖、簡單／專家模式導覽。
// 第一層只講「做什麼、按哪裡」，細節一律收在展開按鈕後面。文字都在 t.guide。
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Typography from '@mui/material/Typography';

import { t } from 'src/locales';
import { useMode } from 'src/contexts/mode-context';
import { Iconify } from 'src/components/iconify';

const HIDE_KEY = 'pepefi:guide-hidden';

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean): void {
  try {
    localStorage.setItem(HIDE_KEY, hidden ? '1' : '0');
  } catch {
    /* 儲存不可用時只是不記得收合狀態 */
  }
}

function MoreToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <Button
      size="small"
      color="inherit"
      onClick={onClick}
      aria-expanded={open}
      endIcon={<Iconify icon={open ? 'eva:arrow-ios-upward-fill' : 'eva:arrow-ios-downward-fill'} />}
      sx={{ textTransform: 'none', color: 'text.secondary', alignSelf: 'flex-start' }}
    >
      {open ? t.guide.less : t.guide.more}
    </Button>
  );
}

const PILLARS = [
  { icon: 'solar:shield-check-bold' as const, ...t.guide.pillars.trust },
  { icon: 'solar:atom-bold-duotone' as const, ...t.guide.pillars.intelligence },
  { icon: 'solar:verified-check-bold' as const, ...t.guide.pillars.sustainability },
];

function Pillar({ icon, title, short, detail }: (typeof PILLARS)[number]) {
  const [open, setOpen] = useState(false);
  return (
    <Card sx={{ p: 2.5, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Iconify icon={icon} width={26} sx={{ color: 'var(--palette-primary-main)' }} />
        <Typography variant="h6" component="h3">{title}</Typography>
      </Stack>
      <Typography variant="body2" sx={{ color: 'text.primary', lineHeight: 1.8 }}>{short}</Typography>
      <MoreToggle open={open} onClick={() => setOpen((v) => !v)} />
      <Collapse in={open} unmountOnExit>
        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.8 }}>{detail}</Typography>
      </Collapse>
    </Card>
  );
}

/** 標語＋三大支柱。 */
export function SloganPillars() {
  return (
    <Box sx={{ py: 4 }}>
      <Typography
        variant="h3"
        component="p"
        sx={{ textAlign: 'center', fontWeight: 800, color: 'var(--palette-primary-main)' }}
      >
        {t.guide.slogan}
      </Typography>
      {t.guide.sloganZh && (
        <Typography variant="h6" component="p" sx={{ textAlign: 'center', color: 'text.secondary', mt: 1 }}>
          {t.guide.sloganZh}
        </Typography>
      )}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mt: 3 }} alignItems="stretch">
        {PILLARS.map((p) => <Pillar key={p.title} {...p} />)}
      </Stack>
    </Box>
  );
}

/** 跟單五步驟流程圖。 */
export function CopyFlow() {
  const [open, setOpen] = useState(false);
  const { heading, sub, steps, detail } = t.guide.copyFlow;
  return (
    <Card sx={{ p: { xs: 2, md: 3 } }}>
      <Typography variant="h5" component="h2" sx={{ fontWeight: 800 }}>{heading}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{sub}</Typography>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={{ xs: 1, md: 0 }} alignItems="stretch">
        {steps.map((s, i) => (
          <Stack
            key={s.title}
            direction={{ xs: 'column', md: 'row' }}
            alignItems="center"
            sx={{ flex: 1, minWidth: 0 }}
          >
            <Box
              component={RouterLink}
              to={s.to}
              sx={{
                flex: 1,
                width: 1,
                alignSelf: 'stretch',
                p: 1.5,
                borderRadius: 1.5,
                border: '1px solid rgba(var(--palette-primary-mainChannel) / 0.4)',
                color: 'inherit',
                textDecoration: 'none',
                textAlign: 'center',
                '&:hover': { bgcolor: 'rgba(var(--palette-primary-mainChannel) / 0.1)' },
              }}
            >
              <Box
                sx={{
                  width: 34,
                  height: 34,
                  mx: 'auto',
                  mb: 0.75,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: '50%',
                  fontWeight: 800,
                  bgcolor: 'var(--palette-primary-main)',
                  color: 'primary.contrastText',
                }}
              >
                {i + 1}
              </Box>
              <Typography variant="subtitle1" component="p" sx={{ fontWeight: 800 }}>{s.title}</Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>{s.text}</Typography>
            </Box>
            {i < steps.length - 1 && (
              <Iconify
                icon="eva:arrow-ios-forward-fill"
                width={22}
                sx={{
                  flexShrink: 0,
                  color: 'var(--palette-primary-main)',
                  transform: { xs: 'rotate(90deg)', md: 'none' },
                }}
              />
            )}
          </Stack>
        ))}
      </Stack>
      <Box sx={{ mt: 1.5 }}>
        <MoreToggle open={open} onClick={() => setOpen((v) => !v)} />
        <Collapse in={open} unmountOnExit>
          <Box component="ul" sx={{ m: 0, pl: 3 }}>
            {detail.map((line) => (
              <Typography key={line} component="li" variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.9 }}>
                {line}
              </Typography>
            ))}
          </Box>
        </Collapse>
      </Box>
    </Card>
  );
}

/** 依目前模式顯示的導覽，可收起。 */
export function ModeGuideCard() {
  const { mode } = useMode();
  const [hidden, setHidden] = useState(readHidden);
  const toggle = (next: boolean) => {
    setHidden(next);
    writeHidden(next);
  };

  if (hidden) {
    return (
      <Button
        size="small"
        color="inherit"
        onClick={() => toggle(false)}
        sx={{ textTransform: 'none', alignSelf: 'flex-start', color: 'text.secondary' }}
      >
        {t.guide.show}
      </Button>
    );
  }

  const G = t.guide.mode;
  const items = mode === 'simple' ? G.simple : G.expert;
  return (
    <Card sx={{ p: 2.5 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
        <Box>
          <Typography variant="h6" component="h2">{mode === 'simple' ? G.simpleTitle : G.expertTitle}</Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{G.switchHint}</Typography>
        </Box>
        <Button
          size="small"
          color="inherit"
          onClick={() => toggle(true)}
          sx={{ textTransform: 'none', color: 'text.secondary', flexShrink: 0 }}
        >
          {t.guide.hide}
        </Button>
      </Stack>
      <Box
        sx={{
          display: 'grid',
          gap: 1.5,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: `repeat(${Math.min(items.length, 4)}, 1fr)` },
        }}
      >
        {items.map((it, i) => (
          <Box
            key={it.title}
            component={RouterLink}
            to={it.to}
            sx={{
              p: 1.5,
              borderRadius: 1.5,
              border: '1px solid rgba(var(--palette-primary-mainChannel) / 0.3)',
              color: 'inherit',
              textDecoration: 'none',
              '&:hover': { bgcolor: 'rgba(var(--palette-primary-mainChannel) / 0.1)' },
            }}
          >
            <Typography variant="subtitle2" component="p" sx={{ fontWeight: 800 }}>
              {mode === 'simple' ? `${i + 1}. ` : ''}{it.title}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{it.text}</Typography>
          </Box>
        ))}
      </Box>
    </Card>
  );
}

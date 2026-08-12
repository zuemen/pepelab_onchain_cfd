import { useState, useEffect } from 'react';
import { Link as RouterLink } from 'react-router';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Link from '@mui/material/Link';
import IconButton from '@mui/material/IconButton';
import type { WhaleAlert } from 'src/hooks/useWhaleAlerts';

import { shortAddr } from 'src/components/pepefi/brandKit';
import { timeAgo, fCompact, sideLabel } from 'src/lib/pepefi/whale';

// NOTE(redesign/whale-tracker): 這個元件目前**沒有被任何地方 import**——全 repo
// 只有 INTEGRATION_PLAN.md 提到它，它從來沒被掛上去過。內容現在也被
// /whale 的 WhaleFeed 完整涵蓋了。留著是為了讓你決定：掛上去當全站橫幅，
// 還是刪掉。在那之前至少讓它不要再自己複製一份格式化函式與已經搬家的連結。

interface Props { alerts: WhaleAlert[] }

export default function WhaleAlertBanner({ alerts }: Props) {
  const [visible, setVisible] = useState(true);
  const [idx,     setIdx]     = useState(0);

  const top3 = alerts.slice(0, 3);

  // Auto-rotate every 6 s when multiple alerts
  useEffect(() => {
    if (top3.length < 2) return;
    const id = setInterval(() => setIdx(c => (c + 1) % top3.length), 6000);
    return () => clearInterval(id);
  }, [top3.length]);

  // Reset when alerts list refreshes
  useEffect(() => { setIdx(0); setVisible(true) }, [alerts]);

  if (!visible || top3.length === 0) return null;

  const a = top3[idx];
  if (!a) return null;

  return (
    <Box
      sx={{
        bgcolor: 'rgba(0, 184, 217, 0.08)',
        borderBottom: '1px solid',
        borderColor: 'rgba(0, 184, 217, 0.16)',
        px: 2,
        py: 0.75,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        userSelect: 'none',
      }}
    >
      <Box sx={{ fontSize: '1rem', lineHeight: 1 }}>🐋</Box>
      <Typography
        variant="caption"
        sx={{
          color: '#00b8d9',
          fontWeight: 'bold',
          display: { xs: 'none', sm: 'block' },
          textTransform: 'uppercase',
          letterSpacing: 1,
        }}
      >
        Whale Alert
      </Typography>

      {/* Message */}
      <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <Link
          component={RouterLink}
          to={`/trader/${a.owner}`}
          sx={{
            fontFamily: 'monospace',
            color: 'text.secondary',
            textDecoration: 'none',
            fontWeight: 'medium',
            '&:hover': {
              color: 'text.primary',
              textDecoration: 'underline',
            },
          }}
        >
          {shortAddr(a.owner)}
        </Link>
        <Typography component="span" variant="caption" sx={{ color: 'text.secondary', mx: 0.5 }}>
          opened
        </Typography>
        <Typography
          component="span"
          variant="caption"
          sx={{
            fontWeight: 'bold',
            color: a.isLong ? 'success.main' : 'error.main',
          }}
        >
          {sideLabel(a.isLong)}
        </Typography>
        <Typography component="span" variant="caption" sx={{ color: 'text.secondary', mx: 0.5 }}>
          {a.assetLabel} —
        </Typography>
        <Typography component="span" variant="caption" sx={{ fontWeight: 'bold', color: 'text.primary' }}>
          {fCompact(a.notional)}
        </Typography>
        <Typography component="span" variant="caption" sx={{ color: 'text.secondary', mx: 0.5 }}>
          notional
        </Typography>
        <Typography component="span" variant="caption" sx={{ color: 'info.main', opacity: 0.8 }}>
          · {timeAgo(a.timestamp)}
        </Typography>
      </Box>

      {/* Pagination dots */}
      {top3.length > 1 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {top3.map((_, i) => (
            <Box
              component="button"
              key={i}
              onClick={() => setIdx(i)}
              sx={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                border: 'none',
                p: 0,
                cursor: 'pointer',
                transition: 'background-color 0.2s',
                bgcolor: i === idx ? '#00b8d9' : 'action.disabled',
                '&:hover': {
                  bgcolor: i === idx ? '#00b8d9' : 'text.secondary',
                },
              }}
            />
          ))}
        </Box>
      )}

      <IconButton
        size="small"
        onClick={() => setVisible(false)}
        aria-label="Dismiss whale alert"
        sx={{
          p: 0.25,
          color: 'text.secondary',
          '&:hover': { color: 'text.primary' },
        }}
      >
        <Box sx={{ fontSize: '0.75rem', lineHeight: 1 }}>✕</Box>
      </IconButton>
    </Box>
  );
}

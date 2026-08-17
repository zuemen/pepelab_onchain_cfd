import type { NetWorthParts } from 'src/lib/pepefi/portfolio';

import { Link as RouterLink } from 'react-router';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';

import { t, interpolate } from 'src/locales';
import { netWorthOf } from 'src/lib/pepefi/portfolio';
import { MONO, PEPE } from 'src/components/pepefi/brandKit';
import Skeleton from 'src/components/pepefi/Skeleton';

// ----------------------------------------------------------------------
// 一個數字，回答「我有多少錢」。
//
// 取代原本三塊各自宣稱自己是總覽的區域：「總資產估值」（313 行的 Wealth
// Navigator）、「總資產現值」（A 區四張卡）、以及它們之間互相矛盾的數字。
// 兩個標題差一個字、公式不同、永遠不相等，使用者無從判斷哪個是自己的錢。
//
// 這裡只留一個總額，下面一排是它的組成。組成的每一項都連到能對它做事的
// 頁面——原本那四張卡真正有價值的是那些 CTA，不是又一次把同樣的錢分四種
// 說法再講一遍。
//
// 顯示字串全部來自 catalog（src/locales），不再寫在這裡。
//
// 這段原本宣告「UI 文案一律英文，全站正在往英文遷移」。方向已經反過來了：顯示文字
// 一律繁體中文，專有名詞例外，理由見 frontend/docs/adr/0002。這裡的英文字串是搬移
// 階段的原文，中文化是另一步（#38），不在搬移的 commit 裡動。
//
// 至於為新手另造一套說法：Net Worth / Wallet / Staked 這幾個標籤不需要，需要的是
// notional、leverage 那類術語，等真的用到再處理。

const fUsd = (v: bigint) =>
  `$${(Number(v) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fSignedUsd = (v: bigint) => (v >= 0n ? '+' : '') + fUsd(v);

type BreakdownItem = {
  label: string;
  value: bigint | null;
  href: string;
  /** 這一項讀不到時要說的話。 */
  hint: string;
};

type Props = {
  parts: NetWorthParts;
  /** 未實現損益佔名目的百分比，已格式化；沒有倉位時是 '—'。 */
  pnlPct: string;
  loading: boolean;
};

export default function NetWorthHero({ parts, pnlPct, loading }: Props) {
  const { total, incomplete, missing } = netWorthOf(parts);
  const pnl = parts.unrealisedPnl ?? 0n;
  const pnlTone = pnl > 0n ? PEPE.long : pnl < 0n ? PEPE.short : 'text.secondary';

  const { part, unread } = t.portfolio.netWorth;
  const breakdown: BreakdownItem[] = [
    { label: part.wallet,  value: parts.walletCash, href: '/exchange', hint: unread.wallet },
    { label: part.trading, value: sumOrNull(parts.freeMargin, parts.lockedMargin), href: '/exchange', hint: unread.trading },
    { label: part.staked,  value: parts.staked,     href: '/stake',    hint: unread.staked },
    { label: part.lpVault, value: parts.vault,      href: '/vault',    hint: unread.lpVault },
  ];

  return (
    <Card
      sx={{
        p: { xs: 2.5, sm: 3.5 },
        background: 'linear-gradient(135deg, rgba(124,193,74,0.10) 0%, rgba(11,22,37,0.75) 100%)',
        border: '1px solid rgba(124,193,74,0.28)',
      }}
    >
      {/* ── 總額 ────────────────────────────────────────────────────────── */}
      <Typography
        variant="overline"
        sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 1, display: 'block' }}
      >
        {t.portfolio.netWorth.title}
      </Typography>

      {loading ? (
        <Skeleton width={260} height={52} sx={{ mt: 1 }} />
      ) : (
        <Stack direction="row" alignItems="baseline" flexWrap="wrap" gap={1.5} sx={{ mt: 0.5 }}>
          <Typography
            variant="h3"
            sx={{ fontWeight: 900, fontFamily: MONO, color: 'var(--palette-primary-main)', lineHeight: 1.1 }}
          >
            {fUsd(total)}
          </Typography>

          {/* 未實現損益。刻意不叫「今日變化」——沒有任何淨值的歷史快照可以
              算出日變化，只有這個「目前開著的倉賺賠多少」是真的。 */}
          <Tooltip title={t.portfolio.netWorth.unrealisedPnlTooltip}>
            <Stack direction="row" alignItems="baseline" gap={0.75}>
              <Typography sx={{ fontWeight: 800, fontFamily: MONO, color: pnlTone }}>
                {fSignedUsd(pnl)}
              </Typography>
              <Typography variant="caption" sx={{ color: pnlTone, opacity: 0.85, fontFamily: MONO }}>
                {pnlPct}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t.portfolio.netWorth.unrealisedPnl}
              </Typography>
            </Stack>
          </Tooltip>
        </Stack>
      )}

      {/* 讀取失敗要講出來，不能讓一個少算了幾項的數字看起來很篤定。 */}
      {!loading && incomplete && (
        <Typography variant="caption" sx={{ color: 'warning.main', display: 'block', mt: 1 }}>
          {interpolate(
            missing.length === 1
              ? t.portfolio.netWorth.incompleteOne
              : t.portfolio.netWorth.incompleteMany,
            { count: missing.length }
          )}
        </Typography>
      )}

      <Divider sx={{ my: 2.5, borderColor: 'rgba(255,255,255,0.08)' }} />

      {/* ── 組成 ────────────────────────────────────────────────────────── */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
          gap: { xs: 2, sm: 3 },
        }}
      >
        {breakdown.map((item) => (
          <Link
            key={item.label}
            component={RouterLink}
            to={item.href}
            sx={{
              textDecoration: 'none',
              color: 'inherit',
              '&:hover .netWorthHero__value': { color: 'var(--palette-primary-main)' },
            }}
          >
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block' }}>
              {item.label}
            </Typography>
            {loading ? (
              <Skeleton width={80} height={24} sx={{ mt: 0.5 }} />
            ) : (
              <Typography
                className="netWorthHero__value"
                sx={{ fontWeight: 700, fontFamily: MONO, transition: 'color 0.15s' }}
                title={item.value === null ? item.hint : undefined}
              >
                {item.value === null ? '—' : fUsd(item.value)}
              </Typography>
            )}
          </Link>
        ))}
      </Box>
    </Card>
  );
}

/** 兩項只要有一項讀不到就整格顯示 '—'，不要用半個數字冒充「交易帳戶」總額。 */
function sumOrNull(a: bigint | null, b: bigint | null): bigint | null {
  return a === null || b === null ? null : a + b;
}

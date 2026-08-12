import type { NetWorthParts } from 'src/lib/pepefi/portfolio';

import { Link as RouterLink } from 'react-router';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';

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
// UI 文案一律英文：全站正在往英文遷移，新寫的字直接用目的地語言，免得
// 現在寫中文、下一輪再翻一次。
//
// 這裡曾經接 lib/pepefi/terms.ts 依模式查詞（simple 中文／expert 英文）。
// 全站改英文之後那個對照表的前提就沒了，所以整個模組移除。這幾個標籤
// （Net Worth / Wallet / Staked）本來就不需要為新手另造一套說法；真正需要
// 白話版的是 notional、leverage 這類術語，等 Step 5/7 用到時再視情況處理。

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

  const breakdown: BreakdownItem[] = [
    { label: 'Wallet',   value: parts.walletCash, href: '/exchange', hint: 'Wallet balance could not be read' },
    { label: 'Trading',  value: sumOrNull(parts.freeMargin, parts.lockedMargin), href: '/exchange', hint: 'Trading account could not be read' },
    { label: 'Staked',   value: parts.staked,     href: '/stake',    hint: 'Stake could not be read' },
    { label: 'LP Vault', value: parts.vault,      href: '/vault',    hint: 'LP vault could not be read' },
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
        Net Worth
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
          <Tooltip title="Mark-to-market PnL on positions that are still open">
            <Stack direction="row" alignItems="baseline" gap={0.75}>
              <Typography sx={{ fontWeight: 800, fontFamily: MONO, color: pnlTone }}>
                {fSignedUsd(pnl)}
              </Typography>
              <Typography variant="caption" sx={{ color: pnlTone, opacity: 0.85, fontFamily: MONO }}>
                {pnlPct}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Unrealised PnL
              </Typography>
            </Stack>
          </Tooltip>
        </Stack>
      )}

      {/* 讀取失敗要講出來，不能讓一個少算了幾項的數字看起來很篤定。 */}
      {!loading && incomplete && (
        <Typography variant="caption" sx={{ color: 'warning.main', display: 'block', mt: 1 }}>
          {missing.length} {missing.length === 1 ? 'balance' : 'balances'} could not be read — this total is incomplete.
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

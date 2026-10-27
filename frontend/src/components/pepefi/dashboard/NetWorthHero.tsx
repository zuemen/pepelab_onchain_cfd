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
import { liquidOf, netWorthOf } from 'src/lib/pepefi/portfolio';
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags';
import { Iconify } from 'src/components/iconify';
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
//
// 這個總額把流動性與風險不同的東西照目前價格加在一起（質押有冷卻期與罰沒、
// LP 金庫會因穿倉補貼縮水、代幣化資產照預言機價計）。只秀一個大數字會讓人以為
// 整筆隨時拿得出來，所以總額下方另列「可立即動用」，每一欄標題滑過時說明它的
// 流動性與風險。說明放 tooltip 而不是攤在卡片上，卡片才不會變成一面條款。

const fUsd = (v: bigint) =>
  `$${(Number(v) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// 負號放在 $ 前面（-$2.40），不是 $-2.40。
const fSignedUsd = (v: bigint) => (v >= 0n ? `+${fUsd(v)}` : `-${fUsd(-v)}`);

type BreakdownItem = {
  label: string;
  value: bigint | null;
  href: string;
  /** 這一項讀不到時要說的話。 */
  hint: string;
  /** 有數字但少算了幾筆（例如現貨缺價）——數字後面加 *，滑過顯示 hint。 */
  partial?: boolean;
  /** 這一項的流動性與風險說明，滑過標題時出現。 */
  risk: string;
};

// 觸控裝置沒有 hover：點一下就出現，停留夠久讓人讀完。
const TOOLTIP_TOUCH = { enterTouchDelay: 0, leaveTouchDelay: 6000 } as const;

type Props = {
  parts: NetWorthParts;
  /** 未實現損益佔名目的百分比，已格式化；沒有倉位時是 '—'。 */
  pnlPct: string;
  loading: boolean;
};

export default function NetWorthHero({ parts, pnlPct, loading }: Props) {
  const { total, incomplete, missing } = netWorthOf(parts);
  const liquid = liquidOf(parts);
  // null = 有部位讀不出數字（讀取失敗、無有效價格、價格過期）：顯示「—」，不顯示 +$0.00。
  const pnl = parts.unrealisedPnl;
  const pnlTone = pnl === null ? 'text.secondary' : pnl > 0n ? PEPE.long : pnl < 0n ? PEPE.short : 'text.secondary';

  const { part, unread, risk } = t.portfolio.netWorth;
  const breakdown: BreakdownItem[] = [
    { label: part.spot,    value: parts.spotHoldings, href: '/tokens', hint: unread.spot, risk: risk.spot, partial: (parts.spotUnpriced ?? 0) > 0 },
    { label: part.wallet,  value: parts.walletCash, href: '/exchange', hint: unread.wallet,  risk: risk.wallet },
    { label: part.trading, value: sumOrNull(parts.freeMargin, parts.lockedMargin), href: '/exchange', hint: unread.trading, risk: risk.trading },
    { label: part.staked,  value: parts.staked,     href: '/stake',    hint: unread.staked,  risk: FEATURE_COPY_TRADING ? risk.staked : risk.stakedNoCopy },
    { label: part.lpVault, value: parts.vault,      href: '/vault',    hint: unread.lpVault, risk: risk.lpVault },
  ];

  return (
    <Card
      sx={(theme) => ({
        p: { xs: 2.5, sm: 3.5 },
        // 漸層的深色端原本寫死 rgba(11,22,37,0.75)。淺色主題下文字是深灰，
        // 右半邊（已質押、LP 保險金庫）的標題因此幾乎看不見——風險最高的兩欄
        // 反而最難讀。深色端只留給深色主題，淺色主題用淡綠漸層。
        background:
          'linear-gradient(135deg, rgba(var(--palette-primary-mainChannel) / 0.12) 0%, rgba(var(--palette-primary-mainChannel) / 0.03) 100%)',
        border: '1px solid rgba(var(--palette-primary-mainChannel) / 0.28)',
        ...theme.applyStyles('dark', {
          background: 'linear-gradient(135deg, rgba(var(--palette-primary-mainChannel) / 0.10) 0%, rgba(11,22,37,0.75) 100%)',
        }),
      })}
    >
      {/* ── 總額 ────────────────────────────────────────────────────────── */}
      <Tooltip title={t.portfolio.netWorth.titleTooltip} {...TOOLTIP_TOUCH}>
        <Stack direction="row" alignItems="center" gap={0.5} sx={{ width: 'fit-content', cursor: 'help' }}>
          <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 1 }}>
            {t.portfolio.netWorth.title}
          </Typography>
          <InfoIcon />
        </Stack>
      </Tooltip>

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
                {pnl === null ? '—' : fSignedUsd(pnl)}
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

      {!loading && (
        <Tooltip title={t.portfolio.netWorth.liquidTooltip} {...TOOLTIP_TOUCH}>
          <Stack direction="row" alignItems="center" gap={0.75} sx={{ mt: 1, width: 'fit-content', cursor: 'help' }}>
            <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
              {t.portfolio.netWorth.liquid}
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 800, fontFamily: MONO }}>
              {liquid === null ? '—' : fUsd(liquid)}
            </Typography>
            <InfoIcon />
          </Stack>
        </Tooltip>
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

      <Divider sx={{ my: 2.5 }} />

      {/* ── 組成 ────────────────────────────────────────────────────────── */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)', md: 'repeat(5, 1fr)' },
          gap: { xs: 2, sm: 3 },
        }}
      >
        {breakdown.map((item) => (
          <Box key={item.label}>
            {/* 標題不放進連結裡：觸控裝置點標題是要看說明，不是被帶去別頁。 */}
            <Tooltip title={item.risk} {...TOOLTIP_TOUCH}>
              <Stack direction="row" alignItems="center" gap={0.5} sx={{ width: 'fit-content', cursor: 'help' }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                  {item.label}
                </Typography>
                <InfoIcon />
              </Stack>
            </Tooltip>
            {loading ? (
              <Skeleton width={80} height={24} sx={{ mt: 0.5 }} />
            ) : (
              <Link
                component={RouterLink}
                to={item.href}
                title={item.value === null || item.partial ? item.hint : undefined}
                sx={{
                  display: 'block',
                  width: 'fit-content',
                  textDecoration: 'none',
                  color: 'text.primary',
                  fontWeight: 700,
                  fontFamily: MONO,
                  transition: 'color 0.15s',
                  '&:hover': { color: 'var(--palette-primary-main)', textDecoration: 'none' },
                }}
              >
                {item.value === null ? '—' : `${fUsd(item.value)}${item.partial ? '*' : ''}`}
              </Link>
            )}
          </Box>
        ))}
      </Box>
    </Card>
  );
}

function InfoIcon() {
  return <Iconify icon="eva:info-outline" width={14} sx={{ color: 'text.disabled', flexShrink: 0 }} />;
}

/** 兩項只要有一項讀不到就整格顯示 '—'，不要用半個數字冒充「交易帳戶」總額。 */
function sumOrNull(a: bigint | null, b: bigint | null): bigint | null {
  return a === null || b === null ? null : a + b;
}

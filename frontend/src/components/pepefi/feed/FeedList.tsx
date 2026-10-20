import type { BrowserProvider } from 'ethers';

import { Link as RouterLink } from 'react-router';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';

import { t, interpolate } from 'src/locales';
import { fUsd } from 'src/lib/pepefi/heroData';
import { fCompact, timeAgo } from 'src/lib/pepefi/whale';
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta';
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags';
import { type FeedItem, type FeedType } from 'src/lib/pepefi/feed';

import { MONO } from 'src/components/pepefi/brandKit';
import TxProof from 'src/components/pepefi/hero/TxProof';

// ----------------------------------------------------------------------
// 動態牆的一串項目（issue #335）。動態頁與交易者個人頁共用。句型在 String Catalog（t.feed.sentence），
// 參數由 src/lib/pepefi/feed.ts 從鏈上事件算出。

const L = t.feed;

const label = (asset: string | null) => (asset ? ASSET_LABEL[asset] ?? '?' : '?');
const side = (isLong: boolean | null) => (isLong === null ? '' : isLong ? L.sentence.long : L.sentence.short);
const pct = (bps: number) => (bps / 100).toFixed(0);
const signedUsd = (v: bigint) => `${v >= 0n ? '+' : ''}${fCompact(v)}`;

/** 一則動態的說明句子（不含主角，主角另外顯示）。 */
export function describeFeedItem(item: FeedItem, today: string): string {
  const S = L.sentence;
  switch (item.type) {
    case 'strategy': {
      if (item.first && item.legs) {
        const legs = item.legs.map((l) => interpolate(S.leg, { asset: label(l.asset), side: side(l.isLong), weight: pct(l.weightBps) }));
        return interpolate(S.strategyFirst, { legs: legs.join(S.separator) });
      }
      if (!item.diff) return interpolate(S.strategyUnknown, { version: item.versionId + 1 });
      const d = item.diff;
      const changes = [
        ...d.added.map((a) => interpolate(S.added, { asset: label(a.asset), side: side(a.isLong), weight: pct(a.weightBps) })),
        ...d.removed.map((r) => interpolate(S.removed, { asset: label(r.asset) })),
        ...d.flipped.map((f) => interpolate(S.flipped, { asset: label(f.asset), side: side(f.isLong) })),
        ...d.reweighted.map((w) => interpolate(S.reweighted, { asset: label(w.asset), from: pct(w.fromBps), to: pct(w.toBps) })),
      ];
      if (changes.length === 0) return interpolate(S.strategySame, { version: item.versionId + 1 });
      return interpolate(S.strategyChanged, { version: item.versionId + 1, changes: changes.join(S.separator) });
    }
    case 'bigOpen':
      return interpolate(S.bigOpen, {
        asset: label(item.asset), side: side(item.isLong), leverage: String(item.leverage), notional: fCompact(item.notional),
      });
    case 'bigClose':
      return interpolate(S.bigClose, {
        asset: label(item.asset), side: side(item.isLong), notional: fCompact(item.notional), pnl: signedUsd(item.pnl),
      });
    case 'liquidation':
      return item.notional === null
        ? interpolate(S.liquidationUnknown, { pnl: signedUsd(item.pnl) })
        : interpolate(S.liquidation, {
            asset: label(item.asset), side: side(item.isLong), notional: fCompact(item.notional), pnl: signedUsd(item.pnl),
          });
    case 'follow':
      return item.day === today
        ? interpolate(S.follow, { count: item.count, margin: fCompact(item.totalMargin) })
        : interpolate(S.followOn, { count: item.count, margin: fCompact(item.totalMargin), day: item.day });
    case 'unfollow':
      return item.day === today
        ? interpolate(S.unfollow, { count: item.count })
        : interpolate(S.unfollowOn, { count: item.count, day: item.day });
    case 'slash':
      return interpolate(S.slash, { amount: fCompact(item.amount) });
    case 'retirement':
      return interpolate(S.retirement, {
        tonnes: (Number(item.tonnes) / 1e18).toFixed(2),
        // 退役金額常常不到 1 美元，取到分，不用會四捨五入成 $0 的 fCompact
        amount: `$${fUsd(Number(item.amount) / 1e18)}`,
      });
    default:
      return '';
  }
}

const TONE: Record<FeedType, 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'> = {
  strategy: 'primary',
  bigOpen: 'info',
  bigClose: 'default',
  liquidation: 'error',
  follow: 'success',
  unfollow: 'warning',
  slash: 'error',
  retirement: 'success',
};

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

interface Props {
  items: FeedItem[];
  /** 模擬交易者的小寫位址：這些人旁邊掛「模擬」。 */
  simulated: ReadonlySet<string>;
  provider: BrowserProvider | null;
  chainId: number | null;
  /** 個人頁上不需要再連回同一位的個人頁。 */
  hideActor?: boolean;
}

export default function FeedList({ items, simulated, provider, chainId, hideActor = false }: Props) {
  const now = Math.floor(Date.now() / 1000);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card>
      {items.map((item, i) => {
        // 跟單入口只給註冊過的交易者，而且只在跟單旗標開啟時出現
        const canCopy = FEATURE_COPY_TRADING && item.actorName !== null;
        // 平台自己的動作（碳權退役）沒有主角：顯示「平台」，不給個人頁
        const platform = item.actor === '';
        return (
          <Box key={item.id}>
            {i > 0 && <Divider />}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ p: 2 }} alignItems={{ sm: 'flex-start' }}>
              <Box sx={{ minWidth: 96 }}>
                <Chip size="small" variant="outlined" color={TONE[item.type]} label={L.types[item.type]} sx={{ height: 22 }} />
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  {item.timestamp > 0 ? timeAgo(item.timestamp, now) : '—'}
                </Typography>
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                  {!hideActor && (
                    <Box component="span" sx={{ fontWeight: 700, mr: 0.75 }}>
                      {platform
                        ? L.item.platform
                        : item.actorName ?? <Box component="span" sx={{ fontFamily: MONO }}>{short(item.actor)}</Box>}
                    </Box>
                  )}
                  {simulated.has(item.actor) && (
                    <Chip size="small" label={L.item.simulated} sx={{ height: 18, fontSize: '0.65rem', mr: 0.75 }} />
                  )}
                  {describeFeedItem(item, today)}
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
                  <TxProof label={L.item.tx} hash={item.txHash} provider={provider} chainId={chainId} />
                  {!hideActor && !platform && (
                    <Button size="small" component={RouterLink} to={`/trader/${item.actor}`} sx={{ minWidth: 0, px: 1 }}>
                      {L.item.profile}
                    </Button>
                  )}
                  {canCopy && (
                    <Button size="small" component={RouterLink} to={`/copy/${item.actor}`} sx={{ minWidth: 0, px: 1 }}>
                      {L.item.copy}
                    </Button>
                  )}
                </Stack>
              </Box>
            </Stack>
          </Box>
        );
      })}
    </Card>
  );
}

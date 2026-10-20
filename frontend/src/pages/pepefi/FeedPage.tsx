import { useMemo, useState } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Container from '@mui/material/Container';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { usePepefiWallet } from 'src/layouts/pepefi';
import { t, interpolate } from 'src/locales';
import { useMode } from 'src/contexts/mode-context';
import { useChainFeed } from 'src/hooks/useChainFeed';
import { useContracts } from 'src/hooks/useContracts';
import { useHeroDataset } from 'src/hooks/useSimulatedTraders';
import { heroDisclosure } from 'src/lib/pepefi/heroDisclosure';
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags';
import { describeScanWindow } from 'src/lib/pepefi/chainLogs';
import { FEED_TYPES, filterFeed, type FeedType } from 'src/lib/pepefi/feed';

import FeedList from 'src/components/pepefi/feed/FeedList';

// ----------------------------------------------------------------------
// 動態牆（issue #335）：由鏈上事件組成、依時間排序的平台動態。只在 Expert 模式：內容是交易桌的事件。
//
// 跟單旗標關閉時不列跟隨與取消（跟單功能本身不存在），也不給跟單入口。

const L = t.feed;
const PAGE = 50;

/** 這個 build 會出現的類型。 */
const VISIBLE_TYPES: readonly FeedType[] = FEED_TYPES.filter(
  (type) => FEATURE_COPY_TRADING || (type !== 'follow' && type !== 'unfollow')
);

export default function FeedPage() {
  const { mode, setMode } = useMode();
  const wallet = usePepefiWallet();
  if (mode !== 'expert') {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Card sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="h6" sx={{ mb: 1 }}>{L.expertOnly.title}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>{L.expertOnly.body}</Typography>
          <Button variant="contained" onClick={() => setMode('expert')}>{L.expertOnly.action}</Button>
        </Card>
      </Container>
    );
  }
  // 未連錢包時不導回首頁（/feed 在 PUBLIC_PATHS），只說這一頁需要錢包
  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">{t.common.wallet.connectPrompt.feed}</Typography>
      </Box>
    );
  }
  return <Feed />;
}

function Feed() {
  const wallet = usePepefiWallet();
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const feed = useChainFeed(contracts, wallet.provider, wallet.chainId);
  const heroDataset = useHeroDataset(wallet.chainId);
  const simulated = heroDataset.addresses;

  const [types, setTypes] = useState<FeedType[]>([...VISIBLE_TYPES]);
  const [actor, setActor] = useState('');
  const [shown, setShown] = useState(PAGE);

  const visible = useMemo(() => filterFeed(feed.items, { types: VISIBLE_TYPES }), [feed.items]);
  const filtered = useMemo(() => filterFeed(visible, { types, actor: actor || null }), [visible, types, actor]);
  const actors = useMemo(() => {
    const byAddress = new Map<string, string>();
    for (const item of visible) if (item.actor) byAddress.set(item.actor, item.actorName ?? `${item.actor.slice(0, 6)}…${item.actor.slice(-4)}`);
    return [...byAddress].sort((a, b) => a[1].localeCompare(b[1]));
  }, [visible]);
  const anySimulated = visible.some((item) => simulated.has(item.actor));

  const toggle = (type: FeedType) => {
    setShown(PAGE);
    setTypes((prev) => (prev.includes(type) ? prev.filter((x) => x !== type) : [...prev, type]));
  };

  const range = feed.scanRange;
  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      <Stack spacing={2.5}>
        <Stack direction="row" alignItems="flex-start" spacing={2}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="h4" sx={{ fontWeight: 'bold' }}>{L.title}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{L.subtitle}</Typography>
          </Box>
          <Button variant="outlined" size="small" onClick={feed.refetch} disabled={feed.loading}>{L.refresh}</Button>
        </Stack>

        {anySimulated && (
          <Alert severity="info" variant="outlined">{heroDisclosure(heroDataset.timeCompressed)}</Alert>
        )}
        {feed.incomplete && !feed.loading && <Alert severity="warning">{L.incomplete}</Alert>}

        <Card sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 56 }}>{L.filter.types}</Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {VISIBLE_TYPES.map((type) => (
                  <Chip
                    key={type}
                    size="small"
                    label={L.types[type]}
                    color={types.includes(type) ? 'primary' : 'default'}
                    variant={types.includes(type) ? 'filled' : 'outlined'}
                    onClick={() => toggle(type)}
                  />
                ))}
              </Stack>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 56 }}>{L.filter.trader}</Typography>
              <TextField
                select
                size="small"
                value={actor}
                onChange={(e) => { setActor(e.target.value); setShown(PAGE); }}
                sx={{ minWidth: 220 }}
              >
                <MenuItem value="">{L.filter.allTraders}</MenuItem>
                {actors.map(([address, name]) => (
                  <MenuItem key={address} value={address}>{name}</MenuItem>
                ))}
              </TextField>
            </Stack>
          </Stack>
        </Card>

        {feed.loading && feed.items.length === 0 ? (
          <Typography color="text.secondary">{L.loading}</Typography>
        ) : filtered.length === 0 ? (
          // 讀不到時只留上面「不完整」的提示：再說「沒有符合條件」等於把讀不到當成沒有發生
          feed.incomplete ? null : <Typography color="text.secondary">{L.empty}</Typography>
        ) : (
          <>
            <FeedList items={filtered.slice(0, shown)} simulated={simulated} provider={wallet.provider} chainId={wallet.chainId} />
            {filtered.length > shown && (
              <Box sx={{ textAlign: 'center' }}>
                <Button onClick={() => setShown((n) => n + PAGE)}>{L.loadMore}</Button>
              </Box>
            )}
          </>
        )}

        <Typography variant="caption" color="text.secondary">{L.pnlNote}</Typography>

        {range && (
          <Typography variant="caption" color="text.secondary">
            {wallet.chainId === 31337 && range.from === 0
              ? interpolate(L.scanWindowAll, { from: range.from, to: range.to })
              : interpolate(L.scanWindow, { from: range.from, to: range.to, span: describeScanWindow(wallet.chainId, range.to - range.from) })}
          </Typography>
        )}
      </Stack>
    </Container>
  );
}

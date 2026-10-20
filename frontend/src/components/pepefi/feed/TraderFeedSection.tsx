import type { WalletAPI } from 'src/hooks/useWallet';

import { useMemo } from 'react';
import { Link as RouterLink } from 'react-router';

import Card from '@mui/material/Card';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

import { t } from 'src/locales';
import { paths } from 'src/routes/paths';
import { useChainFeed } from 'src/hooks/useChainFeed';
import { useContracts } from 'src/hooks/useContracts';
import { useSimulatedTraders } from 'src/hooks/useSimulatedTraders';
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags';
import { FEED_TYPES, filterFeed } from 'src/lib/pepefi/feed';

import FeedList from './FeedList';

// ----------------------------------------------------------------------
// 交易者個人頁上的「最近動態」（issue #335）：同一份動態牆，只留這位交易者自己的。

const L = t.feed;
const SHOWN = 8;
const TYPES = FEED_TYPES.filter((type) => FEATURE_COPY_TRADING || (type !== 'follow' && type !== 'unfollow'));

export default function TraderFeedSection({ wallet, trader }: { wallet: WalletAPI; trader: string }) {
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const feed = useChainFeed(contracts, wallet.provider, wallet.chainId);
  const simulated = useSimulatedTraders(wallet.chainId);
  const mine = useMemo(() => filterFeed(feed.items, { types: TYPES, actor: trader }), [feed.items, trader]);

  return (
    <Card sx={{ p: 3 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{L.profile.title}</Typography>
        <Button size="small" component={RouterLink} to={paths.pepefi.feed}>{L.profile.viewAll}</Button>
      </Stack>
      {feed.incomplete && !feed.loading && <Alert severity="warning" sx={{ mb: 2 }}>{L.incomplete}</Alert>}
      {feed.loading && mine.length === 0 ? (
        <Typography variant="body2" color="text.secondary">{L.loading}</Typography>
      ) : mine.length === 0 ? (
        // 讀不到時只留「不完整」的提示，不說「沒有動態」
        feed.incomplete ? null : <Typography variant="body2" color="text.secondary">{L.profile.empty}</Typography>
      ) : (
        <FeedList items={mine.slice(0, SHOWN)} simulated={simulated} provider={wallet.provider} chainId={wallet.chainId} hideActor />
      )}
    </Card>
  );
}

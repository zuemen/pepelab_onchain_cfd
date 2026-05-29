import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useDisplayName } from 'src/hooks/useDisplayName';
import { pepeNameFor } from 'src/lib/pepefi/pepeName';

import { PepeAvatar } from './PepeAvatar';

// ----------------------------------------------------------------------

type Props = {
  address?: string | null;
  size?: number;
  vertical?: boolean;
};

export function PepeIdentity({ address, size = 56, vertical = false }: Props) {
  const [displayName] = useDisplayName(address);
  const name = displayName || pepeNameFor(address);

  return (
    <Stack
      direction={vertical ? 'column' : 'row'}
      alignItems="center"
      gap={1.5}
    >
      <PepeAvatar address={address ?? undefined} size={size} />
      <Box>
        <Typography fontWeight={800} fontSize={size > 40 ? 15 : 12} noWrap sx={{ maxWidth: 140 }}>
          {name}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ fontFamily: 'monospace', fontSize: 10 }}>
          {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ''}
        </Typography>
      </Box>
    </Stack>
  );
}

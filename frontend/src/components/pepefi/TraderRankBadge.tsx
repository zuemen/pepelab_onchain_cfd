import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { getPepeRank } from 'src/utils/pepefi-assets';

interface Props {
  reputation: number | bigint | null;
  size?: 'sm' | 'md';
}

export default function TraderRankBadge({ reputation, size = 'sm' }: Props) {
  const rank = getPepeRank(reputation);

  return (
    <Chip
      size={size === 'sm' ? 'small' : 'medium'}
      variant="outlined"
      label={
        <>
          <Typography component="span" variant="caption" sx={{ opacity: 0.8, mr: 0.5, fontWeight: 'bold', fontSize: '0.675rem' }}>
            RANK
          </Typography>
          <Typography component="span" variant="caption" sx={{ fontWeight: 'black', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {rank.label.split(' ')[0]}
          </Typography>
        </>
      }
      sx={{
        background: rank.gradient,
        color: '#ffffff',
        borderColor: rank.borderColor,
        boxShadow: rank.shadow,
        fontWeight: 'bold',
        textShadow: '0 1px 2px rgba(0,0,0,0.5)',
        '& .MuiChip-label': {
          display: 'inline-flex',
          alignItems: 'center',
          px: 1.2,
        },
        '&:hover': {
          boxShadow: rank.shadow.replace('12px', '18px'),
        }
      }}
    />
  );
}

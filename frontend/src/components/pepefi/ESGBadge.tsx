import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';

interface Props {
  composite: number;
  rating:    string;
  size?:     'sm' | 'md';
}

export default function ESGBadge({ composite, rating, size = 'sm' }: Props) {
  const getBadgeColors = () => {
    if (composite >= 80) {
      return {
        bgcolor: 'rgba(34, 197, 94, 0.16)',
        color: '#22c55e',
        borderColor: 'rgba(34, 197, 94, 0.24)',
      };
    }
    if (composite >= 60) {
      return {
        bgcolor: 'rgba(0, 184, 217, 0.16)',
        color: '#00b8d9',
        borderColor: 'rgba(0, 184, 217, 0.24)',
      };
    }
    if (composite >= 40) {
      return {
        bgcolor: 'rgba(255, 171, 0, 0.16)',
        color: '#ffab00',
        borderColor: 'rgba(255, 171, 0, 0.24)',
      };
    }
    return {
      bgcolor: 'rgba(255, 86, 48, 0.16)',
      color: '#ff5630',
      borderColor: 'rgba(255, 86, 48, 0.24)',
    };
  };

  const colors = getBadgeColors();

  return (
    <Chip
      size={size === 'sm' ? 'small' : 'medium'}
      variant="outlined"
      label={
        <>
          <Typography component="span" variant="caption" sx={{ opacity: 0.7, mr: 0.5, fontWeight: 'medium' }}>
            ESG
          </Typography>
          <Typography component="span" variant="caption" sx={{ fontWeight: 'bold', mr: 0.5 }}>
            {rating}
          </Typography>
          <Typography component="span" variant="caption" sx={{ opacity: 0.7 }}>
            {composite}
          </Typography>
        </>
      }
      sx={{
        bgcolor: colors.bgcolor,
        color: colors.color,
        borderColor: colors.borderColor,
        fontWeight: 'bold',
        '& .MuiChip-label': {
          display: 'inline-flex',
          alignItems: 'center',
          px: 1,
        },
      }}
    />
  );
}

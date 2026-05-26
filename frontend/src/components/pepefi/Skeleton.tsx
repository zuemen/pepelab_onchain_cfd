import MuiSkeleton from '@mui/material/Skeleton';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';

interface Props {
  className?: string;
  width?: string | number;
  height?: string | number;
  variant?: 'text' | 'rectangular' | 'rounded' | 'circular';
  sx?: any;
}

export default function Skeleton({ className, width, height, variant = 'rounded', sx }: Props) {
  return (
    <MuiSkeleton
      variant={variant}
      width={width}
      height={height}
      sx={{ bgcolor: 'action.hover', ...sx }}
    />
  );
}

export function CardSkeleton() {
  return (
    <Card sx={{ p: 3 }}>
      <Stack spacing={2}>
        <MuiSkeleton variant="text" width={128} height={20} />
        <MuiSkeleton variant="rectangular" width={192} height={40} sx={{ borderRadius: 1 }} />
        <MuiSkeleton variant="text" width="100%" height={16} />
      </Stack>
    </Card>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {Array.from({ length: cols }).map((_, i) => (
          <MuiSkeleton key={i} variant="text" height={16} />
        ))}
      </Box>
      {Array.from({ length: rows }).map((_, r) => (
        <Box key={r} sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {Array.from({ length: cols }).map((_, c) => (
            <MuiSkeleton key={c} variant="rectangular" height={32} sx={{ borderRadius: 1 }} />
          ))}
        </Box>
      ))}
    </Stack>
  );
}

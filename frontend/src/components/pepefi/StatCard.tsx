import Card from '@mui/material/Card';
import Typography from '@mui/material/Typography';

interface Props {
  title:       string;
  value:       string;
  sub?:        string;
  valueClass?: string;
  valueColor?: string;
}

export default function StatCard({ title, value, sub, valueClass = '', valueColor }: Props) {
  // Map Tailwind colors to MUI colors if valueClass is provided
  let color = valueColor || 'text.primary';
  if (!valueColor && valueClass) {
    if (valueClass.includes('green') || valueClass.includes('emerald')) {
      color = 'success.main';
    } else if (valueClass.includes('red')) {
      color = 'error.main';
    } else if (valueClass.includes('blue') || valueClass.includes('sky')) {
      color = 'info.main';
    } else if (valueClass.includes('gray') || valueClass.includes('slate')) {
      color = 'text.secondary';
    }
  }

  return (
    <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 'bold' }}>
        {title}
      </Typography>
      <Typography variant="h4" sx={{ color, fontWeight: 'bold' }}>
        {value}
      </Typography>
      {sub && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {sub}
        </Typography>
      )}
    </Card>
  );
}

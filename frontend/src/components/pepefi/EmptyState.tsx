import Card from '@mui/material/Card';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';

interface Props {
  icon?: string;
  title: string;
  description?: string;
  ctaText?: string;
  ctaHref?: string;
  onClick?: () => void;
}

export default function EmptyState({ icon = '🎯', title, description, ctaText, ctaHref, onClick }: Props) {
  return (
    <Card sx={{ p: 6, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <Box sx={{ fontSize: '3.5rem' }}>{icon}</Box>
      <Typography variant="h6" sx={{ color: 'text.primary', fontWeight: 'bold' }}>
        {title}
      </Typography>
      {description && (
        <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 400, mx: 'auto' }}>
          {description}
        </Typography>
      )}
      {ctaText && (ctaHref || onClick) && (
        <Button
          variant="contained"
          color="primary"
          href={ctaHref}
          component={ctaHref ? 'a' : 'button'}
          onClick={onClick}
          sx={{ mt: 1 }}
        >
          {ctaText} →
        </Button>
      )}
    </Card>
  );
}

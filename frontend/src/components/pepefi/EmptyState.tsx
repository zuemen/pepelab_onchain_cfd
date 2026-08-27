import Card from '@mui/material/Card';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';

interface Props {
  icon?: string;
  title: string;
  description?: string;
  ctaText?: string;
  ctaHref?: string;
  onClick?: () => void;
  /** 次要出口，例如「順帶看看文件」。永遠畫在主要 CTA 旁邊，樣式較輕。 */
  secondaryCtaText?: string;
  secondaryCtaHref?: string;
  onSecondaryClick?: () => void;
}

export default function EmptyState({
  icon = '🎯', title, description, ctaText, ctaHref, onClick,
  secondaryCtaText, secondaryCtaHref, onSecondaryClick,
}: Props) {
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
      {(() => {
        const showPrimary   = Boolean(ctaText && (ctaHref || onClick));
        const showSecondary = Boolean(secondaryCtaText && (secondaryCtaHref || onSecondaryClick));
        if (!showPrimary && !showSecondary) return null;
        return (
          <Stack direction="row" spacing={1.5} sx={{ mt: 1 }}>
            {showPrimary && (
              <Button
                variant="contained"
                color="primary"
                href={ctaHref}
                component={ctaHref ? 'a' : 'button'}
                onClick={onClick}
              >
                {ctaText} →
              </Button>
            )}
            {showSecondary && (
              <Button
                variant="outlined"
                color="inherit"
                href={secondaryCtaHref}
                component={secondaryCtaHref ? 'a' : 'button'}
                onClick={onSecondaryClick}
              >
                {secondaryCtaText}
              </Button>
            )}
          </Stack>
        );
      })()}
    </Card>
  );
}

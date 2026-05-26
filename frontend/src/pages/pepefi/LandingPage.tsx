import { Link as RouterLink, Navigate } from 'react-router';
import { usePepefiWallet } from 'src/layouts/pepefi';
import WalletButton from 'src/components/pepefi/WalletButton';

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Button from '@mui/material/Button';

const FEATURES = [
  { icon: '📈', title: 'Synthetic CFD Perpetuals', desc: '合成衍生品永續合約，全程透明上鏈，無需中心化交易所。' },
  { icon: '🔗', title: 'One-Click Copy Trading', desc: '一鍵跟單頂尖交易者，授權 USDC 後自動按比例開倉。' },
  { icon: '🌿', title: 'ESG Scoring', desc: '每位交易者皆有 ESG 評分，讓投資更有責任感與透明度。' },
  { icon: '🏦', title: 'Insurance Vault', desc: '提供流動性賺取協議費用，同時作為極端損失的保險池。' },
];

const STEPS = [
  { n: '01', text: '安裝 MetaMask，切換到 Sepolia testnet' },
  { n: '02', text: '前往 Exchange，點擊「Get 1000 mUSDC」取得測試資金' },
  { n: '03', text: '到 Marketplace 複製 Demo Alpha 交易者策略' },
  { n: '04', text: '（可選）在 Trader 頁面登記成為交易者並公開策略' },
];

export default function LandingPage() {
  const wallet = usePepefiWallet();
  if (wallet.isConnected) return <Navigate to="/dashboard" replace />;

  return (
    <Box
      sx={{
        minHeight: '100vh',
        background: 'linear-gradient(160deg, #0a1628 0%, #0d1f12 55%, #0a1628 100%)',
        pt: 8,
        pb: 8,
      }}
    >
      <Container maxWidth="md">
        {/* ── Logo / Brand ── */}
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mb: 6, textAlign: 'center' }}>
          {/* PepeFi Logo Block */}
          <Stack spacing={2} alignItems="center" sx={{ mb: 4 }}>
            {/* Icon */}
            <Box
              sx={{
                display: 'flex',
                height: 80,
                width: 80,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 2,
                fontSize: '2.5rem',
                background: 'linear-gradient(135deg, #065f46, #059669)',
                boxShadow: '0 0 32px rgba(5,150,105,0.4)',
              }}
            >
              🐸
            </Box>

            {/* Name */}
            <Box>
              <Typography
                variant="h1"
                sx={{
                  fontSize: { xs: '3rem', sm: '3.75rem' },
                  fontWeight: 900,
                  tracking: -1,
                  background: 'linear-gradient(90deg, #34d399 0%, #059669 60%, #a3e635 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                PepeFi
              </Typography>
              <Typography
                variant="overline"
                sx={{
                  color: 'text.secondary',
                  fontWeight: 'bold',
                  letterSpacing: '0.25em',
                  display: 'block',
                  mt: 0.5,
                }}
              >
                On-Chain CFD Protocol
              </Typography>
            </Box>
          </Stack>

          {/* Tagline */}
          <Typography variant="h4" sx={{ color: 'text.primary', fontWeight: 'bold', mb: 2, px: 2 }}>
            鏈上合成衍生品跟單系統
          </Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary', maxWidth: 540, mb: 4, px: 2, lineHeight: 1.6 }}>
            結合 Synthetic CFD 永續合約與一鍵 Copy Trading，
            交易者公開策略，跟單者授權 USDC 自動跟進，全程上鏈透明。
          </Typography>

          {/* Testnet badge */}
          <Chip
            label="Deployed on Sepolia Testnet"
            variant="outlined"
            color="success"
            icon={
              <Box
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  bgcolor: 'success.main',
                  animation: 'pulse 1.5s infinite',
                  '@keyframes pulse': {
                    '0%': { transform: 'scale(0.8)', opacity: 0.5 },
                    '50%': { transform: 'scale(1.2)', opacity: 1 },
                    '100%': { transform: 'scale(0.8)', opacity: 0.5 },
                  },
                }}
              />
            }
            sx={{
              mb: 4,
              borderColor: 'rgba(34, 197, 94, 0.24)',
              bgcolor: 'rgba(34, 197, 94, 0.08)',
              color: '#22c55e',
              px: 1,
            }}
          />

          {/* CTA */}
          <WalletButton wallet={wallet} />
          {wallet.error && (
            <Typography variant="caption" color="error" sx={{ mt: 1.5 }}>
              {wallet.error}
            </Typography>
          )}
          <Typography variant="caption" sx={{ color: 'text.secondary', opacity: 0.6, mt: 1.5 }}>
            連線後可直接瀏覽所有功能，無需註冊帳號
          </Typography>
        </Box>

        {/* ── Divider ── */}
        <Divider sx={{ my: 6, opacity: 0.15 }} />

        {/* ── Features ── */}
        <Box sx={{ mb: 6 }}>
          <Typography variant="overline" color="text.secondary" align="center" display="block" sx={{ mb: 3, fontWeight: 'bold', letterSpacing: 2 }}>
            核心功能
          </Typography>
          <Grid container spacing={2}>
            {FEATURES.map((f) => (
              <Grid size={{ xs: 12, sm: 6 }} key={f.title}>
                <Card
                  sx={{
                    p: 3,
                    height: '100%',
                    bgcolor: 'rgba(255,255,255,0.02)',
                    borderColor: 'rgba(255,255,255,0.05)',
                    transition: 'all 0.2s',
                    '&:hover': {
                      bgcolor: 'rgba(255,255,255,0.04)',
                      borderColor: 'rgba(0, 167, 111, 0.2)',
                    },
                  }}
                >
                  <Box
                    sx={{
                      mb: 2,
                      display: 'flex',
                      height: 40,
                      width: 40,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 1.5,
                      bgcolor: 'rgba(255,255,255,0.05)',
                      fontSize: '1.25rem',
                    }}
                  >
                    {f.icon}
                  </Box>
                  <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 'bold', mb: 1 }}>
                    {f.title}
                  </Typography>
                  <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.5 }}>
                    {f.desc}
                  </Typography>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Box>

        {/* ── How to Start ── */}
        <Box sx={{ mb: 4 }}>
          <Card
            sx={{
              p: 3.5,
              bgcolor: 'rgba(0, 167, 111, 0.02)',
              borderColor: 'rgba(0, 167, 111, 0.1)',
            }}
          >
            <Typography variant="overline" color="primary" display="block" sx={{ mb: 2.5, fontWeight: 'bold', letterSpacing: 2 }}>
              如何開始
            </Typography>
            <Stack spacing={2.5}>
              {STEPS.map((s) => (
                <Box key={s.n} sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                  <Box
                    sx={{
                      display: 'flex',
                      height: 28,
                      width: 28,
                      flexShrink: 0,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '50%',
                      bgcolor: 'rgba(0, 167, 111, 0.1)',
                      border: '1px solid',
                      borderColor: 'rgba(0, 167, 111, 0.3)',
                      color: 'primary.main',
                      fontSize: '0.75rem',
                      fontWeight: 'bold',
                    }}
                  >
                    {s.n}
                  </Box>
                  <Typography variant="body2" sx={{ color: 'text.primary', pt: 0.3, lineHeight: 1.5 }}>
                    {s.text}
                  </Typography>
                </Box>
              ))}
            </Stack>

            {/* Quick links */}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 3, pt: 3, borderTop: '1px solid', borderColor: 'divider' }}>
              {[
                { label: '💱 Exchange', to: '/exchange' },
                { label: '🏪 Marketplace', to: '/marketplace' },
                { label: '🏦 Vault', to: '/vault' },
              ].map((link) => (
                <Button
                  key={link.label}
                  component={RouterLink}
                  to={link.to}
                  variant="outlined"
                  size="small"
                  color="inherit"
                  sx={{
                    borderRadius: 1,
                    textTransform: 'none',
                    borderColor: 'divider',
                    color: 'text.secondary',
                    '&:hover': {
                      borderColor: 'text.primary',
                      color: 'text.primary',
                      bgcolor: 'rgba(255,255,255,0.03)',
                    },
                  }}
                >
                  {link.label}
                </Button>
              ))}
            </Box>
          </Card>

          <Typography variant="caption" display="block" align="center" sx={{ color: 'text.secondary', opacity: 0.5, mt: 2 }}>
            ⚠ Oracle 價格由部署者（admin）控制，Demo 期間會即時更新以展示 PnL 變化
          </Typography>
        </Box>
      </Container>
    </Box>
  );
}

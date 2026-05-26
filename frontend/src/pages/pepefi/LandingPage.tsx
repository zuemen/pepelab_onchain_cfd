import { Link as RouterLink } from 'react-router';
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
              component="img"
              src="/assets/images/pepefi/pepe_eth.jpg"
              alt="PepeFi Logo"
              sx={{
                height: 96,
                width: 96,
                borderRadius: '50%',
                border: '3px solid #34d399',
                boxShadow: '0 0 32px rgba(52,211,153,0.6)',
              }}
            />

            {/* Name */}
            <Box>
              <Typography
                variant="h1"
                sx={{
                  fontSize: { xs: '3.5rem', sm: '4.5rem' },
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
                  fontSize: '0.875rem',
                }}
              >
                On-Chain CFD Protocol
              </Typography>
            </Box>
          </Stack>

          {/* Tagline */}
          <Typography variant="h3" sx={{ color: 'text.primary', fontWeight: 'bold', mb: 2, px: 2 }}>
            鏈上合成衍生品跟單系統
          </Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary', maxWidth: 580, mb: 4, px: 2, lineHeight: 1.6, fontSize: '1.25rem' }}>
            結合 Synthetic CFD 永續合約與一鍵 Copy Trading，
            交易者公開策略，跟單者授權 USDC 自動跟進，全程上鏈透明。
          </Typography>

          {/* Hero Banner Space Rocket Pepe - Styled with Premium Glowing Border Frame */}
          <Box
            sx={{
              position: 'relative',
              borderRadius: 3,
              overflow: 'hidden',
              mb: 5,
              p: '3px',
              background: 'linear-gradient(135deg, #34d399 0%, #a3e635 100%)',
              boxShadow: '0 20px 48px rgba(0,0,0,0.8), 0 0 32px rgba(52, 211, 153, 0.3)',
              width: '100%',
              maxWidth: 640,
              transition: 'transform 0.3s ease',
              '&:hover': {
                transform: 'scale(1.02)',
              }
            }}
          >
            <Box
              component="img"
              src="/assets/images/pepefi/pepe_11.png"
              alt="Pepe Rocket Space Trader"
              sx={{
                width: '100%',
                height: 320,
                objectFit: 'cover',
                borderRadius: '10px',
                display: 'block',
              }}
            />
          </Box>

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
              px: 2,
              py: 1,
              fontSize: '0.95rem',
              fontWeight: 'bold',
            }}
          />

          {/* CTA */}
          <WalletButton wallet={wallet} />
          {wallet.error && (
            <Typography variant="caption" color="error" sx={{ mt: 1.5 }}>
              {wallet.error}
            </Typography>
          )}
          <Typography variant="caption" sx={{ color: 'text.secondary', opacity: 0.8, mt: 2, fontSize: '0.95rem' }}>
            連線後可直接瀏覽所有功能，無需註冊帳號
          </Typography>
        </Box>

        {/* ── Divider ── */}
        <Divider sx={{ my: 6, opacity: 0.15 }} />

        {/* ── Features ── */}
        <Box sx={{ mb: 6 }}>
          <Typography variant="overline" color="text.secondary" align="center" display="block" sx={{ mb: 3.5, fontWeight: 'bold', letterSpacing: 3, fontSize: '1rem' }}>
            核心功能
          </Typography>
          <Grid container spacing={2.5}>
            {FEATURES.map((f) => (
              <Grid size={{ xs: 12, sm: 6 }} key={f.title}>
                <Card
                  sx={{
                    p: 3.5,
                    height: '100%',
                    bgcolor: 'rgba(255,255,255,0.01)',
                    borderColor: 'rgba(255,255,255,0.05)',
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    '&:hover': {
                      bgcolor: 'rgba(52, 211, 153, 0.03)',
                      borderColor: '#34d399',
                      boxShadow: '0 12px 24px rgba(52, 211, 153, 0.12)',
                      transform: 'translateY(-6px)',
                    },
                  }}
                >
                  <Box
                    sx={{
                      mb: 2.5,
                      display: 'flex',
                      height: 48,
                      width: 48,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 1.5,
                      bgcolor: 'rgba(52, 211, 153, 0.1)',
                      color: '#34d399',
                      fontSize: '1.5rem',
                    }}
                  >
                    {f.icon}
                  </Box>
                  <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 'bold', mb: 1.5, fontSize: '1.2rem' }}>
                    {f.title}
                  </Typography>
                  <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6, fontSize: '1rem' }}>
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
              p: 4,
              bgcolor: 'rgba(52, 211, 153, 0.02)',
              borderColor: 'rgba(52, 211, 153, 0.15)',
              boxShadow: '0 8px 32px 0 rgba(52, 211, 153, 0.05)',
              border: '1px solid rgba(52, 211, 153, 0.2)',
              position: 'relative',
              overflow: 'hidden',
              '&::after': {
                content: '""',
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '4px',
                background: 'linear-gradient(90deg, #34d399, #a3e635)',
              }
            }}
          >
            <Typography variant="overline" color="primary" display="block" sx={{ mb: 3, fontWeight: 'bold', letterSpacing: 2.5, fontSize: '1.1rem' }}>
              如何開始
            </Typography>
            <Stack spacing={3}>
              {STEPS.map((s) => (
                <Box key={s.n} sx={{ display: 'flex', alignItems: 'flex-start', gap: 2.5 }}>
                  <Box
                    sx={{
                      display: 'flex',
                      height: 32,
                      width: 32,
                      flexShrink: 0,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '50%',
                      bgcolor: 'rgba(52, 211, 153, 0.15)',
                      border: '1px solid',
                      borderColor: 'rgba(52, 211, 153, 0.4)',
                      color: 'primary.main',
                      fontSize: '0.875rem',
                      fontWeight: 'bold',
                    }}
                  >
                    {s.n}
                  </Box>
                  <Typography variant="body2" sx={{ color: 'text.primary', pt: 0.4, lineHeight: 1.6, fontSize: '1.05rem' }}>
                    {s.text}
                  </Typography>
                </Box>
              ))}
            </Stack>

            {/* Quick links */}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mt: 4, pt: 3, borderTop: '1px solid', borderColor: 'divider' }}>
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
                  size="medium"
                  color="inherit"
                  sx={{
                    borderRadius: 1,
                    textTransform: 'none',
                    borderColor: 'divider',
                    color: 'text.secondary',
                    fontSize: '0.95rem',
                    px: 2.5,
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

          <Typography variant="caption" display="block" align="center" sx={{ color: 'text.secondary', opacity: 0.6, mt: 2.5, fontSize: '0.875rem' }}>
            ⚠ Oracle 價格由部署者（admin）控制，Demo 期間會即時更新以展示 PnL 變化
          </Typography>
        </Box>
      </Container>
    </Box>
  );
}

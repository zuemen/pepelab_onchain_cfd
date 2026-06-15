import { Link as RouterLink } from 'react-router';
import { usePepefiWallet } from 'src/layouts/pepefi';
import WalletButton from 'src/components/pepefi/WalletButton';
import HeroKpiStrip from 'src/components/pepefi/HeroKpiStrip';
import { MONO } from 'src/components/pepefi/brandKit';

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
  { icon: '🤖', title: 'x402 Paid Signals', desc: 'Agent 自帶錢包、按次付費購買交易訊號，收入 70/20/10 上鏈分潤。' },
  { icon: '⚡', title: 'Agent-Native Trading', desc: 'session key 有界委派，AI agent 付費後可自主在鏈上開受限部位。' },
];

const STEPS = [
  { n: '01', text: '安裝 MetaMask，切換到 Base Sepolia testnet' },
  { n: '02', text: '前往 Exchange，點擊「Get 1000 USDC」取得測試資金' },
  { n: '03', text: '到 Marketplace 複製 Demo Alpha 交易者策略' },
  { n: '04', text: '（可選）在 Trader 頁面登記成為交易者並公開策略' },
];

export default function LandingPage() {
  const wallet = usePepefiWallet();

  return (
    <Box
      sx={{
        minHeight: '100vh',
        background: 'radial-gradient(120% 80% at 80% -10%, rgba(124,193,74,0.10) 0%, transparent 55%), linear-gradient(165deg, #0A0F0B 0%, #0d1f12 55%, #0A0F0B 100%)',
        pt: 8,
        pb: 8,
      }}
    >
      <Container maxWidth="md">
        {/* ── HERO ── */}
        <Box sx={{ position: 'relative', mb: 6 }}>
          {/* Floating decorations */}
          {[
            { top: '0%',  left: '2%',   fontSize: 40, content: '🚀', delay: '0s' },
            { top: '10%', right: '3%',  fontSize: 36, content: '💰', delay: '0.4s' },
            { top: '30%', left: '1%',   fontSize: 28, content: '✨', delay: '0.8s' },
            { top: '55%', right: '2%',  fontSize: 32, content: '🌙', delay: '0.2s' },
            { top: '70%', left: '5%',   fontSize: 24, content: '⚡', delay: '1s' },
            { top: '80%', right: '8%',  fontSize: 28, content: '🔥', delay: '0.6s' },
          ].map((d, i) => (
            <Box key={i} sx={{
              position: 'absolute', fontSize: d.fontSize, pointerEvents: 'none', userSelect: 'none',
              top: d.top, left: 'left' in d ? d.left : undefined, right: 'right' in d ? d.right : undefined,
              animation: 'floatBob 3s ease-in-out infinite',
              animationDelay: d.delay,
              '@keyframes floatBob': {
                '0%,100%': { transform: 'translateY(0)' },
                '50%': { transform: 'translateY(-12px)' },
              },
              display: { xs: 'none', md: 'block' },
            }}>
              {d.content}
            </Box>
          ))}

          {/* Two-column layout: text left, Pepe right */}
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            alignItems="center"
            justifyContent="space-between"
            spacing={4}
          >
            {/* Left: text */}
            <Box sx={{ flex: 1, textAlign: { xs: 'center', md: 'left' } }}>
              {/* PepeLab wordmark */}
              <Typography
                variant="h1"
                sx={{
                  fontSize: { xs: '4rem', md: '7rem' },
                  fontWeight: 900,
                  lineHeight: 0.95,
                  color: '#7cc14a',
                  textShadow: '-1px -1px 0 #FFD23D, 1px -1px 0 #FFD23D, -1px 1px 0 #FFD23D, 1px 1px 0 #FFD23D, 0 0 40px rgba(124,193,74,0.6)',
                  mb: 1.5,
                }}
              >
                PepeLab
              </Typography>

              {/* Mono kicker — "on-chain terminal" cred */}
              <Typography sx={{
                fontFamily: MONO,
                fontSize: { xs: '0.8rem', md: '0.95rem' },
                fontWeight: 600,
                letterSpacing: { xs: '1px', md: '2px' },
                color: '#7cc14a',
                textTransform: 'uppercase',
                mb: 2.5,
              }}>
                {'>'} agent-native RWA perpetuals · on Base
              </Typography>

              {/* Meme energy tagline */}
              <Typography sx={{
                fontSize: { xs: '0.95rem', md: '1.35rem' },
                fontWeight: 700,
                letterSpacing: { xs: '2px', md: '3px' },
                color: '#cad8b0',
                textTransform: 'uppercase',
                mb: 3,
              }}>
                DeFi · SocialFi · GameFi · MemeFi 🐸
              </Typography>

              <Typography variant="body1" sx={{
                color: 'text.secondary',
                maxWidth: 500,
                lineHeight: 1.7,
                fontSize: { xs: '1rem', md: '1.15rem' },
                mb: 4,
                mx: { xs: 'auto', md: 0 },
              }}>
                對標 Hyperliquid 的鏈上永續 + agent 經濟。5x 槓桿合成/RWA 永續、社交跟單、
                做市金庫，外加 <b style={{ color: '#7cc14a' }}>x402 付費訊號</b>——讓 AI agent
                自帶錢包、付費、自主下單。全程透明上鏈。
              </Typography>

              <Stack direction="row" spacing={2} justifyContent={{ xs: 'center', md: 'flex-start' }} flexWrap="wrap">
                <WalletButton wallet={wallet} />
                {wallet.isConnected && (
                  <Button
                    component={RouterLink}
                    to="/dashboard"
                    variant="contained"
                    size="large"
                    sx={{ bgcolor: '#7cc14a', color: '#fff', fontWeight: 900, '&:hover': { bgcolor: '#5a9e2f' } }}
                  >
                    🐸 進入 Dashboard
                  </Button>
                )}
                <Button
                  component={RouterLink}
                  to="/marketplace"
                  variant="outlined"
                  size="large"
                  sx={{ borderColor: '#7cc14a', color: '#7cc14a', '&:hover': { bgcolor: 'rgba(124,193,74,0.1)' } }}
                >
                  View Traders
                </Button>
              </Stack>
            </Box>

            {/* Right: Pepe hero image */}
            <Box sx={{
              position: 'relative',
              flexShrink: 0,
              width: { xs: 220, md: 360 },
              height: { xs: 220, md: 360 },
            }}>
              {/* Glow ring */}
              <Box sx={{
                position: 'absolute', inset: -8,
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(124,193,74,0.4) 0%, transparent 70%)',
                animation: 'pulse 2s ease-in-out infinite',
                '@keyframes pulse': {
                  '0%,100%': { opacity: 0.6, transform: 'scale(1)' },
                  '50%': { opacity: 1, transform: 'scale(1.05)' },
                },
              }} />
              <Box
                component="img"
                src="/avatars/pepe-01.png"
                alt="PepeLab Mascot"
                sx={{
                  width: '100%', height: '100%',
                  borderRadius: '50%',
                  objectFit: 'cover',
                  border: '4px solid #7cc14a',
                  boxShadow: '0 0 48px rgba(124,193,74,0.5), 0 0 96px rgba(255,210,61,0.2)',
                  position: 'relative', zIndex: 1,
                }}
                onError={(e) => { (e.target as HTMLImageElement).src = '/assets/images/pepefi/pepe_eth.jpg'; }}
              />
              {/* Gold badge overlay */}
              <Box sx={{
                position: 'absolute', bottom: 12, right: 12, zIndex: 2,
                bgcolor: '#FFD23D', color: '#1C252E',
                borderRadius: '50%', width: 48, height: 48,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 22, fontWeight: 900,
                boxShadow: '0 4px 12px rgba(255,210,61,0.6)',
              }}>
                🐸
              </Box>
            </Box>
          </Stack>
        </Box>

        {/* ── Live on-chain KPI strip ── */}
        <HeroKpiStrip />

        <Stack alignItems="center" spacing={2} sx={{ mb: 4 }}>
          {/* Testnet badge */}
          <Chip
            label="Live on Base Sepolia · 84532"
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
          <Typography variant="caption" sx={{ color: 'text.secondary', opacity: 0.8, fontSize: '0.95rem' }}>
            連線後可直接瀏覽所有功能，無需註冊帳號
          </Typography>
        </Stack>

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
                      bgcolor: 'rgba(124, 193, 74, 0.03)',
                      borderColor: '#7cc14a',
                      boxShadow: '0 12px 24px rgba(124, 193, 74, 0.12)',
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
                      bgcolor: 'rgba(124, 193, 74, 0.1)',
                      color: '#7cc14a',
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
              bgcolor: 'rgba(124, 193, 74, 0.02)',
              borderColor: 'rgba(124, 193, 74, 0.15)',
              boxShadow: '0 8px 32px 0 rgba(124, 193, 74, 0.05)',
              border: '1px solid rgba(124, 193, 74, 0.2)',
              position: 'relative',
              overflow: 'hidden',
              '&::after': {
                content: '""',
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '4px',
                background: 'linear-gradient(90deg, #7cc14a, #FFD23D)',
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
                      bgcolor: 'rgba(124, 193, 74, 0.15)',
                      border: '1px solid',
                      borderColor: 'rgba(124, 193, 74, 0.4)',
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

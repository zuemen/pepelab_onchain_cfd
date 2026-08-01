import { Link as RouterLink } from 'react-router';
import { usePepefiWallet } from 'src/layouts/pepefi';
import WalletButton from 'src/components/pepefi/WalletButton';
import HeroKpiStrip from 'src/components/pepefi/HeroKpiStrip';
import PaperTradingBadge from 'src/components/pepefi/PaperTradingBadge';
import { MONO } from 'src/components/pepefi/brandKit';
import { Iconify } from 'src/components/iconify';

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
  // Iconify rather than emoji. Emoji render from whatever font the OS supplies,
  // so these six drew at six different weights and baselines depending on the
  // machine, and none of them could inherit the panel's colour. The mascot 🐸
  // stays — that is brand, not an icon.
  { icon: 'solar:chart-square-outline',            title: 'Synthetic CFD Perpetuals', desc: '合成衍生品永續合約，全程透明上鏈，無需中心化交易所。' },
  { icon: 'solar:copy-bold',                       title: 'One-Click Copy Trading',   desc: '一鍵跟單頂尖交易者，授權 USDC 後自動按比例開倉。' },
  { icon: 'solar:verified-check-bold',             title: 'ESG Scoring',              desc: '每位交易者皆有 ESG 評分，讓投資更有責任感與透明度。' },
  { icon: 'solar:shield-keyhole-bold-duotone',     title: 'Insurance Vault',          desc: '提供流動性賺取協議費用，同時作為極端損失的保險池。' },
  { icon: 'solar:wad-of-money-bold',               title: 'x402 Paid Signals',        desc: 'Agent 自帶錢包、按次付費購買交易訊號，收入 70/20/10 上鏈分潤。' },
  { icon: 'solar:atom-bold-duotone',               title: 'Agent-Native Trading',     desc: 'session key 有界委派，AI agent 付費後可自主在鏈上開受限部位。' },
  // `as const` so the icon strings keep their literal types. Iconify's `icon`
  // prop is a union of the 206 names registered in components/iconify/icon-sets
  // (which inlines each SVG body, so icons ship with the bundle rather than
  // being fetched). Without this the array widens to `string` and the check
  // that catches a typo'd or unregistered icon at compile time is lost.
] as const;

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
        // dvh, not vh: on mobile Safari/Chrome `100vh` is the viewport with the
        // URL bar *hidden*, so the hero overflows by the bar's height until the
        // user scrolls. dvh tracks the visible viewport.
        minHeight: '100dvh',
        background: 'radial-gradient(120% 80% at 80% -10%, rgba(124,193,74,0.10) 0%, transparent 55%), linear-gradient(165deg, #0A0F0B 0%, #0d1f12 55%, #0A0F0B 100%)',
        pt: 8,
        pb: 8,
      }}
    >
      <Container maxWidth="md">
        {/* ── HERO ── */}
        <Box sx={{ position: 'relative', mb: 6 }}>
          {/* Six floating emoji (🚀 💰 ✨ 🌙 ⚡ 🔥) used to bob around the hero
              on a 3s infinite loop. Removed rather than restyled:

              - They carried no meaning. The first thing a visitor evaluating a
                venue for tokenised RWAs saw was decoration.
              - ⚡ was ALSO one of the six feature icons below, so the same glyph
                meant "Agent-Native Trading" in one place and nothing at all in
                another, twelve hundred pixels apart.
              - @keyframes floatBob was declared inside the .map, so emotion
                emitted six identical copies of the same keyframe rule.

              The mascot and the wordmark carry the brand; these did not. */}

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
                  color: 'var(--palette-primary-main)',
                  textShadow: '-1px -1px 0 var(--palette-secondary-main), 1px -1px 0 var(--palette-secondary-main), -1px 1px 0 var(--palette-secondary-main), 1px 1px 0 var(--palette-secondary-main), 0 0 40px rgba(124,193,74,0.6)',
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
                color: 'var(--palette-primary-main)',
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
                做市金庫，外加 <b style={{ color: 'var(--palette-primary-main)' }}>x402 付費訊號</b>——讓 AI agent
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
                    // contrastText, not #fff: white on this green measures
                    // 2.19:1, below the 4.5:1 floor. The token is 7.08:1.
                    sx={{ bgcolor: 'var(--palette-primary-main)', color: 'primary.contrastText', fontWeight: 900, '&:hover': { bgcolor: 'var(--palette-primary-dark)' } }}
                  >
                    🐸 進入 Dashboard
                  </Button>
                )}
                <Button
                  component={RouterLink}
                  to="/marketplace"
                  variant="outlined"
                  size="large"
                  sx={{ borderColor: 'var(--palette-primary-main)', color: 'var(--palette-primary-main)', '&:hover': { bgcolor: 'rgba(124,193,74,0.1)' } }}
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
                  border: '4px solid var(--palette-primary-main)',
                  boxShadow: '0 0 48px rgba(124,193,74,0.5), 0 0 96px rgba(255,210,61,0.2)',
                  position: 'relative', zIndex: 1,
                }}
                onError={(e) => { (e.target as HTMLImageElement).src = '/assets/images/pepefi/pepe_eth.jpg'; }}
              />
              {/* Gold badge overlay */}
              <Box sx={{
                position: 'absolute', bottom: 12, right: 12, zIndex: 2,
                bgcolor: 'var(--palette-secondary-main)', color: '#1C252E',
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
          <PaperTradingBadge />

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

        {/* ── What is Paper Trading? ── */}
        <Box sx={{ py: 5, textAlign: 'center' }}>
          <Typography variant="h4" sx={{ fontWeight: 800, mb: 1.5 }}>
            什麼是 Paper Trading？
          </Typography>
          <Typography
            variant="body1"
            sx={{ maxWidth: 680, mx: 'auto', color: 'text.secondary', lineHeight: 1.9 }}
          >
            本平台使用<b>測試網代幣</b>進行模擬交易，讓使用者無風險體驗 RWA 投資、
            社交跟單與 AI 代理交易。<b>所有價格追蹤真實市場</b>，但資金為模擬資產，
            不涉及真實金錢 —— 等同 TradingView 的 Paper Trading 模式。
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
                      bgcolor: 'rgba(124, 193, 74, 0.03)',
                      borderColor: 'var(--palette-primary-main)',
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
                      color: 'primary.main',
                    }}
                  >
                    <Iconify icon={f.icon} width={26} />
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
                background: 'linear-gradient(90deg, var(--palette-primary-main), var(--palette-secondary-main))',
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
              {([
                { label: 'Exchange',    icon: 'solar:transfer-horizontal-bold-duotone', to: '/exchange' },
                { label: 'Marketplace', icon: 'solar:cart-3-bold',                      to: '/marketplace' },
                { label: 'Vault',       icon: 'solar:shield-keyhole-bold-duotone',      to: '/vault' },
              ] as const).map((link) => (
                <Button
                  key={link.label}
                  component={RouterLink}
                  to={link.to}
                  variant="outlined"
                  size="medium"
                  color="inherit"
                  startIcon={<Iconify icon={link.icon} width={18} />}
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

          {/* A real disclosure about who controls the price feed, previously set
              in caption size at opacity 0.6 — dimmed to roughly 2.5:1 against
              the panel, i.e. below the 4.5:1 floor, and read as decoration. If
              a venue is telling you an admin key moves the oracle, that has to
              be legible. Same words, no longer whispered. */}
          <Stack
            direction="row"
            spacing={1}
            alignItems="flex-start"
            justifyContent="center"
            sx={{ mt: 2.5, color: 'warning.main' }}
          >
            <Iconify icon="solar:danger-triangle-bold" width={18} sx={{ mt: '1px', flexShrink: 0 }} />
            <Typography variant="body2" align="center" sx={{ fontSize: '0.875rem' }}>
              Oracle 價格由部署者（admin）控制，Demo 期間會即時更新以展示 PnL 變化
            </Typography>
          </Stack>
        </Box>
      </Container>
    </Box>
  );
}

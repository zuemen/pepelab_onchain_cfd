import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useMemo } from 'react';
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip as RadarTooltip,
} from 'recharts';
import { useContracts } from 'src/hooks/useContracts';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { useESG } from 'src/hooks/useESG';
import { ASSET_IDS } from 'src/contracts/addresses';
import { t, interpolate } from 'src/locales';
import { ASSET_META } from 'src/lib/pepefi/assetMeta';
import ESGBadge from 'src/components/pepefi/ESGBadge';
import Skeleton from 'src/components/pepefi/Skeleton';

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import LinearProgress from '@mui/material/LinearProgress';
import ButtonBase from '@mui/material/ButtonBase';

// ── All 11 asset IDs ──────────────────────────────────────────────────────────

const ALL_ASSET_IDS = [
  ASSET_IDS.sBTC,  ASSET_IDS.sETH,   ASSET_IDS.sAAPL, ASSET_IDS.sTSLA,
  ASSET_IDS.sGOLD, ASSET_IDS.sBOND,  ASSET_IDS.sNVDA, ASSET_IDS.sMSFT,
  ASSET_IDS.sGOOGL,ASSET_IDS.sICLN,  ASSET_IDS.sESGU,
];

// ── Rating table (7 tiers, AAA → CCC) ────────────────────────────────────────

const RATING_TABLE = [
  { rating: 'AAA', min: 80,  label: t.esg.rating.aaa, desc: t.esg.rating.aaaDesc, color: '#00b8d9', bg: 'rgba(0, 184, 217, 0.16)' },
  { rating: 'AA',  min: 70,  label: t.esg.rating.aa,  desc: t.esg.rating.aaDesc,  color: '#22c55e', bg: 'rgba(34, 197, 94, 0.16)' },
  { rating: 'A',   min: 60,  label: t.esg.rating.a,   desc: t.esg.rating.aDesc,   color: '#bef264', bg: 'rgba(190, 242, 100, 0.16)' },
  { rating: 'BBB', min: 50,  label: t.esg.rating.bbb, desc: t.esg.rating.bbbDesc, color: '#ffab00', bg: 'rgba(255, 171, 0, 0.16)' },
  { rating: 'BB',  min: 40,  label: t.esg.rating.bb,  desc: t.esg.rating.bbDesc,  color: '#ff5630', bg: 'rgba(255, 86, 48, 0.16)' },
  { rating: 'B',   min: 30,  label: t.esg.rating.b,   desc: t.esg.rating.bDesc,   color: '#ff5630', bg: 'rgba(255, 86, 48, 0.12)' },
  { rating: 'CCC', min: 0,   label: t.esg.rating.ccc, desc: t.esg.rating.cccDesc, color: '#ff5630', bg: 'rgba(255, 86, 48, 0.08)' },
];

// ── One-line rationale per asset ──────────────────────────────────────────────

const ESG_RATIONALE: Record<string, string> = {
  [ASSET_IDS.sBTC]:   t.esg.rationale.sBTC,
  [ASSET_IDS.sETH]:   t.esg.rationale.sETH,
  [ASSET_IDS.sAAPL]:  t.esg.rationale.sAAPL,
  [ASSET_IDS.sTSLA]:  t.esg.rationale.sTSLA,
  [ASSET_IDS.sGOLD]:  t.esg.rationale.sGOLD,
  [ASSET_IDS.sBOND]:  t.esg.rationale.sBOND,
  [ASSET_IDS.sNVDA]:  t.esg.rationale.sNVDA,
  [ASSET_IDS.sMSFT]:  t.esg.rationale.sMSFT,
  [ASSET_IDS.sGOOGL]: t.esg.rationale.sGOOGL,
  [ASSET_IDS.sICLN]:  t.esg.rationale.sICLN,
  [ASSET_IDS.sESGU]:  t.esg.rationale.sESGU,
};

// ── Radar accent color per asset ──────────────────────────────────────────────

const RADAR_COLOR: Record<string, string> = {
  [ASSET_IDS.sBTC]:   '#f7931a',
  [ASSET_IDS.sETH]:   '#627eea',
  [ASSET_IDS.sAAPL]:  '#a2aaad',
  [ASSET_IDS.sTSLA]:  '#cc0000',
  [ASSET_IDS.sGOLD]:  '#ffd700',
  [ASSET_IDS.sBOND]:  '#10b981',
  [ASSET_IDS.sNVDA]:  '#76b900',
  [ASSET_IDS.sMSFT]:  '#00a4ef',
  [ASSET_IDS.sGOOGL]: '#ea4335',
  [ASSET_IDS.sICLN]:  '#00c853',
  [ASSET_IDS.sESGU]:  '#2e7d32',
};

// ── Category badge style ──────────────────────────────────────────────────────

const CAT_COLOR: Record<string, string> = {
  crypto:    'rgba(99, 102, 241, 0.16)',
  equity:    'rgba(168, 85, 247, 0.16)',
  commodity: 'rgba(245, 158, 11, 0.16)',
  etf:       'rgba(0, 184, 217, 0.16)',
  bond:      'rgba(16, 185, 129, 0.16)',
};

const CAT_TEXT_COLOR: Record<string, string> = {
  crypto:    '#6366f1',
  equity:    '#a855f7',
  commodity: '#f59e0b',
  etf:       '#00b8d9',
  bond:      '#10b981',
};

// ── Bar color by score ("綠/黃/紅 按分數") ───────────────────────────────────

const barColor = (score: number) =>
  score >= 65 ? 'success.main' :
  score >= 40 ? 'warning.main' : 'error.main';

const DIMS = [
  { key: 'environmental' as const, short: 'E', label: t.esg.dimension.environmental },
  { key: 'social'        as const, short: 'S', label: t.esg.dimension.social        },
  { key: 'governance'    as const, short: 'G', label: t.esg.dimension.governance    },
];

export default function ESGPage() {
  const wallet = usePepefiWallet();
  const contracts   = useContracts(wallet.provider, wallet.signer, wallet.chainId);
  const { data: esg, loaded: esgLoaded, error: esgFailed } = useESG(contracts?.esgRegistry ?? null);
  const [selected, setSelected] = useState<string>(ASSET_IDS.sESGU);

  const isLoading = wallet.isConnected && wallet.chainId === 11155111 && !esgLoaded;

  const sorted = useMemo(
    () =>
      [...ALL_ASSET_IDS].sort((a, b) => {
        const ca = esg[a]?.composite ?? -1;
        const cb = esg[b]?.composite ?? -1;
        return cb - ca;
      }),
    [esg]
  );

  const selInfo  = esg[selected];
  const selMeta  = ASSET_META[selected];
  const selColor = RADAR_COLOR[selected] ?? '#6366f1';

  const radarData = selInfo
    ? DIMS.map(d => ({ subject: d.label, value: selInfo[d.key], fullMark: 100 }))
    : [];

  return (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Header */}
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1.5 }}>
          {t.esg.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {t.esg.subtitle}
        </Typography>
      </Box>

      {!wallet.isConnected && (
        <Alert severity="info" variant="outlined" sx={{ py: 0 }}>
          {t.esg.connectWallet}
        </Alert>
      )}
      {wallet.isConnected && wallet.chainId !== 11155111 && (
        <Alert severity="warning" variant="outlined" sx={{ py: 0 }}>
          {t.esg.wrongNetwork}
        </Alert>
      )}
      {wallet.isConnected && wallet.chainId === 11155111 && esgFailed && (
        <Alert severity="error" variant="outlined" sx={{ py: 0 }}>
          {t.esg.loadFailed}
        </Alert>
      )}

      {/* ── A. Methodology ───────────────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3.5 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          {t.esg.methodology.title}
        </Typography>

        {/* Three dimensions */}
        <Grid container spacing={2}>
          {[
            {
              short: 'E', color: '#22c55e', label: t.esg.dimension.environmental,
              zh: t.esg.dimension.environmentalZh,
              items: t.esg.dimension.environmentalItems,
            },
            {
              short: 'S', color: '#00b8d9', label: t.esg.dimension.social,
              zh: t.esg.dimension.socialZh,
              items: t.esg.dimension.socialItems,
            },
            {
              short: 'G', color: '#86efac', label: t.esg.dimension.governance,
              zh: t.esg.dimension.governanceZh,
              items: t.esg.dimension.governanceItems,
            },
          ].map(({ short, color, label, zh, items }) => (
            <Grid size={{ xs: 12, md: 4 }} key={short}>
              <Box
                sx={{
                  borderRadius: 1.5,
                  border: '1px solid',
                  borderColor: `${color}30`,
                  bgcolor: `${color}08`,
                  p: 3,
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1.5,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                  <Typography variant="h4" sx={{ fontWeight: '900', color: color, fontFamily: MONO, lineHeight: 1 }}>
                    {short}
                  </Typography>
                  <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.primary' }}>
                    {label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {zh}
                  </Typography>
                </Box>
                <Stack spacing={0.5} component="ul" sx={{ pl: 0, m: 0 }}>
                  {items.map(item => (
                    <Typography
                      key={item}
                      component="li"
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, listStyle: 'none' }}
                    >
                      <Box component="span" sx={{ color: color }}>·</Box>
                      {item}
                    </Typography>
                  ))}
                </Stack>
              </Box>
            </Grid>
          ))}
        </Grid>

        {/* Rating table */}
        <Box>
          <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 2, fontWeight: 'bold' }}>
            {t.esg.methodology.ratingTable}
          </Typography>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)', md: 'repeat(7, 1fr)' },
              gap: 1.5,
            }}
          >
            {RATING_TABLE.map(({ rating, min, label, desc, color, bg }) => (
              <Box
                key={rating}
                sx={{
                  borderRadius: 1.5,
                  p: 2,
                  bgcolor: bg,
                  border: '1px solid',
                  borderColor: `${color}30`,
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 0.5,
                }}
              >
                <Typography variant="h5" sx={{ fontWeight: '900', color, fontFamily: MONO, lineHeight: 1 }}>
                  {rating}
                </Typography>
                <Typography variant="caption" sx={{ fontWeight: 'bold', color, fontSize: '0.6875rem' }}>
                  {label}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.625rem' }}>
                  {min > 0 ? interpolate(t.esg.rating.atLeast, { min }) : t.esg.rating.below30}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', md: 'block' }, fontSize: '0.5625rem', lineHeight: 1.2, mt: 0.5 }}>
                  {desc}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      </Card>

      {/* ── B (left) + C (right) ─────────────────────────────────────────────── */}
      <Grid container spacing={3} alignItems="flex-start">
        {/* B. 11-asset ranking */}
        <Grid size={{ xs: 12, md: 7 }}>
          <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 2, fontWeight: 'bold', letterSpacing: 1 }}>
            {t.esg.ranking.title}
          </Typography>

          <Stack spacing={1.5}>
            {sorted.map((id, rank) => {
              const info  = esg[id];
              const meta  = ASSET_META[id];
              const isSel = id === selected;

              return (
                <ButtonBase
                  key={id}
                  onClick={() => setSelected(id)}
                  sx={{
                    display: 'block',
                    width: '100%',
                    borderRadius: 1.5,
                    border: '1px solid',
                    p: 2.5,
                    textAlign: 'left',
                    transition: 'all 0.2s',
                    bgcolor: isSel ? 'rgba(0, 167, 111, 0.08)' : 'background.paper',
                    borderColor: isSel ? 'primary.main' : 'divider',
                    boxShadow: isSel ? '0 0 12px rgba(0, 167, 111, 0.16)' : 'none',
                    '&:hover': {
                      borderColor: isSel ? 'primary.main' : 'text.secondary',
                      bgcolor: isSel ? 'rgba(0, 167, 111, 0.12)' : 'rgba(255,255,255,0.02)',
                    },
                  }}
                >
                  {/* Top row */}
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: MONO, width: 24, textAlign: 'right' }}>
                      {interpolate(t.esg.ranking.rank, { n: rank + 1 })}
                    </Typography>
                    <Typography variant="h5" sx={{ fontSize: '1.25rem', lineHeight: 1 }}>{meta?.icon ?? '?'}</Typography>
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', fontFamily: MONO }}>
                          {meta?.symbol ?? '?'}
                        </Typography>
                        {meta && (
                          <Chip
                            label={meta.category}
                            size="small"
                            sx={{
                              fontSize: '0.625rem',
                              height: 18,
                              bgcolor: CAT_COLOR[meta.category] ?? 'action.hover',
                              color: CAT_TEXT_COLOR[meta.category] ?? 'text.secondary',
                              fontWeight: 'bold',
                              textTransform: 'uppercase',
                            }}
                          />
                        )}
                      </Box>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: 220 }}>
                        {meta?.name ?? ''}
                      </Typography>
                    </Box>

                    {/* Composite big number */}
                    {isLoading ? (
                      <Skeleton width={40} height={32} />
                    ) : info ? (
                      <Box sx={{ textAlign: 'right', mr: 2 }}>
                        <Typography variant="h5" sx={{ fontWeight: '800', fontFamily: MONO, lineHeight: 1, color: barColor(info.composite) }}>
                          {info.composite}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.625rem' }}>{t.esg.ranking.outOf}</Typography>
                      </Box>
                    ) : (
                      <Typography color="text.secondary">—</Typography>
                    )}

                    {info && (
                      <Box>
                        <ESGBadge composite={info.composite} rating={info.rating} size="sm" />
                      </Box>
                    )}
                  </Box>

                  {/* E/S/G progress bars */}
                  {isLoading ? (
                    <Stack spacing={1} sx={{ mt: 2 }}>
                      {DIMS.map(d => <Skeleton key={d.key} height={6} variant="rectangular" />)}
                    </Stack>
                  ) : info ? (
                    <Stack spacing={0.75} sx={{ mt: 2 }}>
                      {DIMS.map(({ key, short }) => {
                        const val = info[key];
                        const bc  = barColor(val);
                        return (
                          <Box key={key} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                            <Typography variant="caption" sx={{ fontWeight: 'bold', width: 12, color: bc }}>
                              {short}
                            </Typography>
                            <Box sx={{ flexGrow: 1 }}>
                              <LinearProgress
                                variant="determinate"
                                value={val}
                                sx={{
                                  height: 6,
                                  borderRadius: 3,
                                  bgcolor: 'background.neutral',
                                  '& .MuiLinearProgress-bar': {
                                    bgcolor: bc,
                                    borderRadius: 3,
                                  },
                                }}
                              />
                            </Box>
                            <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary', width: 24, textAlign: 'right' }}>
                              {val}
                            </Typography>
                          </Box>
                        );
                      })}
                    </Stack>
                  ) : null}

                  {/* Rationale */}
                  {ESG_RATIONALE[id] && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2, pt: 1.5, borderTop: '1px solid', borderColor: 'divider', fontStyle: 'italic', lineHeight: 1.5 }}>
                      {ESG_RATIONALE[id]}
                    </Typography>
                  )}
                </ButtonBase>
              );
            })}
          </Stack>
        </Grid>

        {/* C. Radar chart (sticky) */}
        <Grid size={{ xs: 12, md: 5 }} sx={{ position: { md: 'sticky' }, top: { md: 88 } }}>
          <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 2, fontWeight: 'bold', letterSpacing: 1 }}>
            {t.esg.radar.title}
          </Typography>

          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            {/* Selected asset header */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Typography variant="h4" sx={{ fontSize: '1.75rem', lineHeight: 1 }}>{selMeta?.icon ?? '?'}</Typography>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', fontFamily: MONO }}>
                  {selMeta?.symbol ?? '?'}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  {selMeta?.name ?? ''}
                </Typography>
              </Box>
              {selInfo && (
                <ESGBadge composite={selInfo.composite} rating={selInfo.rating} size="md" />
              )}
            </Box>

            {/* Radar chart */}
            {isLoading ? (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 240 }}>
                <Skeleton width={180} height={180} variant="circular" />
              </Box>
            ) : radarData.length === 0 ? (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 240 }}>
                <Typography variant="body2" color="text.secondary">{t.esg.radar.noData}</Typography>
              </Box>
            ) : (
              <Box sx={{ width: '100%', height: 240 }}>
                <ResponsiveContainer width="100%" height={240}>
                  <RadarChart data={radarData} margin={{ top: 8, right: 28, bottom: 8, left: 28 }}>
                    <PolarGrid stroke="rgba(255,255,255,0.06)" />
                    <PolarAngleAxis dataKey="subject" tick={{ fill: '#919eab', fontSize: 10, fontWeight: 500 }} />
                    <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fill: '#637381', fontSize: 8 }} tickCount={4} />
                    <Radar
                      name={selMeta?.symbol ?? ''}
                      dataKey="value"
                      stroke={selColor}
                      fill={selColor}
                      fillOpacity={0.2}
                      strokeWidth={2}
                    />
                    <RadarTooltip
                      contentStyle={{ background: '#161c24', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 11, color: '#fff' }}
                      itemStyle={{ color: '#fff' }}
                      formatter={(value: any) => [value as number, '']}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              </Box>
            )}

            {/* Dimension values list */}
            {selInfo && (
              <Stack spacing={1.5} sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 2.5 }}>
                {DIMS.map(({ key, short, label }) => {
                  const val = selInfo[key];
                  const bc  = barColor(val);
                  return (
                    <Box key={key} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Typography variant="caption" sx={{ fontWeight: 'bold', width: 14, color: bc }}>
                        {short}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ width: 80 }}>
                        {label}
                      </Typography>
                      <Box sx={{ flexGrow: 1 }}>
                        <LinearProgress
                          variant="determinate"
                          value={val}
                          sx={{
                            height: 6,
                            borderRadius: 3,
                            bgcolor: 'background.neutral',
                            '& .MuiLinearProgress-bar': {
                              bgcolor: bc,
                              borderRadius: 3,
                            },
                          }}
                        />
                      </Box>
                      <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 'bold', color: bc, width: 24, textAlign: 'right' }}>
                        {val}
                      </Typography>
                    </Box>
                  );
                })}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, borderTop: '1px solid', borderColor: 'divider', pt: 1.5, mt: 0.5 }}>
                  <Box sx={{ width: 14 }} />
                  <Typography variant="caption" sx={{ fontWeight: 'bold', width: 80 }}>
                    {t.esg.radar.composite}
                  </Typography>
                  <Box sx={{ flexGrow: 1 }}>
                    <LinearProgress
                      variant="determinate"
                      value={selInfo.composite}
                      sx={{
                        height: 6,
                        borderRadius: 3,
                        bgcolor: 'background.neutral',
                        '& .MuiLinearProgress-bar': {
                          bgcolor: barColor(selInfo.composite),
                          borderRadius: 3,
                        },
                      }}
                    />
                  </Box>
                  <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 'bold', color: barColor(selInfo.composite), width: 24, textAlign: 'right' }}>
                    {selInfo.composite}
                  </Typography>
                </Box>
              </Stack>
            )}

            {/* Rationale detail */}
            {ESG_RATIONALE[selected] && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, borderTop: '1px solid', borderColor: 'divider', pt: 2, fontStyle: 'italic', lineHeight: 1.5 }}>
                {ESG_RATIONALE[selected]}
              </Typography>
            )}

            <Typography variant="caption" color="text.secondary" align="center" sx={{ display: 'block', opacity: 0.5, mt: 1 }}>
              {t.esg.radar.hint}
            </Typography>
          </Card>
        </Grid>
      </Grid>
    </Container>
  );
}

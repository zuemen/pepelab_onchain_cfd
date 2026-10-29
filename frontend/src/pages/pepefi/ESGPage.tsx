import { useState, type ReactNode } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import Divider from '@mui/material/Divider';
import TableRow from '@mui/material/TableRow';
import Container from '@mui/material/Container';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import TableContainer from '@mui/material/TableContainer';

import { t, interpolate } from 'src/locales';
import { fNum } from 'src/lib/pepefi/format';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { ASSET_IDS } from 'src/contracts/addresses';
import { ASSET_META } from 'src/lib/pepefi/assetMeta';
import { useCarbonTiers } from 'src/hooks/useCarbonTiers';
import { MONO } from 'src/components/pepefi/brandKit';
import AssetIcon from 'src/components/pepefi/AssetIcon';
import { useV2Contracts } from 'src/hooks/useV2Contracts';
import { assetDisplayName } from 'src/lib/pepefi/assetName';
import { AttestedTierChips } from 'src/components/pepefi/AttestedCarbonTier';
import CarbonRetirementCard from 'src/components/pepefi/CarbonRetirementCard';
import { AssetCarbonFact, AssetTransitionFact } from 'src/components/pepefi/AssetProvenance';
import {
  ESG_PROVIDERS,
  LSEG_THEMES,
  ratingCell,
  hasThirdPartyRating,
  type EsgLight,
  type EsgRating,
  type EsgRatingDetail,
  type RatingCell,
  type EsgProvider,
} from 'src/lib/pepefi/esgRatings';

// issue #383：平台不替資產評分。這一頁只轉述第三方評級（資料在 lib/pepefi/esgRatingsData.ts），
// 碳分級另外標成平台的風險政策。各家不加總、不平均、不排名，所以資產照類別排，不照評級排。

const ASSETS = [
  ASSET_IDS.sAAPL, ASSET_IDS.sNVDA, ASSET_IDS.sMSFT, ASSET_IDS.sGOOGL, ASSET_IDS.sTSLA,
  ASSET_IDS.sICLN, ASSET_IDS.sESGU, ASSET_IDS.sBOND,
  ASSET_IDS.sBTC,  ASSET_IDS.sETH,  ASSET_IDS.sGOLD,
];

const LIGHT_COLOR: Record<EsgLight, 'success' | 'warning' | 'error'> = {
  good: 'success',
  middle: 'warning',
  poor: 'error',
};

const tp = t.esg.thirdParty;
const pct = (n: number) => `${fNum(n, { dp: 2 })}%`;

/** 表格裡的一格。四種情況的意思不同，畫法也刻意不同（見 esgRatings.ts 的 RatingCell）。 */
function RatingCellView({ cell }: { cell: RatingCell }) {
  switch (cell.kind) {
    case 'rated':
      return cell.light ? (
        <Chip size="small" color={LIGHT_COLOR[cell.light]} label={cell.rating.rating} sx={{ fontFamily: MONO, fontWeight: 'bold' }} />
      ) : (
        <Typography variant="body2" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>{cell.rating.rating}</Typography>
      );
    case 'notPublic':
      return <Typography variant="caption" color="text.secondary">{tp.cell.notPublic}</Typography>;
    case 'unrated':
      return <Chip size="small" variant="outlined" label={tp.cell.unrated} sx={{ borderStyle: 'dashed' }} />;
    case 'notApplicable':
      return <Typography variant="caption" color="text.disabled">{tp.cell.notApplicable}</Typography>;
  }
}

/** 評級機構自己的分組名稱（燈號旁的那個字）。沒有分組的機構回 null。 */
function groupLabel(r: EsgRating, light: EsgLight | null): string | null {
  const d = r.detail;
  if (d?.kind === 'sustainalyticsCompany') return tp.group.sustainalytics[d.category];
  if (d?.kind === 'morningstarFund') return tp.group.globes[`g${d.globes}`];
  if (r.provider === 'msci' && light) return tp.group.msci[light];
  return null;
}

/** 一列「標題：值」。 */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="baseline">
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="body2" sx={{ fontFamily: MONO, textAlign: 'right' }}>{children}</Typography>
    </Stack>
  );
}

/** 0–max 的分數畫成一條橫條，數字照原樣列在右邊。只是把評級機構的數字畫出來，不換算。 */
function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">{label}</Typography>
        <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>{value}</Typography>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={(value / max) * 100}
        sx={{ height: 5, borderRadius: 1, bgcolor: 'action.hover', '& .MuiLinearProgress-bar': { bgcolor: 'text.secondary' } }}
      />
    </Box>
  );
}

/** 評級以外的細項，依評級機構分開畫。 */
function RatingDetail({ detail }: { detail: EsgRatingDetail }) {
  const d = tp.detail;
  switch (detail.kind) {
    case 'msciFund':
      return (
        <Stack spacing={0.5}>
          <Fact label={d.msciQuality}>{detail.qualityScore}</Fact>
          <Fact label={d.msciPeer}>{interpolate(d.msciPeerValue, { pct: fNum(detail.peerPercentile, { dp: 2 }), count: fNum(detail.peerCount, { dp: 0 }) })}</Fact>
          <Fact label={d.msciWaci}>{fNum(detail.waci, { dp: 2 })}</Fact>
          <Fact label={d.msciItr}>{detail.impliedTemperatureRise}</Fact>
          <Fact label={d.msciCoverage}>{pct(detail.coveragePct)}</Fact>
        </Stack>
      );
    case 'sustainalyticsCompany':
      return (
        <Stack spacing={1}>
          <Fact label={d.controversy}>
            {detail.controversyLevel} {tp.group.controversy[`c${detail.controversyLevel}`]}
          </Fact>
          <Fact label={d.controversyAsOf}>{detail.controversyAsOf}</Fact>
          <Box>
            <Typography variant="caption" color="text.secondary">{d.controversyAreas}</Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
              {detail.controversyAreas.map((a) => <Chip key={a} size="small" variant="outlined" label={tp.area[a]} />)}
            </Stack>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">{d.topIssues}</Typography>
            <Stack component="ol" spacing={0.25} sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
              {detail.topIssues.map((i) => <Typography key={i} component="li" variant="body2">{tp.issue[i]}</Typography>)}
            </Stack>
          </Box>
        </Stack>
      );
    case 'morningstarFund':
      return (
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">{d.fundRisk}</Typography>
          <Typography variant="body2" sx={{ fontFamily: MONO }}>
            {interpolate(d.fundRiskValue, { now: fNum(detail.corporateRiskScore, { dp: 2 }), hist: fNum(detail.corporateRiskScoreHistorical, { dp: 2 }) })}
          </Typography>
          <Fact label={d.fundCoverage}>{pct(detail.aumCoveragePct)}</Fact>
        </Stack>
      );
    case 'lseg':
      return (
        <Stack spacing={1.5}>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 'bold' }}>{d.pillars}</Typography>
            <Grid container spacing={1.5} sx={{ mt: 0.25 }}>
              {(['e', 's', 'g'] as const).map((k) => (
                <Grid key={k} size={{ xs: 12, sm: 4 }}>
                  <ScoreBar label={tp.pillar[k]} value={detail.pillars[k]} max={5} />
                </Grid>
              ))}
            </Grid>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 'bold' }}>{d.themes}</Typography>
            <Grid container spacing={1.5} sx={{ mt: 0.25 }}>
              {(['e', 's', 'g'] as const).map((k) => (
                <Grid key={k} size={{ xs: 12, sm: 4 }}>
                  <Typography variant="caption" sx={{ fontWeight: 'bold' }}>{tp.pillar[k]}</Typography>
                  <Stack spacing={0.75} sx={{ mt: 0.5 }}>
                    {LSEG_THEMES[k].map((theme) => (
                      <ScoreBar key={theme} label={tp.theme[theme]} value={detail.themes[theme]} max={5} />
                    ))}
                  </Stack>
                </Grid>
              ))}
            </Grid>
          </Box>
          <Stack spacing={0.5}>
            <Fact label={d.industryRank}>{interpolate(d.industryRankValue, { rank: detail.rank, of: detail.rankOf })}</Fact>
            <Fact label={d.industry}>{detail.industry}</Fact>
          </Stack>
        </Stack>
      );
    case 'spGlobal':
      return (
        <Stack spacing={0.5}>
          <Fact label={d.spCsa}>{detail.csaScore}</Fact>
          <Fact label={d.industry}>{detail.industry}</Fact>
          {detail.underReview && <Typography variant="caption" color="warning.main">{d.spUnderReview}</Typography>}
          <Typography variant="caption" color="text.secondary">
            {detail.csaRespondent ? d.spRespondent : d.spPublicInfo}
          </Typography>
        </Stack>
      );
  }
}

/** 詳細資訊裡一家評級機構的卡片。這家根本不評這類資產時不畫。 */
function ProviderCard({ provider, cell }: { provider: EsgProvider; cell: RatingCell }) {
  const p = tp.provider[provider];
  if (cell.kind === 'notApplicable') return null;

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, p: 2, height: '100%' }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 'bold' }}>{p.name}</Typography>
      {cell.kind === 'rated' ? (
        <Stack spacing={1.25} sx={{ mt: 0.5 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="h5" sx={{ fontFamily: MONO, fontWeight: 'bold', lineHeight: 1 }}>
              {cell.rating.rating}
            </Typography>
            {(() => {
              const g = groupLabel(cell.rating, cell.light);
              return g && <Chip size="small" color={cell.light ? LIGHT_COLOR[cell.light] : 'default'} label={g} />;
            })()}
          </Stack>
          <Typography variant="caption" color="text.secondary">{p.scale}</Typography>
          {cell.rating.detail && <RatingDetail detail={cell.rating.detail} />}
          <Divider />
          <Typography variant="caption" color="text.secondary">
            {cell.rating.ratedOn !== null ? (
              <>{tp.detail.ratedOn}: <Box component="span" sx={{ fontFamily: MONO }}>{cell.rating.ratedOn}</Box></>
            ) : cell.rating.detail?.kind === 'lseg' ? (
              <>{tp.detail.fiscalYear}: {interpolate(tp.detail.fiscalYearValue, { year: cell.rating.detail.fiscalYear })}</>
            ) : null}
            {'  ·  '}
            {tp.detail.retrievedOn}: <Box component="span" sx={{ fontFamily: MONO }}>{cell.rating.retrievedOn}</Box>
          </Typography>
          <Link href={cell.rating.sourceUrl} target="_blank" rel="noopener noreferrer" variant="caption">
            {tp.detail.source}
          </Link>
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {interpolate(cell.kind === 'notPublic' ? tp.detail.notPublic : tp.detail.unrated, { provider: p.name })}
        </Typography>
      )}
    </Box>
  );
}

export default function ESGPage() {
  const wallet = usePepefiWallet();
  const v2 = useV2Contracts(wallet.provider, wallet.signer, wallet.chainId);
  const carbonTiers = useCarbonTiers(v2?.esgRegistryV2 ?? null);
  const [selected, setSelected] = useState<string>(ASSETS[0]);

  // 讀不到見證登記時碳分級整欄不畫,不留「本網路尚未部署」這類提示（CONTEXT.md 的 The Vault 詞條）。
  const showTier = !carbonTiers.unavailable;
  const selMeta = ASSET_META[selected];

  return (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>{t.esg.title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{t.esg.lead}</Typography>
      </Box>

      {/* ── 總覽表 ── */}
      <Card sx={{ p: { xs: 2, md: 3 } }}>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          {(['good', 'middle', 'poor'] as const).map((l) => (
            <Chip key={l} size="small" color={LIGHT_COLOR[l]} label={tp.light[l]} />
          ))}
          <Chip size="small" variant="outlined" label={tp.cell.unrated} sx={{ borderStyle: 'dashed' }} />
        </Stack>

        {/* 欄位多,手機上表格左右滑動,不把字擠到換行。 */}
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 640 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 'bold' }}>{tp.column.asset}</TableCell>
                {ESG_PROVIDERS.map((p) => (
                  <TableCell key={p} sx={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>{tp.provider[p].name}</TableCell>
                ))}
                {showTier && (
                  <TableCell sx={{ fontWeight: 'bold', borderLeft: '1px solid', borderLeftColor: 'divider' }}>
                    {tp.column.carbonTier}
                    <Typography variant="caption" color="text.secondary" display="block">{tp.column.carbonTierSub}</Typography>
                  </TableCell>
                )}
              </TableRow>
            </TableHead>
            <TableBody>
              {ASSETS.map((id) => {
                const meta = ASSET_META[id];
                return (
                  <TableRow
                    key={id}
                    hover
                    selected={id === selected}
                    onClick={() => setSelected(id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(id); } }}
                    tabIndex={0}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <AssetIcon symbol={meta?.ticker ?? '?'} size={24} />
                        <Box sx={{ minWidth: 0 }}>
                          <Stack direction="row" spacing={0.75} alignItems="center">
                            <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{meta?.ticker}</Typography>
                            {!hasThirdPartyRating(id) && (
                              <Chip size="small" variant="outlined" label={tp.noRating} sx={{ borderStyle: 'dashed', height: 20 }} />
                            )}
                          </Stack>
                          <Typography variant="caption" color="text.secondary" noWrap display="block">
                            {assetDisplayName(meta)}
                          </Typography>
                        </Box>
                      </Stack>
                    </TableCell>
                    {ESG_PROVIDERS.map((p) => (
                      <TableCell key={p}><RatingCellView cell={ratingCell(id, p)} /></TableCell>
                    ))}
                    {showTier && (
                      <TableCell sx={{ borderLeft: '1px solid', borderLeftColor: 'divider' }}>
                        {carbonTiers.error ? (
                          // 讀失敗不能畫成「未評等」——那是一個結論,而這裡沒有結論。
                          <Typography variant="caption" color="warning.main">{t.esg.attested.failed}</Typography>
                        ) : (
                          <AttestedTierChips attested={carbonTiers.data[id]} loading={!carbonTiers.loaded} />
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      {/* ── 選中資產的詳細資訊 ── */}
      {selMeta && (
        <Card sx={{ p: { xs: 2, md: 3 }, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <AssetIcon symbol={selMeta.ticker} size={32} />
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 'bold', lineHeight: 1.2 }}>{selMeta.ticker}</Typography>
              <Typography variant="caption" color="text.secondary">{assetDisplayName(selMeta)}</Typography>
            </Box>
          </Stack>

          {!hasThirdPartyRating(selected) && (
            <Alert severity="info" variant="outlined">{tp.detail.noRating}</Alert>
          )}
          <Grid container spacing={2}>
            {ESG_PROVIDERS.map((p) => {
              const cell = ratingCell(selected, p);
              return cell.kind === 'notApplicable' ? null : (
                // LSEG 有 12 個主題分數，給整列；其他每張半列。
                <Grid key={p} size={{ xs: 12, md: p === 'lseg' ? 12 : 6 }}>
                  <ProviderCard provider={p} cell={cell} />
                </Grid>
              );
            })}
          </Grid>

          <Divider />
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>{tp.detail.rawTitle}</Typography>
            <Typography variant="caption" color="text.secondary">{tp.detail.rawLead}</Typography>
            <Stack spacing={2} sx={{ mt: 1.5 }}>
              <AssetCarbonFact meta={selMeta} showTier={false} />
              <AssetTransitionFact meta={selMeta} />
            </Stack>
          </Box>

          {showTier && (
            <>
              <Divider />
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>{tp.detail.carbonTierTitle}</Typography>
                <Box sx={{ my: 1 }}>
                  {carbonTiers.error ? (
                    <Typography variant="caption" color="warning.main">{t.esg.attested.failed}</Typography>
                  ) : (
                    <AttestedTierChips attested={carbonTiers.data[selected]} loading={!carbonTiers.loaded} />
                  )}
                </Box>
                <Typography variant="caption" color="text.secondary">{tp.detail.carbonTierNote}</Typography>
              </Box>
            </>
          )}
        </Card>
      )}

      {/* ── 怎麼讀、為什麼這樣呈現 ── */}
      <Card sx={{ p: { xs: 2, md: 3 }, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>{tp.legend.title}</Typography>
        <Stack component="ul" spacing={0.75} sx={{ pl: 2.5, m: 0 }}>
          {[tp.legend.light, tp.legend.scoreOnly, tp.legend.noAverage].map((s) => (
            <Typography key={s} component="li" variant="body2" color="text.secondary">{s}</Typography>
          ))}
        </Stack>
        <Grid container spacing={2}>
          {ESG_PROVIDERS.map((p) => (
            <Grid key={p} size={{ xs: 12, md: 4 }}>
              <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{tp.provider[p].name}</Typography>
              <Typography variant="caption" color="text.secondary" display="block">{tp.provider[p].scale}</Typography>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>{tp.provider[p].scope}</Typography>
            </Grid>
          ))}
        </Grid>
        <Divider />
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>{tp.method.title}</Typography>
        <Stack component="ul" spacing={0.75} sx={{ pl: 2.5, m: 0 }}>
          {tp.method.items.map((s) => (
            <Typography key={s} component="li" variant="body2" color="text.secondary">{s}</Typography>
          ))}
        </Stack>
        {showTier && <Alert severity="info" variant="outlined">{t.esg.attested.vsOld}</Alert>}
        <Typography variant="caption" color="text.disabled">{tp.rights}</Typography>
      </Card>

      {/* ── 碳權退役紀錄（#105，ADR-022）。沒有設定退役合約位址時元件回 null。 ── */}
      <CarbonRetirementCard />
    </Container>
  );
}

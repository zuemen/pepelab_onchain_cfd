import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Alert from '@mui/material/Alert'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableRow from '@mui/material/TableRow'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import Typography from '@mui/material/Typography'
import TableContainer from '@mui/material/TableContainer'

import { t, interpolate } from 'src/locales'
import { ASSET_SDG, sdgGoalName } from 'src/lib/pepefi/sdg'
import { ASSET_IDS } from 'src/contracts/addresses'
import { ASSET_META } from 'src/lib/pepefi/assetMeta'
import { assetDisplayName } from 'src/lib/pepefi/assetName'

/**
 * #333：資產 → SDG 對應表（lib/pepefi/sdg.ts）與每一筆的理由。這是團隊的判斷，不是第三方評等：
 * 標題旁的 chip 與下面的說明框都照實講，而且說明 SDG 不影響定價。靜態資料，不讀鏈。
 */
export default function SdgMappingCard() {
  const reasons = t.esg.sdg.reasons as Record<string, Record<number, string>>

  return (
    <Card sx={{ p: 3 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
          {t.esg.sdg.title}
        </Typography>
        <Chip size="small" variant="outlined" label={t.esg.sdg.basisChip} />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {t.esg.sdg.lead}
      </Typography>
      <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
        {t.esg.sdg.basis}
      </Alert>

      <TableContainer sx={{ mt: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>{t.esg.sdg.column.asset}</TableCell>
              <TableCell sx={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>{t.esg.sdg.column.goal}</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>{t.esg.sdg.column.reason}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {Object.keys(ASSET_IDS).flatMap((symbol) =>
              (ASSET_SDG[symbol] ?? []).map((link, i) => (
                <TableRow key={`${symbol}-${link.goal}`}>
                  <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                    {i === 0 ? `${symbol} · ${assetDisplayName(ASSET_META[ASSET_IDS[symbol as keyof typeof ASSET_IDS]])}` : ''}
                  </TableCell>
                  <TableCell sx={{ verticalAlign: 'top' }}>
                    <Chip
                      size="small"
                      color={link.effect === 'positive' ? 'success' : 'error'}
                      variant="outlined"
                      label={`${interpolate(t.esg.sdg.goalLabel, { goal: link.goal })} ${sdgGoalName(t.esg.sdg.goalNames, link.goal)} · ${
                        link.effect === 'positive' ? t.esg.sdg.positive : t.esg.sdg.negative
                      }`}
                    />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{reasons[symbol]?.[link.goal]}</Typography>
                  </TableCell>
                </TableRow>
              )),
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Card>
  )
}

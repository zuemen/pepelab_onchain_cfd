// /rwa：把「現在的合成軌」「下一階段的數位孿生」與 SEC 豁免條件並排，收在展開按鈕後面。
// 目的是誠實回答「這算代幣化證券嗎」：現在不算，要走真實證券就是持牌合作的數位孿生。
import { useState } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Table from '@mui/material/Table';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import TableRow from '@mui/material/TableRow';
import Collapse from '@mui/material/Collapse';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import Typography from '@mui/material/Typography';
import TableContainer from '@mui/material/TableContainer';

import { t } from 'src/locales';

export function DigitalTwinRoadmap() {
  const [open, setOpen] = useState(false);
  const T = t.guide.twin;
  return (
    <Card sx={{ p: { xs: 2, md: 3 }, mt: 3 }}>
      <Typography variant="h5" component="h2" sx={{ fontWeight: 800 }}>{T.heading}</Typography>
      <Typography variant="body1" sx={{ color: 'text.secondary', mt: 1, lineHeight: 1.8 }}>{T.short}</Typography>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mt: 2 }}>
        {T.roadmap.map((s) => (
          <Box
            key={s.title}
            sx={{ flex: 1, p: 1.5, borderRadius: 1.5, border: '1px solid rgba(var(--palette-primary-mainChannel) / 0.35)' }}
          >
            <Typography variant="subtitle2" component="p" sx={{ fontWeight: 800 }}>{s.title}</Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>{s.text}</Typography>
          </Box>
        ))}
      </Stack>
      <Button
        size="small"
        color="inherit"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        sx={{ mt: 1.5, textTransform: 'none', color: 'text.secondary' }}
      >
        {open ? t.guide.less : t.guide.more}
      </Button>
      <Collapse in={open} unmountOnExit>
        <Alert severity="warning" sx={{ my: 1.5 }}>{T.notice}</Alert>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                {T.columns.map((c) => <TableCell key={c}>{c}</TableCell>)}
              </TableRow>
            </TableHead>
            <TableBody>
              {T.rows.map((r) => (
                <TableRow key={r.item}>
                  <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{r.item}</TableCell>
                  <TableCell>{r.now}</TableCell>
                  <TableCell>{r.twin}</TableCell>
                  <TableCell>{r.sec}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <Typography variant="caption" sx={{ display: 'block', mt: 1.5, color: 'text.secondary' }}>{T.source}</Typography>
      </Collapse>
    </Card>
  );
}

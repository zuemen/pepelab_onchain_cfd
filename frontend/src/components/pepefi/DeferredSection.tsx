import type { ReactNode } from 'react'

import { useState } from 'react'

import Card from '@mui/material/Card'
import Stack from '@mui/material/Stack'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'

import { t } from 'src/locales'

// 點了才掛上的區塊。children 裡的元件要等使用者按「載入」才 mount，它們的 hook 也到那時才開始讀鏈。
//
// 個人頁上要逐段掃描事件的區塊（目前部位與時間軸、最近動態、罰沒紀錄）一起掃是約 1,500 次 getLogs，
// 在每秒 20 筆的讀鏈額度下至少一分多鐘，還會跟名稱、策略、跟隨者搶同一份額度。收起來，主要內容就不用排隊。

export default function DeferredSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  if (open) return <>{children}</>
  return (
    <Card sx={{ p: 3 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{title}</Typography>
          <Typography variant="body2" color="text.secondary">{t.traderProfile.deferred.body}</Typography>
        </Stack>
        <Button size="small" variant="outlined" onClick={() => setOpen(true)} sx={{ flexShrink: 0 }}>
          {t.traderProfile.deferred.load}
        </Button>
      </Stack>
    </Card>
  )
}

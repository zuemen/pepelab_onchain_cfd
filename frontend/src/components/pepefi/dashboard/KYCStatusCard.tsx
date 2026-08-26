import { useState } from 'react';
import type { Contract } from 'ethers';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { Icon } from '@iconify/react';

import { t } from 'src/locales';
import { useKYC, type KYCStatus } from 'src/hooks/useKYC';
import KYCModal from 'src/components/pepefi/KYCModal';

// ----------------------------------------------------------------------
// 常駐狀態卡，不是按鈕。KYCModal 只在使用者撞到下單閘門時被動出現
// （ExchangePage / CopyPage）——想主動了解「我現在站在哪」的人，在這張卡
// 出現以前，整個 app 沒有任何入口。所以這裡不是「送 KYC 的地方」，是
// 「隨時能看見自己五態中哪一態」的地方；通過之後它繼續存在、繼續有用
// （告訴你已經可以交易受管制資產），不是一個通過即死的連結。
//
// 五態各自不同的文案與顏色，直接對應 useKYC.ts 的語意：pending 不推「去
// KYC」的按鈕（重送只是再燒一次 gas）；unknown 說「無法確認」而不是「未
// 通過」；not-required 是中性事實，不是警告。

type Props = {
  kycRegistry: Contract | null;
  userAddress: string | null;
};

const STATUS_ICON: Record<KYCStatus, string> = {
  verified:      'solar:verified-check-bold-duotone',
  pending:       'solar:hourglass-bold-duotone',
  unverified:    'solar:shield-warning-bold-duotone',
  'not-required': 'solar:shield-minus-bold-duotone',
  unknown:       'solar:question-circle-bold-duotone',
};

const STATUS_COLOR: Record<KYCStatus, string> = {
  verified:      'success.main',
  pending:       'info.main',
  unverified:    'warning.main',
  'not-required': 'text.secondary',
  unknown:       'warning.main',
};

export default function KYCStatusCard({ kycRegistry, userAddress }: Props) {
  const [showModal, setShowModal] = useState(false);
  const { status, isPending, refetch } = useKYC(kycRegistry, userAddress);

  const copy = {
    verified:      { title: t.kyc.status.verifiedTitle,      body: t.kyc.status.verifiedBody },
    pending:       { title: t.kyc.status.pendingTitle,       body: t.kyc.status.pendingBody },
    unverified:    { title: t.kyc.status.unverifiedTitle,    body: t.kyc.status.unverifiedBody },
    'not-required': { title: t.kyc.status.notRequiredTitle,  body: t.kyc.status.notRequiredBody },
    unknown:       { title: t.kyc.status.unknownTitle,       body: t.kyc.status.unknownBody },
  }[status];

  return (
    <Card sx={{ p: { xs: 2.5, sm: 3.5 }, border: '1px solid', borderColor: 'divider' }}>
      <Typography
        variant="overline"
        sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 1, display: 'block', mb: 2 }}
      >
        {t.kyc.status.cardTitle}
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
        <Icon icon={STATUS_ICON[status]} width={28} color={STATUS_COLOR[status]} />
        <Box sx={{ flexGrow: 1 }}>
          <Typography sx={{ fontWeight: 700, color: STATUS_COLOR[status] }}>
            {copy.title}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {copy.body}
          </Typography>
        </Box>

        {status === 'unverified' && (
          <Button
            size="small"
            variant="outlined"
            color="warning"
            onClick={() => setShowModal(true)}
            sx={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}
          >
            {t.kyc.status.unverifiedAction}
          </Button>
        )}

        {status === 'unknown' && (
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            onClick={() => void refetch()}
            sx={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}
          >
            {t.kyc.status.unknownAction}
          </Button>
        )}
      </Box>

      <KYCModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onSuccess={() => { void refetch(); }}
        kycRegistry={kycRegistry}
        isPending={isPending}
      />
    </Card>
  );
}

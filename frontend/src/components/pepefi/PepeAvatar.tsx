import { useState } from 'react';

import Box from '@mui/material/Box';

import { t } from 'src/locales';
import { TENANT_SHOWS_MASCOT } from 'src/tenant';
import { useUserAvatar } from 'src/hooks/useUserAvatar';

import { PepeAvatarPicker } from './PepeAvatarPicker';

type Props = { address?: string; size?: number; editable?: boolean };

export function PepeAvatar(props: Props) {
  // 機構租戶（brand.mascot = false）看不到 Pepe：改成不帶圖、不能換的中性識別圓。
  return TENANT_SHOWS_MASCOT ? <MascotAvatar {...props} /> : <NeutralAvatar {...props} />;
}

/** 地址末四碼當識別，主色描邊；沒有任何吉祥物圖。 */
function NeutralAvatar({ address, size = 64 }: Props) {
  const tag = address ? address.slice(-4).toUpperCase() : '';
  return (
    <Box
      role="img"
      aria-label={t.common.shell.accountAvatarAria}
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '2px solid var(--palette-primary-main)',
        bgcolor: 'rgba(var(--palette-primary-mainChannel) / 0.12)',
        color: 'var(--palette-primary-light)',
        fontFamily: 'monospace',
        fontWeight: 700,
        fontSize: Math.max(9, Math.round(size * 0.28)),
        letterSpacing: '-0.5px',
      }}
    >
      {tag}
    </Box>
  );
}

function MascotAvatar({ address, size = 64, editable = false }: Props) {
  const { src, pick } = useUserAvatar(address);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <>
      <Box
        sx={{
          position: 'relative',
          display: 'inline-block',
          cursor: editable ? 'pointer' : 'default',
          flexShrink: 0,
        }}
        onClick={() => editable && setPickerOpen(true)}
      >
        <img
          src={src}
          alt={t.common.shell.accountAvatarAria}
          style={{
            width: size,
            height: size,
            borderRadius: '50%',
            objectFit: 'contain',
            padding: size > 40 ? '6px' : '2px',
            border: '2px solid var(--palette-primary-main)',
            background: '#0e1420',
            display: 'block',
          }}
          onError={(e) => {
            (e.target as HTMLImageElement).style.opacity = '0.3';
          }}
        />
        {editable && (
          <Box
            sx={{
              position: 'absolute',
              bottom: 0,
              right: 0,
              width: 18,
              height: 18,
              bgcolor: 'var(--palette-primary-main)',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              color: '#0e1420',
              fontWeight: 700,
              pointerEvents: 'none',
            }}
          >
            ✎
          </Box>
        )}
      </Box>
      {editable && (
        <PepeAvatarPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onPick={pick}
          current={src}
        />
      )}
    </>
  );
}

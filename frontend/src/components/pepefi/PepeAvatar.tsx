import { useState } from 'react';

import Box from '@mui/material/Box';

import { useUserAvatar } from 'src/hooks/useUserAvatar';

import { PepeAvatarPicker } from './PepeAvatarPicker';

type Props = { address?: string; size?: number; editable?: boolean };

export function PepeAvatar({ address, size = 64, editable = false }: Props) {
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
          alt="pepe avatar"
          style={{
            width: size,
            height: size,
            borderRadius: '50%',
            objectFit: 'contain',
            padding: size > 40 ? '6px' : '2px',
            border: '2px solid #7cc14a',
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
              bgcolor: '#7cc14a',
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

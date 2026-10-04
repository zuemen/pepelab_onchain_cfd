import { useState, useCallback } from 'react';

import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';

import { t } from 'src/locales';

import { Iconify } from '../../iconify';

// ----------------------------------------------------------------------

export function FullScreenButton() {
  const [fullscreen, setFullscreen] = useState(false);

  const handleToggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      setFullscreen(true);
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
      setFullscreen(false);
    }
  }, []);

  return (
    <Tooltip title={fullscreen ? t.common.shell.settings.exitFullscreen : t.common.shell.settings.fullscreen}>
      <IconButton onClick={handleToggleFullscreen} color={fullscreen ? 'primary' : 'default'}>
        <Iconify
          icon={
            fullscreen
              ? 'solar:quit-full-screen-square-outline'
              : 'solar:full-screen-square-outline'
          }
        />
      </IconButton>
    </Tooltip>
  );
}

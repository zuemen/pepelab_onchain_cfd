import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';

import { AVATAR_FILES } from 'src/lib/pepefi/pepeAvatar';

type Props = {
  open: boolean;
  onClose: () => void;
  onPick: (src: string) => void;
  current?: string;
};

export function PepeAvatarPicker({ open, onClose, onPick, current }: Props) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>選擇頭像</DialogTitle>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, p: 2, justifyContent: 'center' }}>
        {AVATAR_FILES.map((file) => (
          <Box
            key={file}
            component="img"
            src={file}
            onClick={() => {
              onPick(file);
              onClose();
            }}
            sx={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              objectFit: 'cover',
              cursor: 'pointer',
              border: file === current ? '3px solid #7cc14a' : '2px solid transparent',
              '&:hover': { opacity: 0.8 },
            }}
          />
        ))}
      </Box>
    </Dialog>
  );
}

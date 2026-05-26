import { Component, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';

interface Props { children: ReactNode }
interface State { hasError: boolean; error?: Error }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '60vh',
            gap: 2.5,
            px: 3,
            textAlign: 'center',
          }}
        >
          <Box sx={{ fontSize: '3rem' }}>⚠️</Box>
          <Typography variant="h5" sx={{ color: 'text.primary', fontWeight: 'bold' }}>
            Something went wrong
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 400 }}>
            This page hit an unexpected error. Other pages should still work — try the navigation menu.
          </Typography>
          <Box component="details" sx={{ maxWidth: 400, textAlign: 'left', width: '100%' }}>
            <Typography
              component="summary"
              variant="caption"
              sx={{ color: 'text.secondary', cursor: 'pointer', '&:hover': { color: 'text.primary' } }}
            >
              Show details
            </Typography>
            <Box
              component="pre"
              sx={{
                mt: 1,
                p: 1.5,
                borderRadius: 1,
                bgcolor: 'background.neutral',
                border: '1px solid',
                borderColor: 'divider',
                fontSize: '0.75rem',
                color: 'text.secondary',
                overflowX: 'auto',
              }}
            >
              {this.state.error?.message ?? 'Unknown error'}
            </Box>
          </Box>
          <Button
            variant="contained"
            color="primary"
            onClick={() => this.setState({ hasError: false, error: undefined })}
            sx={{ mt: 1 }}
          >
            Try again
          </Button>
        </Box>
      );
    }
    return this.props.children;
  }
}

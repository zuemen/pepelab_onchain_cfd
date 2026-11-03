import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Outlet, RouterProvider, createBrowserRouter } from 'react-router';

import App from './App';
import { routerBasename } from './locales/site';
import { routesSection } from './routes/sections';
import { ErrorBoundary } from './routes/components';
import { claimStaleChunkReload } from './lib/pepefi/staleChunkReload';

// ----------------------------------------------------------------------

// 換版後，開著的舊分頁載不到已被換掉的 chunk：重新整理一次拿新版，避免停在
// "Failed to fetch dynamically imported module"。短時間內只重整一次，見 staleChunkReload.ts。
window.addEventListener('vite:preloadError', () => {
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    // 被封鎖就沒有防無限重整的記號，claimStaleChunkReload 會回 false。
  }
  if (claimStaleChunkReload(storage, Date.now())) window.location.reload();
});

const router = createBrowserRouter(
  [
    {
      Component: () => (
        <App>
          <Outlet />
        </App>
      ),
      errorElement: <ErrorBoundary />,
      children: routesSection,
    },
  ],
  // 英文站放在 /en/ 底下（Vite 的 base，issue #396）；中文站是 /。
  { basename: routerBasename(import.meta.env.BASE_URL) }
);

const root = createRoot(document.getElementById('root')!);

root.render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);

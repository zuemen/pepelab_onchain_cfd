import type { RouteObject } from 'react-router';

import { lazy } from 'react';

import { authRoutes } from './auth';
import { pepefiRoutes } from './pepefi';

// ----------------------------------------------------------------------

const Page404 = lazy(() => import('src/pages/error/404'));

export const routesSection: RouteObject[] = [
  // Pepefi — root-level routes (/, /dashboard, /exchange, ...)
  ...pepefiRoutes,

  // Auth
  ...authRoutes,

  // No match
  { path: '*', element: <Page404 /> },
];

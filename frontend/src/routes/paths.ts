// ----------------------------------------------------------------------

const ROOTS = {
  AUTH: '/auth',
  DASHBOARD: '/dashboard',
};

// ----------------------------------------------------------------------

export const paths = {
  faqs: '/faqs',
  minimalStore: 'https://mui.com/store/items/minimal-dashboard/',
  // AUTH
  auth: {
    amplify: {
      signIn: `${ROOTS.AUTH}/amplify/sign-in`,
      verify: `${ROOTS.AUTH}/amplify/verify`,
      signUp: `${ROOTS.AUTH}/amplify/sign-up`,
      updatePassword: `${ROOTS.AUTH}/amplify/update-password`,
      resetPassword: `${ROOTS.AUTH}/amplify/reset-password`,
    },
    jwt: {
      signIn: `${ROOTS.AUTH}/jwt/sign-in`,
      signUp: `${ROOTS.AUTH}/jwt/sign-up`,
    },
    firebase: {
      signIn: `${ROOTS.AUTH}/firebase/sign-in`,
      verify: `${ROOTS.AUTH}/firebase/verify`,
      signUp: `${ROOTS.AUTH}/firebase/sign-up`,
      resetPassword: `${ROOTS.AUTH}/firebase/reset-password`,
    },
    auth0: {
      signIn: `${ROOTS.AUTH}/auth0/sign-in`,
    },
    supabase: {
      signIn: `${ROOTS.AUTH}/supabase/sign-in`,
      verify: `${ROOTS.AUTH}/supabase/verify`,
      signUp: `${ROOTS.AUTH}/supabase/sign-up`,
      updatePassword: `${ROOTS.AUTH}/supabase/update-password`,
      resetPassword: `${ROOTS.AUTH}/supabase/reset-password`,
    },
  },
  // DASHBOARD
  // 只剩 root（= pepefi 的 /dashboard，真的有掛載）。two/three/group/* 對應的是
  // 範本留下的 routes/sections/dashboard.tsx，那份路由從來沒有被掛進 routesSection，
  // 卻讓 pages/dashboard/* 六個範本頁一直被打包進去。整組已移除。
  dashboard: {
    root: ROOTS.DASHBOARD,
  },
  // PEPEFI — root-level paths matching pepelab App.tsx
  pepefi: {
    landing: '/',
    dashboard: '/dashboard',
    exchange: '/exchange',
    tokens: '/tokens',
    terminal: '/terminal',
    x402: '/x402',
    trader: '/trader',
    stake: '/stake',
    marketplace: '/marketplace',
    esg: '/esg',
    portfolio: '/portfolio',
    vault: '/vault',
    history: '/history',
    whale: '/whale',
    adminOracle: '/admin/oracle',
    adminTreasury: '/admin/treasury',
    adminKyc: '/admin/kyc',
    rewards: '/rewards',
    sessions: '/sessions',
    agentMonitor: '/agent-monitor',
    pepe:    '/pepe',
  },
};

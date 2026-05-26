/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Dark surface palette (base layout bg is #0f172a)
        surface: {
          DEFAULT: '#172132',   // bg-surface         — main card bg (clearly distinct from layout)
          sub:     '#0d1520',   // bg-surface-sub     — nested / sidebar panels (darker)
          elev:    '#1e2d45',   // bg-surface-elev    — elevated inputs, hover bg
          border:  '#253550',   // border-surface-border / bg-surface-border
        },
        // Brand palette — emerald green
        brand: {
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
        },
        info:   '#38bdf8',   // sky-400
        danger: '#f87171',   // red-400
        warn:   '#fbbf24',   // amber-400
      },
      borderRadius: {
        card: '0.75rem',   // rounded-card
      },
      boxShadow: {
        card:        '0 4px 24px 0 rgba(0,0,0,0.40)',
        'card-hover': '0 8px 32px 0 rgba(0,0,0,0.55)',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(-6px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.25s ease-out',
      },
    },
  },
  plugins: [],
  // Avoid Tailwind reset conflicting with MUI
  corePlugins: {
    preflight: false,
  },
};

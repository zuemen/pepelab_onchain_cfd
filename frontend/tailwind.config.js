/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Public Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50:  '#C8FAD6',
          100: '#5BE49B',
          200: '#00A76F',
          300: '#007867',
          400: '#004B50',
        },
        info:   { DEFAULT: '#00B8D9', dark: '#006C9C' },
        warn:   { DEFAULT: '#FFAB00', dark: '#B76E00' },
        danger: { DEFAULT: '#FF5630', dark: '#B71D18' },
        surface: {
          DEFAULT: '#1C252E',
          sub:     '#161C24',
          elev:    '#212B36',
          border:  '#2A3441',
        },
      },
      borderRadius: {
        card: '16px',
        pill: '9999px',
      },
      boxShadow: {
        card:       '0 0 2px 0 rgba(145,158,171,0.20), 0 12px 24px -4px rgba(145,158,171,0.12)',
        'card-hover': '0 0 2px 0 rgba(145,158,171,0.20), 0 16px 32px -4px rgba(145,158,171,0.18)',
      },
    },
  },
  plugins: [],
}

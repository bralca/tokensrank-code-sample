/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'accent-lime': '#b63b13',
        tr: {
          bg: '#fffdfb',
          'bg-soft': '#f5f2ee',
          'bg-row': '#ede7e1',
          text: '#272421',
          secondary: '#746d65',
          dim: '#746d65',
          border: '#e9e2db',
          'border-hi': '#d6ccc2',
          accent: '#b63b13',
          danger: '#EF4444',
          error: '#b91c1c',
          availability: '#B8860B',
          warning: '#9a5c09',
          success: '#237247',
        },
      },
      fontFamily: {
        sans: ['DM Sans', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};

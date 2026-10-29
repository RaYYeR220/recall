/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: '#0a0a0b',
        raise: '#111113',
        card: '#151517',
        ink: '#f5f5f7',
        'ink-2': '#a1a1a6',
        'ink-3': '#6e6e73',
        'ink-4': '#3a3a3e',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        line: 'rgba(255,255,255,.08)',
        'line-2': 'rgba(255,255,255,.12)',
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // The only radii in the system: pills, cards, inner panels, window segments.
      borderRadius: {
        none: '0',
        pill: '999px',
        card: '24px',
        panel: '14px',
        seg: '3px',
        full: '9999px',
      },
      transitionTimingFunction: { out: 'cubic-bezier(.16,1,.3,1)' },
      maxWidth: { app: '1120px' },
    },
  },
  plugins: [],
}

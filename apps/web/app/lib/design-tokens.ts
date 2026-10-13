/**
 * TokensRank Design System
 * Single source of truth for colors, typography, and spacing
 * Community design: warm neutral surfaces, charcoal text, orange actions.
 */

export const TR = {
  // Shared light palette
  bg: '#fffdfb',
  bgSoft: '#f5f2ee',
  bgRow: '#f9f5f0',
  border: '#e9e2db',
  borderHi: '#d6ccc2',
  text: '#272421',
  textMid: '#746d65',
  textDim: '#746d65',
  accent: '#b63b13',
  up: '#b63b13', // Rank up (reuses accent)
  down: '#b91c1c', // Rank down
  flat: '#746d65', // No movement
};

// Typography — DM Sans + Geist Mono via Google Fonts
export const TR_FONTS_LINK =
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600;700&display=swap';

// Font family utilities
export const FONT_SANS = '"DM Sans", -apple-system, system-ui, sans-serif';
export const FONT_MONO = '"Geist Mono", "JetBrains Mono", ui-monospace, monospace';

// Typography scales
export const TYPOGRAPHY = {
  // Headings
  h1: { fontSize: 32, fontWeight: 600, letterSpacing: '-0.025em', lineHeight: 1.2 },
  h2: { fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.2 },
  h3: { fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.3 },

  // Body text
  body: { fontSize: 13.5, fontWeight: 400, lineHeight: 1.5 },
  bodyMd: { fontSize: 13, fontWeight: 400, lineHeight: 1.5 },
  bodySm: { fontSize: 12, fontWeight: 400, lineHeight: 1.4 },
  bodyXs: { fontSize: 11.5, fontWeight: 400, lineHeight: 1.4 },

  // Mono/numeric
  mono: { fontSize: 13.5, fontWeight: 400, letterSpacing: '-0.01em', fontFamily: FONT_MONO },
  monolabel: { fontSize: 11, fontWeight: 400, textTransform: 'uppercase' as const, letterSpacing: '0.08em', fontFamily: FONT_MONO },
  monoValue: { fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', fontFamily: FONT_MONO },
  monoValueLarge: { fontSize: 96, fontWeight: 600, letterSpacing: '-0.04em', fontFamily: FONT_MONO },

  // Special
  label: { fontSize: 10.5, fontWeight: 400, textTransform: 'uppercase' as const, letterSpacing: '0.16em', fontFamily: FONT_MONO },
  caption: { fontSize: 11, fontWeight: 400, lineHeight: 1.3 },
};

// Spacing scale
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 28,
  '4xl': 32,
  '5xl': 36,
  '6xl': 44,
  '7xl': 56,
};

// Border radius
export const BORDER_RADIUS = {
  none: 0,
  xs: 3,
  sm: 6,
  md: 8,
  lg: 10,
  full: 999,
};

// Layout
export const LAYOUT = {
  maxWidth: 1280,
  contentPadding: 28,
};

// Component-specific utilities
export const CSS_CLASSES = {
  // Font utilities
  '.tr': {
    fontFamily: FONT_SANS,
    color: TR.text,
    background: TR.bg,
    WebkitFontSmoothing: 'antialiased',
    letterSpacing: '-0.005em',
  },
  '.tr-mono': {
    fontFamily: FONT_MONO,
    fontFeatureSettings: '"tnum"',
    letterSpacing: '-0.01em',
  },
  '.tr-num': {
    fontFamily: FONT_MONO,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '-0.01em',
  },

  // Borders
  '.tr-hairline': { border: `1px solid ${TR.border}` },
  '.tr-hairline-t': { borderTop: `1px solid ${TR.border}` },
  '.tr-hairline-b': { borderBottom: `1px solid ${TR.border}` },
  '.tr-hairline-r': { borderRight: `1px solid ${TR.border}` },
  '.tr-hairline-l': { borderLeft: `1px solid ${TR.border}` },

  // Cards and rows
  '.tr-card': {
    background: TR.bgSoft,
    border: `1px solid ${TR.border}`,
  },
  '.tr-row:hover': {
    background: TR.bgRow,
  },

  // Links
  '.tr-link': {
    color: TR.text,
    textDecoration: 'none',
  },
  '.tr-link:hover': {
    color: TR.accent,
  },

  // Animation
  '.tr-pulse': {
    animation: 'tr-pulse 2s ease-in-out infinite',
  },

  // Tabs
  '.tr-tab': {
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 500,
    color: TR.textMid,
    cursor: 'pointer',
    borderRadius: BORDER_RADIUS.full,
  },
  '.tr-tab.active': {
    color: TR.text,
    background: TR.bgSoft,
  },

  // Buttons
  '.tr-btn': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 500,
    background: TR.bgSoft,
    color: TR.text,
    border: `1px solid ${TR.borderHi}`,
    cursor: 'pointer',
    fontFamily: FONT_SANS,
    borderRadius: BORDER_RADIUS.md,
  },
  '.tr-btn:hover': {
    borderColor: TR.textMid,
  },
  '.tr-btn-primary': {
    background: TR.accent,
    color: TR.bg,
    border: `1px solid ${TR.accent}`,
    fontWeight: 600,
  },
  '.tr-btn-primary:hover': {
    filter: 'brightness(1.08)',
  },

  '.tr-pill': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    borderRadius: BORDER_RADIUS.full,
    fontSize: 11,
    fontWeight: 500,
  },
};

// Helper function to inject base styles once
export function injectTRStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('tr-base')) return;

  // Fonts link
  if (!document.querySelector('link[href*="Geist"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = TR_FONTS_LINK;
    document.head.appendChild(link);
  }

  // Base styles
  const style = document.createElement('style');
  style.id = 'tr-base';
  style.textContent = `
    .tr {
      font-family: ${FONT_SANS};
      font-feature-settings: 'ss01', 'cv11';
      color: ${TR.text};
      background: ${TR.bg};
      -webkit-font-smoothing: antialiased;
      letter-spacing: -0.005em;
    }
    .tr-mono {
      font-family: ${FONT_MONO};
      font-feature-settings: 'tnum', 'zero', 'ss01';
      letter-spacing: -0.01em;
    }
    .tr-num {
      font-family: ${FONT_MONO};
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.01em;
    }
    .tr ::selection {
      background: ${TR.accent};
      color: ${TR.bg};
    }
    .tr-hairline { border: 1px solid ${TR.border}; }
    .tr-hairline-t { border-top: 1px solid ${TR.border}; }
    .tr-hairline-b { border-bottom: 1px solid ${TR.border}; }
    .tr-hairline-r { border-right: 1px solid ${TR.border}; }
    .tr-hairline-l { border-left: 1px solid ${TR.border}; }
    .tr-card { background: ${TR.bgSoft}; border: 1px solid ${TR.border}; }
    .tr-row:hover { background: ${TR.bgRow}; }
    .tr-link { color: ${TR.text}; text-decoration: none; }
    .tr-link:hover { color: ${TR.accent}; }
    .tr-pulse { animation: tr-pulse 2s ease-in-out infinite; }
    @keyframes tr-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.45; }
    }
    .tr-tab {
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 500;
      color: ${TR.textMid};
      cursor: pointer;
      border-radius: 999px;
    }
    .tr-tab.active {
      color: ${TR.text};
      background: ${TR.bgSoft};
    }
    .tr-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 500;
      background: ${TR.bgSoft};
      color: ${TR.text};
      border: 1px solid ${TR.borderHi};
      cursor: pointer;
      font-family: inherit;
      border-radius: 8px;
    }
    .tr-btn:hover { border-color: ${TR.textMid}; }
    .tr-btn-primary {
      background: ${TR.accent};
      color: ${TR.bg};
      border: 1px solid ${TR.accent};
      font-weight: 600;
    }
    .tr-btn-primary:hover {
      filter: brightness(1.08);
    }
    .tr-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
    }
  `;
  document.head.appendChild(style);
}

// Export as object for easy destructuring
export default {
  TR,
  FONT_SANS,
  FONT_MONO,
  TYPOGRAPHY,
  SPACING,
  BORDER_RADIUS,
  LAYOUT,
  TR_FONTS_LINK,
  injectTRStyles,
};

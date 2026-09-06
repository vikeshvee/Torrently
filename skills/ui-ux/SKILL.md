---
name: ui-ux
description: Modern dark glassmorphism UI design system, CSS architecture, visual components, animations, and typography for Torrently.
---

# UI/UX Design System Skill

This skill defines the aesthetic guidelines and CSS design system for Torrently.

## Design Aesthetic Principles

1. **Deep Space Dark Theme**: Deep charcoal/navy background (`#0B0E14`), semi-transparent glass cards with backdrop filter blur (`backdrop-filter: blur(16px)`).
2. **Neon Accent Colors**:
   - Primary Cyan: `#00F2FE` -> `#4FACFE` gradient.
   - Violet Glow: `#7F00FF` -> `#E100FF`.
   - Success Green: `#00E676` for active seeding.
   - Warning Amber: `#FFAB00` for buffering state.
3. **Typography**: Clean, modern sans-serif stack (`Inter`, system-ui, -apple-system).
4. **Micro-Animations**: Hover scale effects, pulse glows on active downloads, smooth progress bar fills.

## Design Tokens (CSS Variables)

```css
:root {
  --bg-dark: #090c10;
  --bg-card: rgba(18, 24, 38, 0.75);
  --border-card: rgba(255, 255, 255, 0.08);
  --accent-cyan: #00f2fe;
  --accent-blue: #4facfe;
  --accent-purple: #8a2be2;
  --text-main: #f0f4f8;
  --text-muted: #8b9bb4;
  --radius-lg: 16px;
  --radius-md: 10px;
  --shadow-glow: 0 8px 32px 0 rgba(0, 242, 254, 0.15);
}
```

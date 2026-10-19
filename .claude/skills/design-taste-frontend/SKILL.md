---
name: "design-taste-frontend"
description: "Anti-slop frontend rules and design dials for UI work. Defaults only: the project brief or existing design system overrides them."
---

# design-taste-frontend: Anti-Slop Frontend System

> Адаптировано из taste-skill (https://github.com/Leonxlnx/taste-skill), лицензия MIT, Copyright (c) 2026 Leonxlnx.

## Core Dials (defaults — the project brief or its existing design system overrides them)
- DESIGN_VARIANCE: 8/10 (High layout experimentation, strict non-templated paths)
- MOTION_INTENSITY: 6/10 (Fluid, high-end animation primitives)
- VISUAL_DENSITY: 4/10 (Spacious, deliberate layout and hierarchy)
- For internal tools, admin panels and data-heavy dashboards use calmer defaults unless the brief says otherwise: DESIGN_VARIANCE ~4, MOTION_INTENSITY ~2, VISUAL_DENSITY ~7.

## Anti-Slop Visual Rules
1. Never produce default purple/indigo "AI-SaaS" linear gradients on dark meshes.
2. Never repeat three identical feature cards side-by-side. Use staggered layout, asymmetric columns, or variable density instead.
3. Reject full-screen glassmorphism by default.
4. Never put raw emojis in buttons or navigation. Use proper icon libraries or layout tags.
5. In HTML/JSX, placeholder text must never replace a proper accessible <label> tree.

## Execution Pre-Flight
- Read the user brief.
- Audit the existing design system if any.
- Lock design tokens first: typography scale, strict semantic color pairs, spacing scales.
- When generating frontend code or previewing artifacts, apply these rules natively.

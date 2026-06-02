<!-- hatch:begin v1 -->
## Design Context

### Users
Professional software engineers using CloudChat as a daily AI coding assistant and GitHub workflow tool. They're in flow state — writing code, reviewing diffs, managing PRs — and expect the interface to keep up without friction. Speed and information density matter more than hand-holding.

### Brand Personality
**Bold, technical, fast.** Power-user energy. The interface should feel like a precision instrument — responsive, dense with useful information, and visually sharp. Think Warp terminal meets Linear's polish.

### Aesthetic Direction
- **Visual tone**: Dark-first, high-contrast, monochromatic with restrained accent color. Crisp edges, tight spacing, no visual fluff.
- **References**: Cursor/Windsurf (AI-native code editor feel), ChatGPT/Claude.ai (clean conversational flow), Linear/Vercel (refined dev-tool typography and layout).
- **Anti-references**: Overly playful consumer apps (Notion-cute), heavy gradients/glassmorphism, rounded bubbly UI, excessive whitespace. Nothing that feels slow or decorative.
- **Theme**: Light and dark mode supported; dark mode is the primary design target.
- **Typography**: Geist Sans for UI, Inter for body text, Geist Mono for code. Tight leading, small-to-medium sizes. Information-dense but readable.
- **Motion**: Minimal and functional — fade-in-up entrances, glimmer for streaming state. No bouncy or attention-seeking animations.

### Design Principles
1. **Speed is a feature** — Every interaction should feel instant. Minimize visual latency, avoid layout shifts, keep animations under 200ms.
2. **Density over decoration** — Show more information in less space. Prefer compact layouts, small text sizes, and tight spacing. Don't add visual elements that don't carry information.
3. **Dark-native confidence** — Design for dark mode first. Use high contrast for readability, subtle borders for structure, and restrained color for hierarchy.
4. **Developer-grade precision** — Pixel-perfect alignment, consistent spacing, monospace where appropriate. The interface should feel as precise as the code it helps write.
5. **Get out of the way** — The UI serves the conversation and the code. Chrome should recede; content should dominate. Progressive disclosure over upfront complexity.

### Accessibility
WCAG AA compliance — good contrast ratios, full keyboard navigation, proper ARIA labels, focus indicators. Respect `prefers-reduced-motion`.
<!-- hatch:end v1 -->

import type { JSX } from "react";

const paths: Record<string, JSX.Element> = {
  bot: (
    <>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 8V4M9 13h.01M15 13h.01M2 13h2M20 13h2" />
    </>
  ),
  tabs: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M7 7V5a1 1 0 0 1 1-1h3M3 11h18" />
    </>
  ),
  mouse: (
    <>
      <rect x="6" y="3" width="12" height="18" rx="6" />
      <path d="M12 7v4" />
    </>
  ),
  toggles: (
    <>
      <rect x="2" y="5" width="20" height="6" rx="3" />
      <rect x="2" y="13" width="20" height="6" rx="3" />
      <circle cx="17" cy="8" r="1.4" />
      <circle cx="7" cy="16" r="1.4" />
    </>
  ),
  plug: (
    <>
      <path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0V8ZM12 16v6" />
    </>
  ),
  git: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5c0 4-6 1.5-6 5.5" />
    </>
  ),
  preview: (
    <>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M3 9h18M8 13l-2 2 2 2M13 13l2 2-2 2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  stack: (
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5ZM4 12l8 4.5L20 12M4 16l8 4.5L20 16" />
    </>
  ),
  brain: (
    <>
      <rect x="9" y="9" width="6" height="6" rx="1.5" />
      <path d="M9 4v3M15 4v3M9 17v3M15 17v3M4 9h3M4 15h3M17 9h3M17 15h3" />
    </>
  ),
  desktop: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z" />
    </>
  ),
  github: (
    <path d="M9 19c-4 1.4-4-2.1-5.5-2.5M14.5 21v-3.2a2.8 2.8 0 0 0-.8-2.2c2.6-.3 5.3-1.3 5.3-5.8a4.5 4.5 0 0 0-1.2-3.1 4.2 4.2 0 0 0-.1-3.1s-1-.3-3.3 1.2a11.4 11.4 0 0 0-6 0C5.1 2.8 4 3.1 4 3.1a4.2 4.2 0 0 0-.1 3.1A4.5 4.5 0 0 0 2.7 9.3c0 4.5 2.7 5.5 5.3 5.8a2.8 2.8 0 0 0-.8 2.1V21" />
  ),
  download: (
    <path d="M12 3v12M7 11l5 5 5-5M5 21h14" />
  ),
  arrowRight: (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
};

export function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.bot}
    </svg>
  );
}

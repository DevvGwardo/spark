import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { MessageSquare, Cpu, Terminal, BlocksIcon, GitBranch, Keyboard } from 'lucide-react';

interface Feature {
  icon: React.ReactNode;
  title: string;
  description: string;
}

const features: Feature[] = [
  {
    icon: <MessageSquare size={18} />,
    title: 'Claude + GPT',
    description: 'Switch between Claude Opus, Sonnet, GPT-5.4, and more — pick the right model for the job.',
  },
  {
    icon: <Cpu size={18} />,
    title: 'Local agents',
    description: 'Run Hermes and other local models. Your code stays on your machine unless you want it to.',
  },
  {
    icon: <Terminal size={18} />,
    title: 'Terminal-native',
    description: 'Built-in terminal with session persistence, command history, and agent access to your shell.',
  },
  {
    icon: <BlocksIcon size={18} />,
    title: 'Skills & plugins',
    description: 'Extend with the same SKILL.md ecosystem used by Claude Code and Codex CLI.',
  },
  {
    icon: <GitBranch size={18} />,
    title: 'Worktree isolation',
    description: 'Each agent runs in its own git worktree — parallel tasks, zero conflicts.',
  },
  {
    icon: <Keyboard size={18} />,
    title: 'Keyboard-first',
    description: 'Every action has a shortcut. Built for developers who live in the terminal.',
  },
];

export function FeatureGrid() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { threshold: 0.1 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <section className="relative z-10 py-32 px-6 border-t border-border/20">
      <div className="max-w-4xl mx-auto">
        <p className="text-[10px] tracking-[0.2em] text-muted-foreground uppercase text-center mb-16">
          Capabilities
        </p>

        <div
          ref={ref}
          className="grid grid-cols-1 sm:grid-cols-2"
          style={{ gap: '1px', background: 'hsl(var(--border) / 0.2)' }}
        >
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 24 }}
              animate={visible ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: i * 0.08, ease: [0.25, 0.1, 0.25, 1] }}
              className="flex flex-col gap-3 p-10 bg-background"
            >
              <div className="text-muted-foreground">{f.icon}</div>
              <h3 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
                {f.title}
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {f.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

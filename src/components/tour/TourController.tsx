import { useEffect, useRef } from 'react';
import { useTour } from '@reactour/tour';
import { useUIStore } from '@/stores/ui-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useIsMobile } from '@/hooks/use-mobile';
import { appTourSteps } from './tour-config';

/**
 * Puts the UI into a known state (sidebar open, Threads tab, chat view) so every
 * tour target is mounted, then opens the tour. Runs once on first run after setup;
 * marks the tour as seen when it closes so it never auto-starts again.
 */
export function prepareUiForTour() {
  const ui = useUIStore.getState();
  ui.setSidebarOpen(true);
  ui.setActiveTab('chat');
  ui.setActiveSubTab('threads');
  ui.setKanbanFullscreen(false);
}

export function TourController() {
  const { setIsOpen, isOpen, setCurrentStep, currentStep, setSteps } = useTour();
  const isMobile = useIsMobile();
  const isSetupComplete = useSettingsStore((s) => s.isSetupComplete);
  const tourSeen = useUIStore((s) => s.tourSeen);
  const setTourSeen = useUIStore((s) => s.setTourSeen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const setupWizardOpen = useUIStore((s) => s.setupWizardOpen);
  const bridgeSetupOpen = useUIStore((s) => s.bridgeSetupOpen);
  const startedRef = useRef(false);
  const wasOpenRef = useRef(false);

  // Auto-start once, on first run after setup completes — but wait until any
  // blocking onboarding overlay (bridge setup, setup wizard, settings) is cleared
  // so the tour never appears on top of a modal.
  useEffect(() => {
    if (startedRef.current) return;
    if (isMobile || !isSetupComplete || tourSeen) return;
    if (settingsOpen || setupWizardOpen || bridgeSetupOpen) return;
    startedRef.current = true;
    prepareUiForTour();
    // Wait until every tour target is actually mounted AND laid out before
    // opening — a fixed delay races slower first-run mounts (notably Electron),
    // where an unresolved selector makes reactour pin the popover at the
    // window's top-left corner over the traffic lights. Poll briefly, then
    // open anyway as a last resort so the tour can't be lost entirely.
    const targetsReady = () =>
      appTourSteps.every((step) => {
        const el = typeof step.selector === 'string' ? document.querySelector(step.selector) : null;
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    const deadline = Date.now() + 8000;
    let timer: ReturnType<typeof setTimeout>;
    const tryOpen = () => {
      if (!targetsReady() && Date.now() < deadline) {
        timer = setTimeout(tryOpen, 200);
        return;
      }
      setCurrentStep(0);
      setIsOpen(true);
    };
    // Initial delay still lets the sidebar/composer entrance animations settle.
    timer = setTimeout(tryOpen, 650);
    return () => clearTimeout(timer);
  }, [isMobile, isSetupComplete, tourSeen, settingsOpen, setupWizardOpen, bridgeSetupOpen, setIsOpen, setCurrentStep]);

  // Re-anchor when the current step's target node is remounted. Reactour
  // resolves the selector once and keeps the node — if the sidebar re-renders
  // it away (threads loading in after the tour opened, layout branch swaps),
  // the detached node measures as a zero rect and the popover collapses to the
  // window's top-left corner. Touching `steps` forces reactour to re-resolve.
  useEffect(() => {
    if (!isOpen) return;
    const step = appTourSteps[currentStep];
    const selector = typeof step?.selector === 'string' ? step.selector : null;
    if (!selector) return;
    let tracked = document.querySelector(selector);
    const interval = setInterval(() => {
      const current = document.querySelector(selector);
      if (!current) return;
      if (current !== tracked || !tracked?.isConnected) {
        tracked = current;
        setSteps?.((prev) => [...prev]);
      }
    }, 400);
    return () => clearInterval(interval);
  }, [isOpen, currentStep, setSteps]);

  // Mark as seen the first time the tour closes (manual close or finish).
  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      if (!tourSeen) setTourSeen(true);
    }
  }, [isOpen, tourSeen, setTourSeen]);

  return null;
}

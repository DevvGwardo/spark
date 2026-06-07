import { useEffect, useRef } from 'react';
import { useTour } from '@reactour/tour';
import { useUIStore } from '@/stores/ui-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useIsMobile } from '@/hooks/use-mobile';

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
  const { setIsOpen, isOpen, setCurrentStep } = useTour();
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
    // Small delay lets the sidebar/composer mount before the mask measures them.
    const t = setTimeout(() => {
      setCurrentStep(0);
      setIsOpen(true);
    }, 650);
    return () => clearTimeout(t);
  }, [isMobile, isSetupComplete, tourSeen, settingsOpen, setupWizardOpen, bridgeSetupOpen, setIsOpen, setCurrentStep]);

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

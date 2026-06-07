import { TourProvider } from '@reactour/tour';
import { AppLayout } from '@/components/layout/AppLayout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { appTourSteps, tourStyles } from '@/components/tour/tour-config';
import { TourController } from '@/components/tour/TourController';

const Index = () => {
  return (
    <ErrorBoundary>
      <TourProvider
        steps={appTourSteps}
        styles={tourStyles}
        padding={{ mask: 6, popover: [10, 10] }}
        showBadge
        showCloseButton
        scrollSmooth
        disableInteraction
      >
        <AppLayout />
        <TourController />
      </TourProvider>
    </ErrorBoundary>
  );
};

export default Index;

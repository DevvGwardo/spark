import { AppLayout } from '@/components/layout/AppLayout';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const Index = () => {
  return (
    <ErrorBoundary>
      <AppLayout />
    </ErrorBoundary>
  );
};

export default Index;

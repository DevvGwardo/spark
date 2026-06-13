import { lazy, Suspense } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Routes, Route } from "react-router-dom";

// Route-level code splitting: phones opening /m don't download the desktop
// app chunk (and vice versa) — matters most over a tunnel connection.
const Index = lazy(() => import("./pages/Index"));
const MobileShell = lazy(() => import("./mobile/MobileShell"));
const MobileChat = lazy(() => import("./mobile/MobileChat"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient();

const routeFallback = (
  <div className="flex min-h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
    Loading…
  </div>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Suspense fallback={routeFallback}>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/m" element={<MobileShell />} />
            <Route path="/m/chat" element={<MobileChat />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </HashRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

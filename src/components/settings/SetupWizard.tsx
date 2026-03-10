import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowRight, ArrowLeft, Eye, EyeOff, CheckCircle, Loader2, Zap, Code } from 'lucide-react';
import { useSettingsStore, type Provider } from '@/stores/settings-store';
import { PROVIDERS, PROVIDER_ORDER, CATEGORY_LABELS, type ProviderCategory } from '@/lib/providers';
import { validateApiKey } from '@/lib/api';
import { cn } from '@/lib/utils';

// Group providers by category
function groupProvidersByCategory() {
  const groups: Record<ProviderCategory, Provider[]> = {
    featured: [],
    'open-source': [],
    specialized: [],
  };
  for (const p of PROVIDER_ORDER) {
    const info = PROVIDERS[p];
    if (info && groups[info.category]) {
      groups[info.category].push(p);
    }
  }
  return groups;
}

const CATEGORY_ORDER: ProviderCategory[] = ['featured', 'open-source', 'specialized'];

export const SetupWizard: React.FC = () => {
  const { isSetupComplete, completeSetup, setActiveProvider, updateProviderConfig } = useSettingsStore();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const [isAnimating, setIsAnimating] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<Provider>('openai');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [selectedModel, setSelectedModel] = useState(PROVIDERS.openai.defaultModel);
  const [validatedModels, setValidatedModels] = useState<string[]>([]);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState('');

  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);

  const providerGroups = groupProvidersByCategory();

  // Measure content height after each render for smooth container resizing
  const measureHeight = useCallback(() => {
    if (contentRef.current) {
      const inner = contentRef.current.querySelector('[data-step-content]') as HTMLElement;
      if (inner) {
        setContentHeight(inner.offsetHeight);
      }
    }
  }, []);

  useEffect(() => {
    measureHeight();
    // Re-measure on window resize
    window.addEventListener('resize', measureHeight);
    return () => window.removeEventListener('resize', measureHeight);
  }, [step, measureHeight, validatedModels, validationError]);

  // Small delay to let new step render before measuring
  useEffect(() => {
    const t = setTimeout(measureHeight, 20);
    return () => clearTimeout(t);
  }, [step, measureHeight]);

  if (isSetupComplete) return null;

  const providerInfo = PROVIDERS[selectedProvider];
  const needsApiKey = providerInfo.needsApiKey;

  const goToStep = (next: number) => {
    if (isAnimating) return;
    setDirection(next > step ? 'forward' : 'backward');
    setIsAnimating(true);
    setStep(next);
    setTimeout(() => setIsAnimating(false), 400);
  };

  const handleProviderSelect = (p: Provider) => {
    setSelectedProvider(p);
    setSelectedModel(PROVIDERS[p].defaultModel);
    setValidatedModels([]);
    setApiKey('');
    setValidationError('');
  };

  const handleContinueFromProvider = () => {
    goToStep(needsApiKey ? 1 : 2);
  };

  const handleValidateAndContinue = async () => {
    if (!apiKey.trim()) return;
    setValidating(true);
    setValidationError('');

    try {
      const result = await validateApiKey(selectedProvider, apiKey.trim());
      if (result.valid) {
        const nextModels = result.models?.filter(Boolean) || [];
        setValidatedModels(nextModels);
        if (nextModels.length > 0) {
          setSelectedModel((current) => nextModels.includes(current) ? current : nextModels[0]);
        }
        goToStep(2);
      } else {
        setValidationError(result.error || 'Invalid API key');
      }
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Unable to validate API key');
    } finally {
      setValidating(false);
    }
  };

  const availableModels = validatedModels.length > 0 ? validatedModels : providerInfo.models;

  const handleComplete = () => {
    setActiveProvider(selectedProvider);
    updateProviderConfig(selectedProvider, {
      apiKey,
      model: selectedModel,
    });
    completeSetup();
  };

  const badgeIcon = (badge?: string) => {
    if (badge === 'Free') return <Zap className="h-3 w-3" />;
    if (badge === 'Fast') return <Zap className="h-3 w-3" />;
    if (badge === 'Coding') return <Code className="h-3 w-3" />;
    return null;
  };

  const renderProviderGrid = () => (
    <div key="provider" data-step-content>
      <h2 className="text-xl font-semibold mb-1">Choose your provider</h2>
      <p className="text-sm text-muted-foreground mb-5">Select which LLM you'd like to use.</p>
      <div className="space-y-5 max-h-[400px] overflow-y-auto px-1">
        {CATEGORY_ORDER.map((cat) => {
          const providers = providerGroups[cat];
          if (providers.length === 0) return null;
          return (
            <div key={cat}>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
                {CATEGORY_LABELS[cat]}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {providers.map((p) => {
                  const info = PROVIDERS[p];
                  const isSelected = selectedProvider === p;
                  return (
                    <button
                      key={p}
                      onClick={() => handleProviderSelect(p)}
                      className={cn(
                        'relative flex flex-col p-3 rounded-xl border text-left transition-all duration-200',
                        'hover:scale-[1.02] active:scale-[0.98]',
                        isSelected
                          ? 'border-foreground bg-foreground/[0.04] shadow-sm ring-1 ring-foreground/10'
                          : 'border-border hover:border-foreground/20 hover:bg-muted/50'
                      )}
                    >
                      {info.badge && (
                        <span className={cn(
                          'absolute top-2 right-2 flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full',
                          info.badge === 'Free' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                          info.badge === 'Fast' && 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
                          info.badge === 'Coding' && 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
                        )}>
                          {badgeIcon(info.badge)}
                          {info.badge}
                        </span>
                      )}
                      <p className="text-sm font-medium flex items-center gap-1.5">

                        {info.label}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight pr-8">
                        {info.description}
                      </p>
                      {isSelected && (
                        <div className="absolute bottom-2 right-2">
                          <CheckCircle className="h-4 w-4 text-foreground" />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <button
        onClick={handleContinueFromProvider}
        className="mt-5 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-foreground text-background text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all duration-200"
      >
        Continue <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );

  const renderApiKeyStep = () => (
    <div key="apikey" data-step-content>
      <h2 className="text-xl font-semibold mb-1">Enter your API key</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Your key for <span className="text-foreground font-medium">{providerInfo.label}</span>. Stored locally, sent securely.
      </p>
      <div className="relative">
        <input
          type={showKey ? 'text' : 'password'}
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setValidationError(''); }}
          placeholder="sk-..."
          autoFocus
          className="w-full px-3 py-2.5 pr-10 rounded-xl border border-input bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-foreground/40 transition-all duration-200"
        />
        <button
          onClick={() => setShowKey(!showKey)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        >
          {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {validationError && (
        <p className="mt-2 text-sm text-destructive animate-in fade-in slide-in-from-top-1 duration-200">
          {validationError}
        </p>
      )}
      <div className="flex gap-2 mt-6">
        <button
          onClick={() => goToStep(0)}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-muted active:scale-[0.98] transition-all duration-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={handleValidateAndContinue}
          disabled={!apiKey.trim() || validating}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 active:scale-[0.98]',
            apiKey.trim() && !validating
              ? 'bg-foreground text-background hover:opacity-90'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
          )}
        >
          {validating
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Validating...</>
            : <>Continue <ArrowRight className="h-4 w-4" /></>
          }
        </button>
      </div>
      <button
        onClick={() => completeSetup()}
        className="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors duration-200"
      >
        Skip setup for now
      </button>
    </div>
  );

  const renderModelStep = () => (
    <div key="model" data-step-content>
      <h2 className="text-xl font-semibold mb-1">Select a model</h2>
      <p className="text-sm text-muted-foreground mb-5">
        Choose the model for <span className="text-foreground font-medium">{providerInfo.label}</span>.
      </p>
      <div className="grid grid-cols-1 gap-1.5 max-h-[280px] overflow-y-auto pr-1 overflow-y-auto">
        {availableModels.map((m) => (
          <button
            key={m}
            onClick={() => setSelectedModel(m)}
            className={cn(
              'flex items-center gap-3 p-3 rounded-xl border text-left text-sm transition-all duration-200',
              'hover:scale-[1.01] active:scale-[0.99]',
              selectedModel === m
                ? 'border-foreground bg-foreground/[0.04] shadow-sm'
                : 'border-border hover:border-foreground/20 hover:bg-muted/50'
            )}
          >
            {selectedModel === m && <CheckCircle className="h-4 w-4 flex-shrink-0" />}
            <span className={cn('font-mono text-xs', selectedModel !== m && 'ml-7')}>{m}</span>
          </button>
        ))}
      </div>
      <div className="flex gap-2 mt-6">
        <button
          onClick={() => goToStep(needsApiKey ? 1 : 0)}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-muted active:scale-[0.98] transition-all duration-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={handleComplete}
          className="flex-1 px-4 py-2.5 rounded-xl bg-foreground text-background text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all duration-200"
        >
          Start chatting
        </button>
      </div>
    </div>
  );

  const stepRenderers = [renderProviderGrid, renderApiKeyStep, renderModelStep];

  // Animation class based on direction
  const animClass = isAnimating
    ? direction === 'forward'
      ? 'animate-in fade-in slide-in-from-right-4 duration-300'
      : 'animate-in fade-in slide-in-from-left-4 duration-300'
    : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="w-full max-w-lg mx-4">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold tracking-tight">CloudChat</h1>
          <p className="text-xs text-muted-foreground mt-1">Set up your AI chat</p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {[0, 1, 2].map((s) => (
            <div
              key={s}
              className={cn(
                'h-1 rounded-full transition-all duration-400 ease-out',
                s === step ? 'w-8 bg-foreground' : s < step ? 'w-4 bg-foreground/40' : 'w-4 bg-border'
              )}
            />
          ))}
        </div>

        {/* Animated container — px-2 gives room for ring/scale effects inside overflow-hidden */}
        <div
          className="transition-[height] duration-400 ease-out overflow-hidden p-2 -m-2"
          style={{ height: contentHeight ? `${contentHeight + 16}px` : 'auto' }}
        >
          <div ref={contentRef}>
            <div key={step} className={animClass}>
              {stepRenderers[step]()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

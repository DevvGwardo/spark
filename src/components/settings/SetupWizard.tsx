import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowRight, ArrowLeft, Eye, EyeOff, Check, Loader2, KeyRound, Info, Lock, Settings } from 'lucide-react';
import { useSettingsStore, type Provider } from '@/stores/settings-store';
import { PROVIDERS, PROVIDER_ORDER } from '@/lib/providers';
import { validateApiKey } from '@/lib/api';
import { cn } from '@/lib/utils';
import { getLocalProviderRuntimeDetails, parseLocalProviderRuntimeError } from '@/lib/local-provider-runtime';

const STEP_LABELS = ['Provider', 'API Key', 'Finish'] as const;

const PROVIDER_HELP_URLS: Partial<Record<Provider, string>> = {
  openai: 'platform.openai.com/api-keys',
  anthropic: 'console.anthropic.com/settings/keys',
  google: 'aistudio.google.com/apikey',
  xai: 'console.x.ai',
  groq: 'console.groq.com/keys',
  deepseek: 'platform.deepseek.com/api_keys',
  mistral: 'console.mistral.ai/api-keys',
  together: 'api.together.xyz/settings/api-keys',
  cerebras: 'cloud.cerebras.ai/platform',
  openrouter: 'openrouter.ai/keys',
  sambanova: 'cloud.sambanova.ai/apis',
};

export const SetupWizard: React.FC = () => {
  const { isSetupComplete, completeSetup, setActiveProvider, updateProviderConfig } = useSettingsStore();
  const setAvailableModels = useSettingsStore((state) => state.setAvailableModels);
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
    window.addEventListener('resize', measureHeight);
    return () => window.removeEventListener('resize', measureHeight);
  }, [step, measureHeight, validatedModels, validationError]);

  useEffect(() => {
    const t = setTimeout(measureHeight, 20);
    return () => clearTimeout(t);
  }, [step, measureHeight]);

  if (isSetupComplete) return null;

  const providerInfo = PROVIDERS[selectedProvider];
  const needsApiKey = providerInfo.needsApiKey;
  const localRuntimeDetails = getLocalProviderRuntimeDetails(selectedProvider);

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
    setValidationError('');

    if (selectedProvider === 'openclaw') {
      void (async () => {
        try {
          const result = await validateApiKey('openclaw', '');
          if (!result.valid) {
            setValidationError(result.error || 'Start the OpenClaw runtime before continuing.');
            return;
          }

          const nextModels = result.models?.filter(Boolean) || [];
          setValidatedModels(nextModels);
          setAvailableModels('openclaw', nextModels);
          const nextDefaultModel = result.defaultModel || nextModels[0];
          if (nextDefaultModel) {
            setSelectedModel(nextDefaultModel);
          }
          goToStep(2);
        } catch (error) {
          console.error('Failed to load OpenClaw models', error);
          setValidationError(error instanceof Error ? error.message : 'Start the OpenClaw runtime before continuing.');
        }
      })();
      return;
    }

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
        setAvailableModels(selectedProvider, nextModels);
        if (nextModels.length > 0) {
          setSelectedModel((current) => nextModels.includes(current) ? current : (result.defaultModel || nextModels[0]));
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

  const handleComplete = () => {
    setActiveProvider(selectedProvider);
    updateProviderConfig(selectedProvider, {
      apiKey,
      model: selectedModel,
    });
    completeSetup();
  };

  const maskedKey = apiKey
    ? `${apiKey.slice(0, 3)}${'*'.repeat(Math.min(20, apiKey.length - 6))}${apiKey.slice(-3)}`
    : '';

  // --- Step indicator ---
  const renderStepIndicator = () => (
    <div className="flex items-center justify-center gap-0">
      {STEP_LABELS.map((label, i) => {
        const isActive = i === step;
        const isCompleted = i < step;
        return (
          <React.Fragment key={label}>
            {i > 0 && (
              <div
                className={cn(
                  'w-10 h-px',
                  isCompleted ? 'bg-[hsl(var(--success))]' : 'bg-[#2F2F2F]'
                )}
              />
            )}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-colors',
                  isActive && 'bg-primary text-primary-foreground',
                  isCompleted && 'bg-[hsl(var(--success))]',
                  !isActive && !isCompleted && 'border border-[#2F2F2F] text-[#6A6A6A]'
                )}
              >
                {isCompleted ? (
                  <Check className="h-3.5 w-3.5 text-black" />
                ) : (
                  <span>{i + 1}</span>
                )}
              </div>
              <span
                className={cn(
                  'text-[11px] font-medium',
                  isActive ? 'text-foreground' : 'text-[#6A6A6A]'
                )}
              >
                {label}
              </span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );

  // --- Provider icon square ---
  const ProviderIcon: React.FC<{ provider: Provider; size?: number }> = ({ provider, size = 40 }) => {
    const info = PROVIDERS[provider];
    return (
      <div
        className="flex items-center justify-center rounded-[10px] font-semibold text-white flex-shrink-0"
        style={{
          width: size,
          height: size,
          backgroundColor: info.iconColor,
          fontSize: size * 0.4,
        }}
      >
        {info.iconLetter}
      </div>
    );
  };

  // --- Step 0: Provider selection ---
  const renderProviderGrid = () => (
    <div key="provider" data-step-content>
      <h2 className="text-base font-semibold mb-1" style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '-0.3px' }}>
        Choose your provider
      </h2>
      <p className="text-[13px] text-[#8A8A8A] mb-5">Select which LLM you'd like to use.</p>
      {localRuntimeDetails && (
        <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/8 px-4 py-3">
          <p className="text-sm font-medium text-foreground">{localRuntimeDetails.summary}</p>
          <p className="mt-1 text-xs text-muted-foreground">{localRuntimeDetails.detail}</p>
          <div className="mt-2 text-xs font-mono text-foreground">{localRuntimeDetails.command}</div>
        </div>
      )}
      <div className="flex flex-col gap-2.5 max-h-[400px] overflow-y-auto px-0.5">
        {PROVIDER_ORDER.map((p) => {
          const info = PROVIDERS[p];
          const isSelected = selectedProvider === p;
          return (
            <button
              key={p}
              onClick={() => handleProviderSelect(p)}
              className={cn(
                'flex items-center gap-3.5 p-4 rounded-xl border text-left transition-all duration-200',
                'hover:scale-[1.01] active:scale-[0.99]',
                isSelected
                  ? 'border-primary border-[1.5px] bg-primary/[0.06]'
                  : 'border-[#2F2F2F] bg-[#1E1E1E] hover:border-[#444]'
              )}
            >
              <ProviderIcon provider={p} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{info.label}</p>
                <p className="text-[11px] text-[#8A8A8A] mt-0.5 leading-tight truncate">{info.description}</p>
              </div>
              <div
                className={cn(
                  'w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 transition-colors',
                  isSelected
                    ? 'bg-primary'
                    : 'border border-[#2F2F2F]'
                )}
              >
                {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
              </div>
            </button>
          );
        })}
      </div>
      {validationError && (
        <p className="mt-3 text-sm text-destructive animate-in fade-in slide-in-from-top-1 duration-200">
          {parseLocalProviderRuntimeError(selectedProvider, validationError)?.summary || validationError}
        </p>
      )}
      <button
        onClick={handleContinueFromProvider}
        className="mt-5 w-full flex items-center justify-center gap-2 h-11 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all duration-200"
      >
        Continue <ArrowRight className="h-4 w-4" />
      </button>
      <button
        onClick={() => completeSetup()}
        className="mt-3 w-full text-center text-xs text-[#6A6A6A] hover:text-foreground transition-colors duration-200"
      >
        Skip this step
      </button>
    </div>
  );

  // --- Step 1: API key entry ---
  const renderApiKeyStep = () => (
    <div key="apikey" data-step-content className="flex flex-col gap-5">
      <div>
        <h2 className="text-base font-semibold mb-1" style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '-0.3px' }}>
          Enter your API key
        </h2>
        <p className="text-[13px] text-[#8A8A8A]">
          Paste your {providerInfo.label} API key to connect.
        </p>
      </div>

      {/* Provider row */}
      <div className="flex items-center gap-3 p-3 rounded-xl border border-[#2F2F2F] bg-[#1E1E1E]">
        <ProviderIcon provider={selectedProvider} size={32} />
        <span className="text-sm font-medium text-foreground flex-1">{providerInfo.label}</span>
        <button
          onClick={() => goToStep(0)}
          className="text-xs font-medium text-primary hover:underline"
        >
          Change
        </button>
      </div>

      {/* Input group */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-[#6A6A6A]">API Key</label>
        <div className="relative">
          <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#6A6A6A]" />
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setValidationError(''); }}
            placeholder="sk-..."
            autoFocus
            className="w-full h-11 pl-9 pr-10 rounded-lg border border-[#2F2F2F] bg-[#222222] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40 transition-all duration-200"
          />
          <button
            onClick={() => setShowKey(!showKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6A6A6A] hover:text-foreground transition-colors"
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {PROVIDER_HELP_URLS[selectedProvider] && (
          <div className="flex items-center gap-1.5 mt-1">
            <Info className="h-3 w-3 text-[#6A6A6A] flex-shrink-0" />
            <span className="text-[11px] text-[#6A6A6A]">
              Find your API key at {PROVIDER_HELP_URLS[selectedProvider]}
            </span>
          </div>
        )}
      </div>

      {validationError && (
        <p className="text-sm text-destructive animate-in fade-in slide-in-from-top-1 duration-200">
          {validationError}
        </p>
      )}

      {/* Button row */}
      <div className="flex gap-2">
        <button
          onClick={() => goToStep(0)}
          className="flex items-center justify-center gap-1.5 px-4 h-11 rounded-xl border border-[#2F2F2F] bg-[#1E1E1E] text-sm font-medium text-foreground hover:bg-[#252525] active:scale-[0.98] transition-all duration-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={handleValidateAndContinue}
          disabled={!apiKey.trim() || validating}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 h-11 rounded-xl text-sm font-medium transition-all duration-200 active:scale-[0.98]',
            apiKey.trim() && !validating
              ? 'bg-primary text-primary-foreground hover:opacity-90'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
          )}
        >
          {validating
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Validating...</>
            : <>Verify & Connect <ArrowRight className="h-4 w-4" /></>
          }
        </button>
      </div>

      {/* Security note */}
      <div className="flex items-center justify-center gap-1.5">
        <Lock className="h-3 w-3 text-[#6A6A6A]" />
        <span className="text-[11px] text-[#6A6A6A]">Keys are encrypted and stored locally</span>
      </div>
    </div>
  );

  // --- Step 2: Success / Finish ---
  const renderFinishStep = () => (
    <div key="finish" data-step-content className="flex flex-col items-center gap-6">
      {/* Success icon */}
      <div className="w-[72px] h-[72px] rounded-full flex items-center justify-center" style={{ backgroundColor: '#00FF8820' }}>
        <Check className="h-8 w-8" style={{ color: '#00FF88' }} />
      </div>

      <div className="text-center">
        <h2 className="text-base font-semibold mb-1.5" style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '-0.3px' }}>
          You're all set!
        </h2>
        <p className="text-[13px] text-[#8A8A8A]">
          CloudChat is ready to go. Start a new thread to begin.
        </p>
      </div>

      {/* Summary card */}
      <div className="w-full rounded-xl border border-[#2F2F2F] bg-[#1E1E1E] p-4">
        <span
          className="text-[10px] font-semibold uppercase tracking-[1px]"
          style={{ color: '#00FF88' }}
        >
          Connected
        </span>
        <div className="flex items-center gap-3 mt-2.5">
          <ProviderIcon provider={selectedProvider} size={32} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">{providerInfo.label}</p>
            {apiKey && (
              <p className="text-[11px] text-[#6A6A6A] font-mono truncate">{maskedKey}</p>
            )}
          </div>
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
            style={{ backgroundColor: '#00FF8818', color: '#00FF88' }}
          >
            Online
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="w-full flex flex-col items-center gap-3">
        <button
          onClick={handleComplete}
          className="w-full flex items-center justify-center gap-2 h-11 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all duration-200"
        >
          Start Chatting 💬
        </button>
        <button
          onClick={handleComplete}
          className="text-xs text-[#6A6A6A] hover:text-foreground transition-colors duration-200 flex items-center gap-1.5"
        >
          <Settings className="h-3 w-3" /> Go to Settings
        </button>
      </div>
    </div>
  );

  const stepRenderers = [renderProviderGrid, renderApiKeyStep, renderFinishStep];

  const animClass = isAnimating
    ? direction === 'forward'
      ? 'animate-in fade-in slide-in-from-right-4 duration-300'
      : 'animate-in fade-in slide-in-from-left-4 duration-300'
    : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background dark:bg-[#1A1A1A]">
      <div className="w-[480px] mx-4 pt-[60px]">
        {/* Header */}
        <div className="text-center mb-8">
          <h1
            className="text-2xl font-semibold tracking-tight"
            style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '-0.5px' }}
          >
            CloudChat
          </h1>
          <p className="text-xs text-[#8A8A8A] mt-1">Set up your AI chat</p>
        </div>

        {/* Step indicator */}
        <div className="mb-8">
          {renderStepIndicator()}
        </div>

        {/* Animated container */}
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

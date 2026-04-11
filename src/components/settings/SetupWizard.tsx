import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowRight, ArrowLeft, Eye, EyeOff, Check, Loader2, KeyRound, Lock, ChevronDown, ChevronUp } from 'lucide-react';
import { useSettingsStore, type Provider } from '@/stores/settings-store';
import { PROVIDERS, PROVIDER_ORDER } from '@/lib/providers';
import { validateApiKey } from '@/lib/api';
import { cn } from '@/lib/utils';
import { getLocalProviderRuntimeDetails, parseLocalProviderRuntimeError } from '@/lib/local-provider-runtime';
import { detectHermesBridge, hermesHasLocalCredentials, type HermesBridgeStatus } from '@/lib/detect-hermes';

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
  const [selectedProvider, setSelectedProvider] = useState<Provider>('hermes');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [selectedModel, setSelectedModel] = useState(PROVIDERS.hermes.defaultModel);
  const [validatedModels, setValidatedModels] = useState<string[]>([]);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [hermesBridgeStatus, setHermesBridgeStatus] = useState<HermesBridgeStatus | null>(null);
  const [showOtherProviders, setShowOtherProviders] = useState(false);

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
  }, [step, measureHeight, validatedModels, validationError, showOtherProviders]);

  useEffect(() => {
    const t = setTimeout(measureHeight, 20);
    return () => clearTimeout(t);
  }, [step, measureHeight, showOtherProviders]);

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
    setHermesBridgeStatus(null);
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
          if (nextDefaultModel) setSelectedModel(nextDefaultModel);
          goToStep(2);
        } catch (error) {
          setValidationError(error instanceof Error ? error.message : 'Start the OpenClaw runtime before continuing.');
        }
      })();
      return;
    }

    if (selectedProvider === 'hermes') {
      void (async () => {
        try {
          const bridgeStatus = await detectHermesBridge();
          setHermesBridgeStatus(bridgeStatus);
          if (!bridgeStatus) {
            setValidationError('Hermes bridge is not running. Start hermes-bridge/main.py to use Hermes Agent.');
            return;
          }
          if (!bridgeStatus.hasOpenRouterCreds && !bridgeStatus.hasMiniMaxCreds) {
            setValidationError('Hermes bridge has no API credentials. Set HERMES_OPENROUTER_KEY or HERMES_MINIMAX_KEY env var.');
            return;
          }
          if (bridgeStatus.hermesDefaultModel) {
            setSelectedModel(bridgeStatus.hermesDefaultModel);
          }
          goToStep(2);
        } catch (error) {
          setValidationError('Failed to detect Hermes bridge status.');
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
    updateProviderConfig(selectedProvider, { apiKey, model: selectedModel });
    completeSetup();
  };

  const maskedKey = apiKey
    ? `${apiKey.slice(0, 3)}${'*'.repeat(Math.min(20, apiKey.length - 6))}${apiKey.slice(-3)}`
    : '';

  const renderStepIndicator = () => (
    <div className="flex items-center justify-center gap-1.5">
      {STEP_LABELS.map((label, i) => {
        const isActive = i === step;
        const isCompleted = i < step;
        return (
          <div
            key={label}
            className={cn(
              'h-1.5 rounded-full transition-all duration-300',
              isActive ? 'w-6 bg-primary' : 'w-1.5',
              isCompleted ? 'bg-primary/50' : !isActive && 'bg-[#2A2A2A]'
            )}
          />
        );
      })}
    </div>
  );

  const ProviderIcon: React.FC<{ provider: Provider; size?: number }> = ({ provider, size = 26 }) => {
    const info = PROVIDERS[provider];
    return (
      <div
        className="flex items-center justify-center rounded-lg font-semibold text-white flex-shrink-0"
        style={{ width: size, height: size, backgroundColor: info.iconColor, fontSize: size * 0.4 }}
      >
        {info.iconLetter}
      </div>
    );
  };

  // --- Step 0: Provider selection ---
  const renderProviderGrid = () => {
    const isHermesSelected = selectedProvider === 'hermes';
    const others: Provider[] = [...PROVIDER_ORDER, 'openclaw'];

    return (
      <div key="provider" data-step-content>
        <div className="flex items-baseline justify-between mb-5">
          <h2 className="text-[13px] font-semibold tracking-tight text-foreground">Get started</h2>
          <button onClick={() => completeSetup()} className="text-[11px] text-[#555] hover:text-[#888] transition-colors">
            Skip
          </button>
        </div>

        {/* Hermes hero card */}
        <button
          onClick={() => handleProviderSelect('hermes')}
          className={cn(
            'w-full text-left rounded-2xl p-4 transition-all duration-200 border',
            isHermesSelected
              ? 'bg-[#8B5CF6]/8 border-[#8B5CF6]/25 shadow-[0_0_30px_rgba(139,92,246,0.06)]'
              : 'bg-[#161616] border-[#252525] hover:border-[#8B5CF6]/15 hover:bg-[#181818]'
          )}
        >
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#8B5CF6] to-[#6D28D9] flex items-center justify-center flex-shrink-0 shadow-lg shadow-purple-500/10">
              <span className="text-white font-bold text-lg">H</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold text-foreground">Hermes Agent</span>
                <span className="text-[9px] font-medium px-2 py-0.5 rounded-full bg-[#8B5CF6]/15 text-[#A78BFA]">
                  Recommended
                </span>
              </div>
              <p className="text-[11px] text-[#777] mt-1 leading-relaxed">
                400+ models via OpenRouter &middot; tool use &middot; agent loop
              </p>
            </div>
            {isHermesSelected && (
              <div className="w-5 h-5 rounded-full bg-[#8B5CF6] flex items-center justify-center flex-shrink-0">
                <Check className="h-3 w-3 text-white" />
              </div>
            )}
          </div>
        </button>

        {/* Or divider */}
        <div className="flex items-center gap-3 my-4 px-1">
          <div className="flex-1 h-px bg-[#222]" />
          <span className="text-[10px] text-[#444] uppercase tracking-widest font-medium">or</span>
          <div className="flex-1 h-px bg-[#222]" />
        </div>

        {/* Toggle other providers */}
        <button
          onClick={() => setShowOtherProviders(!showOtherProviders)}
          className="w-full flex items-center justify-center gap-2 py-2.5 text-[12px] text-[#888] hover:text-[#aaa] transition-colors rounded-xl hover:bg-[#161616]"
        >
          {showOtherProviders ? 'Hide other providers' : 'Connect with another provider'}
          {showOtherProviders ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        {/* Other providers list */}
        {showOtherProviders && (
          <div className="flex flex-col gap-[3px] rounded-xl border border-[#222] overflow-hidden mt-2 max-h-[260px] overflow-y-auto overscroll-contain">
            {others.map((p) => {
              const info = PROVIDERS[p];
              const isSelected = selectedProvider === p;
              return (
                <button
                  key={p}
                  onClick={() => handleProviderSelect(p)}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors duration-100',
                    isSelected ? 'bg-primary/8' : 'bg-[#141414] hover:bg-[#1A1A1A]'
                  )}
                >
                  <ProviderIcon provider={p} size={24} />
                  <span className="text-[12px] font-medium text-foreground flex-1 truncate">{info.label}</span>
                  {info.badge && (
                    <span className="text-[9px] font-medium text-[#666] px-1.5 py-0.5 rounded bg-[#222]">{info.badge}</span>
                  )}
                  {isSelected && (
                    <div className="w-3.5 h-3.5 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                      <Check className="h-2 w-2 text-primary-foreground" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {validationError && (
          <p className="mt-3 text-[11px] text-destructive animate-in fade-in slide-in-from-top-1 duration-200">
            {parseLocalProviderRuntimeError(selectedProvider, validationError)?.summary || validationError}
          </p>
        )}

        <button
          onClick={handleContinueFromProvider}
          className="mt-4 w-full flex items-center justify-center gap-2 h-11 rounded-xl bg-primary text-primary-foreground text-[13px] font-medium hover:opacity-90 active:scale-[0.98] transition-all duration-200"
        >
          Continue <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  };

  // --- Step 1: API key ---
  const renderApiKeyStep = () => (
    <div key="apikey" data-step-content className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold tracking-tight text-foreground">API key</h2>
        <button onClick={() => goToStep(0)} className="text-[11px] font-medium text-primary hover:underline flex items-center gap-1">
          <ArrowLeft className="h-3 w-3" /> Change provider
        </button>
      </div>

      <div className="flex items-center gap-2">
        <ProviderIcon provider={selectedProvider} size={22} />
        <span className="text-[13px] font-medium text-foreground">{providerInfo.label}</span>
      </div>

      <div className="relative">
        <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#555]" />
        <input
          type={showKey ? 'text' : 'password'}
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setValidationError(''); }}
          placeholder="sk-..."
          autoFocus
          className="w-full h-10 pl-9 pr-10 rounded-xl border border-[#2A2A2A] bg-[#161616] text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40 transition-all duration-200 placeholder:text-[#444]"
        />
        <button onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#555] hover:text-foreground transition-colors">
          {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>

      {PROVIDER_HELP_URLS[selectedProvider] && (
        <span className="text-[10px] text-[#555]">
          Get your key at <span className="text-[#888]">{PROVIDER_HELP_URLS[selectedProvider]}</span>
        </span>
      )}

      {validationError && (
        <p className="text-[11px] text-destructive animate-in fade-in slide-in-from-top-1 duration-200">{validationError}</p>
      )}

      <button
        onClick={handleValidateAndContinue}
        disabled={!apiKey.trim() || validating}
        className={cn(
          'w-full flex items-center justify-center gap-2 h-11 rounded-xl text-[13px] font-medium transition-all duration-200 active:scale-[0.98]',
          apiKey.trim() && !validating
            ? 'bg-primary text-primary-foreground hover:opacity-90'
            : 'bg-[#222] text-[#555] cursor-not-allowed'
        )}
      >
        {validating
          ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Validating...</>
          : <>Connect <ArrowRight className="h-3.5 w-3.5" /></>
        }
      </button>

      <div className="flex items-center justify-center gap-1.5">
        <Lock className="h-2.5 w-2.5 text-[#444]" />
        <span className="text-[10px] text-[#444]">Stored locally, never sent to CloudChat</span>
      </div>
    </div>
  );

  // --- Step 2: Finish ---
  const renderFinishStep = () => (
    <div key="finish" data-step-content className="flex flex-col items-center gap-5">
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: '#00FF8815' }}>
        <Check className="h-6 w-6" style={{ color: '#00FF88' }} />
      </div>
      <div className="text-center">
        <h2 className="text-[15px] font-semibold text-foreground mb-1">You're all set</h2>
        <p className="text-[12px] text-[#666]">Start a new thread to begin chatting.</p>
      </div>
      <div className="w-full rounded-xl border border-[#2A2A2A] bg-[#161616] px-4 py-3">
        <div className="flex items-center gap-3">
          <ProviderIcon provider={selectedProvider} size={32} />
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-foreground">{providerInfo.label}</p>
            {apiKey && <p className="text-[10px] text-[#555] font-mono truncate">{maskedKey}</p>}
          </div>
          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ backgroundColor: '#00FF8815', color: '#00FF88' }}>
            Connected
          </span>
        </div>
      </div>
      <button
        onClick={handleComplete}
        className="w-full flex items-center justify-center gap-2 h-11 rounded-xl bg-primary text-primary-foreground text-[13px] font-medium hover:opacity-90 active:scale-[0.98] transition-all duration-200"
      >
        Start Chatting <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  const stepRenderers = [renderProviderGrid, renderApiKeyStep, renderFinishStep];

  const animClass = isAnimating
    ? direction === 'forward'
      ? 'animate-in fade-in slide-in-from-right-4 duration-300'
      : 'animate-in fade-in slide-in-from-left-4 duration-300'
    : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0F0F0F]">
      <div className="w-[380px] mx-4">
        <div className="text-center mb-6">
          <h1 className="text-lg font-bold tracking-tight text-foreground">CloudChat</h1>
          <div className="mt-2">{renderStepIndicator()}</div>
        </div>
        <div
          className="transition-[height] duration-300 ease-out overflow-hidden"
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

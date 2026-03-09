import React, { useState } from 'react';
import { ArrowRight, Eye, EyeOff, CheckCircle, Loader2, Sparkles } from 'lucide-react';
import { useSettingsStore, type Provider } from '@/stores/settings-store';
import { PROVIDERS, PROVIDER_ORDER } from '@/lib/providers';
import { validateApiKey } from '@/lib/api';
import { cn } from '@/lib/utils';

export const SetupWizard: React.FC = () => {
  const { isSetupComplete, completeSetup, setActiveProvider, updateProviderConfig } = useSettingsStore();
  const [step, setStep] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<Provider>('lovable');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [selectedModel, setSelectedModel] = useState(PROVIDERS.lovable.defaultModel);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState('');

  if (isSetupComplete) return null;

  const providerInfo = PROVIDERS[selectedProvider];
  const needsApiKey = providerInfo.needsApiKey;

  const handleProviderSelect = (p: Provider) => {
    setSelectedProvider(p);
    setSelectedModel(PROVIDERS[p].defaultModel);
    setApiKey('');
    setValidationError('');
  };

  const handleContinueFromProvider = () => {
    if (needsApiKey) {
      setStep(1);
    } else {
      setStep(2);
    }
  };

  const handleValidateAndContinue = async () => {
    if (!apiKey.trim()) return;
    setValidating(true);
    setValidationError('');

    try {
      // For minimax/kimi use the validate endpoint, for others just proceed
      if (selectedProvider === 'minimax' || selectedProvider === 'kimi') {
        const result = await validateApiKey(selectedProvider, apiKey.trim());
        if (result.valid) {
          setStep(2);
        } else {
          setValidationError(result.error || 'Invalid API key');
          setValidating(false);
          return;
        }
      } else {
        // For other providers, trust the user and proceed
        setStep(2);
      }
    } catch {
      // On error, still proceed
      setStep(2);
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

  const steps = [
    // Step 0: Provider selection
    <div key="provider">
      <h2 className="text-xl font-semibold mb-1">Choose your provider</h2>
      <p className="text-sm text-muted-foreground mb-6">Select which LLM you'd like to use.</p>
      <div className="grid gap-1.5 max-h-[340px] overflow-y-auto pr-1">
        {PROVIDER_ORDER.map((p) => {
          const info = PROVIDERS[p];
          return (
            <button
              key={p}
              onClick={() => handleProviderSelect(p)}
              className={cn(
                'flex flex-col p-3 rounded-lg border text-left transition-colors duration-100',
                selectedProvider === p ? 'border-foreground' : 'border-border hover:bg-muted'
              )}
            >
              <p className="text-sm font-medium flex items-center gap-1.5">
                {p === 'lovable' && <Sparkles className="h-3.5 w-3.5" />}
                {info.label}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{info.description}</p>
            </button>
          );
        })}
      </div>
      <button
        onClick={handleContinueFromProvider}
        className="mt-6 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-foreground text-background text-sm font-medium hover:opacity-80 transition-opacity duration-100"
      >
        Continue <ArrowRight className="h-4 w-4" />
      </button>
    </div>,

    // Step 1: API Key
    <div key="apikey">
      <h2 className="text-xl font-semibold mb-1">Enter your API key</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Your key for {providerInfo.label}. Sent securely via proxy.
      </p>
      <div className="relative">
        <input
          type={showKey ? 'text' : 'password'}
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setValidationError(''); }}
          placeholder="sk-..."
          className="w-full px-3 py-2.5 pr-10 rounded-md border border-input bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          onClick={() => setShowKey(!showKey)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        >
          {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {validationError && <p className="mt-2 text-sm text-destructive">{validationError}</p>}
      <div className="flex gap-2 mt-6">
        <button
          onClick={() => setStep(0)}
          className="px-4 py-2.5 rounded-md border border-border text-sm font-medium hover:bg-muted transition-colors duration-100"
        >
          Back
        </button>
        <button
          onClick={handleValidateAndContinue}
          disabled={!apiKey.trim() || validating}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium transition-opacity duration-100',
            apiKey.trim() && !validating
              ? 'bg-foreground text-background hover:opacity-80'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
          )}
        >
          {validating ? <><Loader2 className="h-4 w-4 animate-spin" /> Validating...</> : <>Continue <ArrowRight className="h-4 w-4" /></>}
        </button>
      </div>
      <button
        onClick={() => completeSetup()}
        className="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors duration-100"
      >
        Skip setup for now →
      </button>
    </div>,

    // Step 2: Model selection
    <div key="model">
      <h2 className="text-xl font-semibold mb-1">Select a model</h2>
      <p className="text-sm text-muted-foreground mb-6">Choose the model for {providerInfo.label}.</p>
      <div className="grid gap-1.5 max-h-[280px] overflow-y-auto pr-1">
        {providerInfo.models.map((m) => (
          <button
            key={m}
            onClick={() => setSelectedModel(m)}
            className={cn(
              'flex items-center gap-3 p-3 rounded-md border text-left text-sm transition-colors duration-100',
              selectedModel === m ? 'border-foreground' : 'border-border hover:bg-muted'
            )}
          >
            {selectedModel === m && <CheckCircle className="h-4 w-4 flex-shrink-0" />}
            <span className={cn('font-mono text-xs', selectedModel !== m && 'ml-7')}>{m}</span>
          </button>
        ))}
      </div>
      <div className="flex gap-2 mt-6">
        <button
          onClick={() => setStep(needsApiKey ? 1 : 0)}
          className="px-4 py-2.5 rounded-md border border-border text-sm font-medium hover:bg-muted transition-colors duration-100"
        >
          Back
        </button>
        <button
          onClick={handleComplete}
          className="flex-1 px-4 py-2.5 rounded-md bg-foreground text-background text-sm font-medium hover:opacity-80 transition-opacity duration-100"
        >
          Start chatting
        </button>
      </div>
    </div>,
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="w-full max-w-md mx-4">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold">CloudChat</h1>
          <p className="text-xs text-muted-foreground mt-1">Set up your AI chat</p>
        </div>
        <div className="flex items-center justify-center gap-2 mb-8">
          {[0, 1, 2].map((s) => (
            <div
              key={s}
              className={cn(
                'h-1 rounded-full transition-all duration-150',
                s === step ? 'w-8 bg-foreground' : s < step ? 'w-4 bg-foreground/40' : 'w-4 bg-border'
              )}
            />
          ))}
        </div>
        {steps[step]}
      </div>
    </div>
  );
};

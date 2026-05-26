import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowRight, ArrowLeft, Eye, EyeOff, Check, Loader2, KeyRound, Lock, ChevronDown, ChevronUp } from 'lucide-react';
import { useSettingsStore, type Provider } from '@/stores/settings-store';
import { PROVIDERS, PROVIDER_ORDER } from '@/lib/providers';
import { validateApiKey } from '@/lib/api';
import { cn } from '@/lib/utils';
import { parseLocalProviderRuntimeError } from '@/lib/local-provider-runtime';
import { detectHermesBridge, type HermesBridgeStatus } from '@/lib/detect-hermes';

const STEP_LABELS = ['Provider', 'API Key', 'Finish'] as const;
const HERMES_AGENT_DOCS_URL = 'https://hermes-agent.nousresearch.com/docs/getting-started/quickstart';
const GIT_DOWNLOADS_URL = 'https://git-scm.com/downloads';

type LocalBridgeSetupStatus = NonNullable<NonNullable<typeof window.electronAPI>['bridge']> extends infer B
  ? B extends { status: () => Promise<infer S> }
    ? S
    : never
  : never;

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
  hermes: 'openrouter.ai/keys',
};

export const SetupWizard: React.FC = () => {
  const modalRef = React.useRef<HTMLDivElement>(null);
  const { isSetupComplete, completeSetup, setActiveProvider, updateProviderConfig } = useSettingsStore();
  const setAvailableModels = useSettingsStore((state) => state.setAvailableModels);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const [isAnimating, setIsAnimating] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState<Provider>('hermes');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [selectedModel, setSelectedModel] = useState(PROVIDERS.hermes.defaultModel);
  const [validatedModels, setValidatedModels] = useState<string[]>([]);
  const [validating, setValidating] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [hermesBridgeStatus, setHermesBridgeStatus] = useState<HermesBridgeStatus | null>(null);
  const [localBridgeSetupStatus, setLocalBridgeSetupStatus] = useState<LocalBridgeSetupStatus | null>(null);
  const [_bridgeDetectionAttempts, setBridgeDetectionAttempts] = useState(0);
  const [showOtherProviders, setShowOtherProviders] = useState(false);
  const [showManualKeyEntry, setShowManualKeyEntry] = useState(false);
  const [installingHermesAgent, setInstallingHermesAgent] = useState(false);
  const [installingBridgeDeps, setInstallingBridgeDeps] = useState(false);
  const [startingHermesBridge, setStartingHermesBridge] = useState(false);
  const [hermesInstallLog, setHermesInstallLog] = useState<string[]>([]);
  const [hermesInstallError, setHermesInstallError] = useState('');

  const contentRef = useRef<HTMLDivElement>(null);
  const providerContinueLockRef = useRef(false);
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
  }, [step, measureHeight, validatedModels, validationError, showOtherProviders, showManualKeyEntry, oauthLoading, installingHermesAgent, installingBridgeDeps, startingHermesBridge, hermesInstallError, hermesInstallLog, localBridgeSetupStatus]);

  useEffect(() => {
    const t = setTimeout(measureHeight, 20);
    return () => clearTimeout(t);
  }, [step, measureHeight, showOtherProviders, showManualKeyEntry, oauthLoading, installingHermesAgent, installingBridgeDeps, startingHermesBridge, hermesInstallError, hermesInstallLog, localBridgeSetupStatus]);

  const refreshLocalBridgeSetupStatus = useCallback(async () => {
    const bridge = window.electronAPI?.bridge;
    if (!bridge?.status) {
      setLocalBridgeSetupStatus(null);
      return null;
    }
    try {
      const next = await bridge.status();
      setLocalBridgeSetupStatus(next);
      return next;
    } catch {
      setLocalBridgeSetupStatus(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const runDetection = async (): Promise<HermesBridgeStatus | null> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (cancelled) return null;
        const result = await detectHermesBridge();
        if (result !== null) return result;
        if (attempt < 2 && !cancelled) {
          await new Promise(r => { retryTimer = setTimeout(r, 1500); });
        }
      }
      return null;
    };

    const bootstrapWizard = async () => {
      if (isSetupComplete) {
        if (!cancelled) {
          setIsBootstrapping(false);
        }
        return;
      }

      const bridgeStatus = await runDetection();
      if (cancelled) {
        return;
      }

      setBridgeDetectionAttempts(prev => prev + 1);
      setHermesBridgeStatus(bridgeStatus);
      if (bridgeStatus?.hermesDefaultModel) {
        setSelectedModel(bridgeStatus.hermesDefaultModel);
      }
      if (!bridgeStatus) {
        const setupStatus = await refreshLocalBridgeSetupStatus();
        // Auto-start bridge when all prerequisites are already met.
        if (
          setupStatus?.pythonPath &&
          setupStatus?.bridgeDepsInstalled &&
          setupStatus?.hermesAgentPresent &&
          !setupStatus.bridgeReachable
        ) {
          window.electronAPI?.bridge?.start().catch(() => {});
        }
      }

      if (bridgeStatus?.hasOpenRouterCreds) {
        setActiveProvider('hermes');
        updateProviderConfig('hermes', {
          apiKey: '',
          autoDetected: true,
          model: bridgeStatus.hermesDefaultModel || PROVIDERS.hermes.defaultModel,
        });
        completeSetup();
        return;
      }

      setIsBootstrapping(false);
    };

    void bootstrapWizard();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [completeSetup, isSetupComplete, refreshLocalBridgeSetupStatus, setActiveProvider, updateProviderConfig]);

  const retryBridgeDetection = useCallback(async () => {
    setHermesBridgeStatus(null);
    const result = await detectHermesBridge();
    setBridgeDetectionAttempts(prev => prev + 1);
    setHermesBridgeStatus(result);
    if (!result) {
      await refreshLocalBridgeSetupStatus();
    }
    if (result?.hermesDefaultModel) {
      setSelectedModel(result.hermesDefaultModel);
    }
    if (result?.hasOpenRouterCreds) {
      setActiveProvider('hermes');
      updateProviderConfig('hermes', {
        apiKey: '',
        autoDetected: true,
        model: result.hermesDefaultModel || PROVIDERS.hermes.defaultModel,
      });
      completeSetup();
    }
  }, [completeSetup, refreshLocalBridgeSetupStatus, setActiveProvider, updateProviderConfig]);

  useEffect(() => {
    const bridge = window.electronAPI?.bridge;
    if (!bridge?.onInstallProgress) {
      return;
    }

    return bridge.onInstallProgress((line) => {
      const nextLines = line
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);

      if (nextLines.length === 0) {
        return;
      }

      setHermesInstallLog((prev) => [...prev, ...nextLines].slice(-6));
    });
  }, []);

  // Focus trap: auto-focus first input and trap Tab within modal
  useEffect(() => {
    if (isSetupComplete || isBootstrapping) return;
    const container = modalRef.current;
    if (!container) return;
    const focusable = container.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length > 0) focusable[0].focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const els = [...focusable];
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isSetupComplete, isBootstrapping]);

  if (isSetupComplete || isBootstrapping) return null;

  const providerInfo = PROVIDERS[selectedProvider];
  const needsApiKey = providerInfo.needsApiKey;
  const hasHermesBridgeCreds = Boolean(hermesBridgeStatus?.hasOpenRouterCreds || hermesBridgeStatus?.hasMiniMaxCreds);
  const shouldOfferOpenRouterOAuth = selectedProvider === 'openrouter' || (selectedProvider === 'hermes' && hermesBridgeStatus !== null && !hasHermesBridgeCreds);
  const shouldShowHermesInstallFlow = selectedProvider === 'hermes' && hermesBridgeStatus === null;
  const isHermesSetupBusy = installingHermesAgent || installingBridgeDeps || startingHermesBridge;
  const isHermesBridgeReadyToStart = Boolean(
    localBridgeSetupStatus?.pythonPath &&
    localBridgeSetupStatus?.bridgeDepsInstalled &&
    localBridgeSetupStatus?.hermesAgentPresent,
  );
  const isHermesSetupMissingGit = Boolean(
    localBridgeSetupStatus &&
    !localBridgeSetupStatus.hermesAgentPresent &&
    !localBridgeSetupStatus.gitPath,
  );
  const hermesSetupChecklist = localBridgeSetupStatus
    ? [
        {
          key: 'python',
          label: 'Python',
          satisfied: Boolean(localBridgeSetupStatus.pythonPath),
          description: localBridgeSetupStatus.pythonPath
            ? `Found: ${localBridgeSetupStatus.pythonPath}`
            : 'Install Python 3.10+ so CloudChat can run the local Hermes bridge.',
        },
        {
          key: 'git',
          label: 'Git',
          satisfied: localBridgeSetupStatus.hermesAgentPresent || Boolean(localBridgeSetupStatus.gitPath),
          description: localBridgeSetupStatus.hermesAgentPresent
            ? 'Not required because Hermes Agent is already installed.'
            : localBridgeSetupStatus.gitPath
              ? `Found: ${localBridgeSetupStatus.gitPath}`
              : 'Install Git so CloudChat can download Hermes Agent on first launch.',
        },
        {
          key: 'deps',
          label: 'Bridge deps',
          satisfied: localBridgeSetupStatus.bridgeDepsInstalled,
          description: localBridgeSetupStatus.bridgeDepsInstalled
            ? 'fastapi, uvicorn, httpx, pydantic are available.'
            : 'CloudChat still needs the local bridge Python packages.',
        },
        {
          key: 'agent',
          label: 'Hermes Agent',
          satisfied: localBridgeSetupStatus.hermesAgentPresent,
          description: localBridgeSetupStatus.hermesAgentPresent
            ? 'Already installed in ~/.hermes/hermes-agent.'
            : 'CloudChat still needs a local Hermes Agent checkout.',
        },
        {
          key: 'bridge',
          label: 'Bridge process',
          satisfied: localBridgeSetupStatus.bridgeReachable,
          description: localBridgeSetupStatus.processHealth === 'running'
            ? `Running on port ${localBridgeSetupStatus.bridgePort}.`
            : localBridgeSetupStatus.processHealth === 'starting'
              ? 'Starting… (bridge process is alive but not yet responding)'
              : localBridgeSetupStatus.processHealth === 'crashed'
                ? `Crashed: ${localBridgeSetupStatus.lastStartError || 'Unknown error'}`
                : 'Not started. Click "Start" below to launch.',
        },
      ]
    : [];

  const getHermesMissingCredentialMessage = (status: HermesBridgeStatus) => {
    const missingSources = [
      !status.credentialSources.authJson && '~/.hermes/auth.json',
      !status.credentialSources.env && 'env',
      !status.credentialSources.openclawGateway && '~/.openclaw/openclaw.json',
    ].filter(Boolean).join(', ');

    return `Bridge is running — no OpenRouter credential in ${missingSources}. Continue with OpenRouter to finish setup.`;
  };

  const goToStep = (next: number) => {
    if (isAnimating) return;
    setDirection(next > step ? 'forward' : 'backward');
    setIsAnimating(true);
    setStep(next);
    setTimeout(() => setIsAnimating(false), 200);
  };

  const handleProviderSelect = (p: Provider) => {
    setSelectedProvider(p);
    setSelectedModel(PROVIDERS[p].defaultModel);
    setValidatedModels([]);
    setApiKey('');
    setValidationError('');
    setHermesBridgeStatus(null);
    setLocalBridgeSetupStatus(null);
    setShowManualKeyEntry(false);
    setHermesInstallError('');
    setHermesInstallLog([]);
  };

  const handleContinueFromProvider = () => {
    setValidationError('');
    setHermesInstallError('');
    setHermesInstallLog([]);
    setShowManualKeyEntry(false);

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
        if (providerContinueLockRef.current) return;
        providerContinueLockRef.current = true;
        try {
          const bridgeStatus = await detectHermesBridge();
          setHermesBridgeStatus(bridgeStatus);
          const setupStatus = !bridgeStatus ? await refreshLocalBridgeSetupStatus() : null;
          if (!bridgeStatus) {
            if (setupStatus?.pythonPath && setupStatus.bridgeDepsInstalled && setupStatus.hermesAgentPresent) {
              const startResult = await window.electronAPI?.bridge?.start?.();
              if (startResult?.status !== 'failed') {
                const retriedBridgeStatus = await detectHermesBridge();
                setHermesBridgeStatus(retriedBridgeStatus);
                if (retriedBridgeStatus?.hermesDefaultModel) {
                  setSelectedModel(retriedBridgeStatus.hermesDefaultModel);
                }
                if (retriedBridgeStatus) {
                  if (!retriedBridgeStatus.hasOpenRouterCreds && !retriedBridgeStatus.hasMiniMaxCreds) {
                    setValidationError('');
                    goToStep(1);
                    return;
                  }
                  goToStep(2);
                  return;
                }
              } else if (startResult.message) {
                setHermesInstallError(startResult.message);
              }
            }
            goToStep(1);
            return;
          }
          if (bridgeStatus.hermesDefaultModel) {
            setSelectedModel(bridgeStatus.hermesDefaultModel);
          }
          if (!bridgeStatus.hasOpenRouterCreds && !bridgeStatus.hasMiniMaxCreds) {
            setValidationError('');
            goToStep(1);
            return;
          }
          goToStep(2);
        } catch (_error) {
          setValidationError('Failed to detect Hermes bridge status.');
        } finally {
          providerContinueLockRef.current = false;
        }
      })();
      return;
    }

    goToStep(needsApiKey ? 1 : 2);
  };

  const validateAndContinue = async (nextKey: string) => {
    if (!nextKey.trim()) return;
    setValidating(true);
    setValidationError('');
    try {
      const result = await validateApiKey(selectedProvider, nextKey.trim());
      if (result.valid) {
        setApiKey(nextKey.trim());
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

  const handleValidateAndContinue = async () => {
    await validateAndContinue(apiKey);
  };

  const handleContinueWithOpenRouter = async () => {
    const openrouterOAuth = window.electronAPI?.openrouterOAuth;
    if (!openrouterOAuth) {
      setValidationError('OpenRouter sign-in is only available in the desktop app.');
      return;
    }

    setOauthLoading(true);
    setValidationError('');
    try {
      const nextKey = await openrouterOAuth();
      setOauthLoading(false);
      await validateAndContinue(nextKey);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'OpenRouter sign-in failed.');
    } finally {
      setOauthLoading(false);
    }
  };

  const handleInstallHermes = async () => {
    const bridge = window.electronAPI?.bridge;
    if (!bridge?.installHermesAgent || !bridge?.start || !bridge?.status || !bridge?.installDeps) {
      setHermesInstallError('Hermes Agent install is only available in the desktop app.');
      return;
    }

    setValidationError('');
    setHermesInstallError('');
    setHermesInstallLog([]);

    try {
      const setupStatus = await refreshLocalBridgeSetupStatus();
      if (!setupStatus) {
        setHermesInstallError('CloudChat could not inspect your local Hermes setup.');
        return;
      }

      if (!setupStatus.pythonPath) {
        setHermesInstallError('Install Python 3.10+ first, then try again.');
        return;
      }

      if (!setupStatus.hermesAgentPresent && !setupStatus.gitPath) {
        setHermesInstallError('Install Git first so CloudChat can download Hermes Agent.');
        return;
      }

      if (!setupStatus.bridgeDepsInstalled) {
        setInstallingBridgeDeps(true);
        setHermesInstallLog((prev) => [...prev, 'Installing local bridge dependencies…']);
        const depsResult = await bridge.installDeps();
        setInstallingBridgeDeps(false);
        if (!depsResult.ok) {
          const message = (depsResult.message || 'Bridge dependency install failed.').trim();
          const lines = message.split(/\r?\n/).filter(Boolean);
          setHermesInstallError(lines[lines.length - 1] || message);
          return;
        }
        setHermesInstallLog((prev) => [...prev, 'Bridge dependencies installed.']);
      }

      const refreshedStatus = await refreshLocalBridgeSetupStatus();
      if (!refreshedStatus?.hermesAgentPresent) {
        setInstallingHermesAgent(true);
        setHermesInstallLog((prev) => [...prev, 'Installing Hermes Agent…']);
        const result = await bridge.installHermesAgent();
        setInstallingHermesAgent(false);
        if (!result.ok) {
          const message = (result.message || 'Hermes Agent install failed.').trim();
          const lines = message.split(/\r?\n/).filter(Boolean);
          setHermesInstallError(lines[lines.length - 1] || message);
          return;
        }
        setHermesInstallLog((prev) => [...prev, 'Hermes Agent installed.']);
      }

      setStartingHermesBridge(true);
      setHermesInstallLog((prev) => [...prev, 'Starting Hermes bridge…']);
      const startResult = await bridge.start();
      setStartingHermesBridge(false);
      if (startResult.status === 'failed') {
        const message = (startResult.message || 'Hermes bridge failed to start.').trim();
        const lines = message.split(/\r?\n/).filter(Boolean);
        setHermesInstallError(lines[lines.length - 1] || message);
        await refreshLocalBridgeSetupStatus();
        return;
      }

      const bridgeStatus = await detectHermesBridge();
      setHermesBridgeStatus(bridgeStatus);
      if (!bridgeStatus) {
        setHermesInstallError('Hermes Agent installed, but the bridge is still unavailable.');
        await refreshLocalBridgeSetupStatus();
        return;
      }

      if (bridgeStatus.hermesDefaultModel) {
        setSelectedModel(bridgeStatus.hermesDefaultModel);
      }

      if (bridgeStatus.hasOpenRouterCreds || bridgeStatus.hasMiniMaxCreds) {
        goToStep(2);
        return;
      }

      setValidationError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Hermes Agent install failed.';
      const lines = message.split(/\r?\n/).filter(Boolean);
      setHermesInstallError(lines[lines.length - 1] || message);
    } finally {
      setInstallingHermesAgent(false);
      setInstallingBridgeDeps(false);
      setStartingHermesBridge(false);
    }
  };

  const handleComplete = () => {
    setActiveProvider(selectedProvider);
    updateProviderConfig(selectedProvider, {
      apiKey,
      autoDetected: selectedProvider === 'hermes' && !apiKey.trim() && hasHermesBridgeCreds,
      model: selectedModel,
    });
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
              'h-1.5 rounded-full transition-all duration-200',
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
  const renderApiKeyStep = () => {
    const oauthBusy = oauthLoading || validating;

    return (
      <div key="apikey" data-step-content className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold tracking-tight text-foreground">
            {shouldShowHermesInstallFlow ? 'Hermes Agent' : 'API key'}
          </h2>
          <button onClick={() => goToStep(0)} className="text-[11px] font-medium text-primary hover:underline flex items-center gap-1">
            <ArrowLeft className="h-3 w-3" /> Change provider
          </button>
        </div>

        <div className="flex items-center gap-2">
          <ProviderIcon provider={selectedProvider} size={22} />
          <span className="text-[13px] font-medium text-foreground">{providerInfo.label}</span>
        </div>

        {shouldShowHermesInstallFlow ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-[#2A2A2A] bg-[#141414] px-3.5 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] leading-relaxed text-[#666]">
                  {isHermesBridgeReadyToStart
                    ? 'Hermes is installed locally, but the bridge is offline. Start it for this launch and continue.'
                    : 'Hermes bridge is offline. CloudChat can fix the local setup from here before continuing.'}
                </p>
                <button
                  onClick={retryBridgeDetection}
                  className="shrink-0 text-[11px] font-medium text-primary hover:underline"
                  title="Re-check bridge status"
                >
                  Refresh
                </button>
              </div>
            </div>

            {localBridgeSetupStatus && (
              <div className="rounded-xl border border-[#2A2A2A] bg-[#111111] px-3 py-2.5">
                <div className="grid grid-cols-2 gap-2 text-[10px] text-[#8A8A8A]">
                  {hermesSetupChecklist.map((item) => (
                    <div key={item.key} className="rounded-lg border border-[#222] bg-[#151515] px-2.5 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[#B8B8B8]">{item.label}</span>
                        <span className={cn('text-[9px] uppercase tracking-wide', item.satisfied ? 'text-[#00FF88]' : 'text-[#FFB86B]')}>
                          {item.satisfied ? 'Ready' : 'Needed'}
                        </span>
                      </div>
                      <p className="mt-1 leading-relaxed">{item.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!localBridgeSetupStatus && (
              <div className="rounded-xl border border-[#2A2A2A] bg-[#111111] px-3 py-2.5 text-[11px] leading-relaxed text-[#8A8A8A]">
                CloudChat could not inspect the local Hermes setup yet. Refresh to retry the local checks.
              </div>
            )}

            {isHermesSetupMissingGit && (
              <p className="text-[11px] text-[#B8B8B8]">
                Install{' '}
                <a
                  href={GIT_DOWNLOADS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  Git
                </a>{' '}
                first so CloudChat can download Hermes Agent.
              </p>
            )}

            {(isHermesSetupBusy || hermesInstallLog.length > 0) && (
              <div className="rounded-xl border border-[#2A2A2A] bg-[#111111] px-3 py-2.5">
                <div className="flex flex-col gap-1 font-mono text-[10px] leading-[1.45] text-[#8A8A8A]">
                  {hermesInstallLog.map((line, index) => (
                    <span key={`${line}-${index}`} className="truncate">{line}</span>
                  ))}
                </div>
              </div>
            )}

            {hermesInstallError && (
              <p className="text-[11px] text-destructive animate-in fade-in slide-in-from-top-1 duration-200">
                {hermesInstallError}{' '}
                <a
                  href={HERMES_AGENT_DOCS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  View docs
                </a>
              </p>
            )}

            {!hermesInstallError && localBridgeSetupStatus?.lastStartError && (
              <p className="text-[11px] text-[#FFB86B] animate-in fade-in slide-in-from-top-1 duration-200">
                {localBridgeSetupStatus.lastStartError}
              </p>
            )}

            <button
              onClick={handleInstallHermes}
              disabled={isHermesSetupBusy || !localBridgeSetupStatus || !localBridgeSetupStatus.pythonPath || isHermesSetupMissingGit}
              className={cn(
                'w-full flex items-center justify-center gap-2 h-11 rounded-xl text-[13px] font-medium transition-all duration-200 active:scale-[0.98]',
                isHermesSetupBusy || !localBridgeSetupStatus || !localBridgeSetupStatus.pythonPath || isHermesSetupMissingGit
                  ? 'bg-[#222] text-[#909090]'
                  : 'bg-primary text-primary-foreground hover:opacity-90'
              )}
            >
              {installingBridgeDeps
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Installing bridge deps…</>
                : installingHermesAgent
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Installing Hermes Agent…</>
                  : startingHermesBridge
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting Hermes bridge…</>
                    : isHermesBridgeReadyToStart
                      ? <>Start Hermes bridge <ArrowRight className="h-3.5 w-3.5" /></>
                      : <>Fix local Hermes setup <ArrowRight className="h-3.5 w-3.5" /></>
              }
            </button>
          </div>
        ) : shouldOfferOpenRouterOAuth ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-[#2A2A2A] bg-[#141414] px-3.5 py-3">
              <p className="text-[11px] leading-relaxed text-[#666]">
                {selectedProvider === 'hermes' && hermesBridgeStatus
                  ? getHermesMissingCredentialMessage(hermesBridgeStatus)
                  : 'Continue with OpenRouter to connect your account without pasting a key.'}
              </p>
            </div>

            {validationError && (
              <p className="text-[11px] text-destructive animate-in fade-in slide-in-from-top-1 duration-200">{validationError}</p>
            )}

            <button
              onClick={handleContinueWithOpenRouter}
              disabled={oauthBusy}
              className={cn(
                'w-full flex items-center justify-center gap-2 h-11 rounded-xl text-[13px] font-medium transition-all duration-200 active:scale-[0.98]',
                oauthBusy
                  ? 'bg-[#222] text-[#909090]'
                  : 'bg-primary text-primary-foreground hover:opacity-90'
              )}
            >
              {oauthLoading
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Opening OpenRouter…</>
                : validating
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Finishing setup…</>
                  : <>Continue with OpenRouter <ArrowRight className="h-3.5 w-3.5" /></>
              }
            </button>

            <button
              onClick={() => setShowManualKeyEntry((current) => !current)}
              className="w-full flex items-center justify-center gap-2 py-2.5 text-[12px] text-[#888] hover:text-[#aaa] transition-colors rounded-xl hover:bg-[#161616]"
            >
              Have a key? Enter manually
              {showManualKeyEntry ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>

            {showManualKeyEntry && (
              <div className="rounded-xl border border-[#2A2A2A] bg-[#141414] px-3.5 py-3 flex flex-col gap-3">
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

                <button
                  onClick={handleValidateAndContinue}
                  disabled={!apiKey.trim() || validating}
                  className={cn(
                    'w-full flex items-center justify-center gap-2 h-10 rounded-xl text-[12px] font-medium transition-all duration-200 active:scale-[0.98]',
                    apiKey.trim() && !validating
                      ? 'border border-[#2A2A2A] bg-[#191919] text-foreground hover:border-[#3A3A3A]'
                      : 'border border-[#222] bg-[#151515] text-[#555] cursor-not-allowed'
                  )}
                >
                  {validating
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Validating…</>
                    : <>Continue with key <ArrowRight className="h-3.5 w-3.5" /></>
                  }
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
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
          </>
        )}

        {!shouldShowHermesInstallFlow && (
          <div className="flex items-center justify-center gap-1.5">
            <Lock className="h-2.5 w-2.5 text-[#444]" />
            <span className="text-[10px] text-[#444]">Stored locally, never sent to CloudChat</span>
          </div>
        )}
      </div>
    );
  };

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
            {selectedProvider === 'hermes' && !apiKey.trim() && hasHermesBridgeCreds ? 'Signed in via Hermes' : 'Connected'}
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
      ? 'animate-in fade-in slide-in-from-right-4 duration-200'
      : 'animate-in fade-in slide-in-from-left-4 duration-200'
    : '';

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="CloudChat Setup Wizard" className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="w-[380px] mx-4">
        <div className="text-center mb-6">
          <h1 className="text-lg font-bold tracking-tight text-foreground">CloudChat</h1>
          <div className="mt-2">{renderStepIndicator()}</div>
        </div>
        <div
          className="transition-[height] duration-200 ease-out overflow-hidden"
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

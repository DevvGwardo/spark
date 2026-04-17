import React, { useCallback, useEffect, useState } from 'react';
import {
  MessageCircle, Send, Hash, Phone, Mail, Radio, Globe,
  Check, X, Eye, EyeOff, ExternalLink, AlertCircle, Loader2,
  ChevronRight, ChevronDown, Unplug, TestTube2, RefreshCw,
  ShieldCheck, Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getActiveProfile } from '@/stores/profiles-store';
import {
  fetchMessagingPlatforms,
  updatePlatformEnv,
  updatePlatformConfig,
  disconnectPlatform,
  testPlatformConnection,
  restartPlatformGateway,
  getOAuthStatus,
  getApiBaseUrl,
  type MessagingPlatform,
  type MessagingPlatformField,
  type OAuthStatus,
} from '@/lib/api';

// ─── Platform Icons ─────────────────────────────────────────────────────

const PLATFORM_ICONS: Record<string, React.FC<{ className?: string }>> = {
  telegram: Send,
  discord: Hash,
  slack: MessageCircle,
  whatsapp: Phone,
  signal: Radio,
  email: Mail,
  sms: Phone,
};

const PLATFORM_COLORS: Record<string, string> = {
  telegram: '#0088cc',
  discord: '#5865F2',
  slack: '#4A154B',
  whatsapp: '#25D366',
  signal: '#3A76F0',
  email: '#EA4335',
  sms: '#FF6B00',
};

// ─── Styles ─────────────────────────────────────────────────────────────

const cardClass = 'rounded-[10px] border border-[#2a2a2a] bg-white/[0.02] overflow-hidden';
const fieldLabelClass = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80';
const textInputClass = 'w-full rounded-[10px] border border-[#2a2a2a] bg-[#141414] px-3 py-2 text-sm text-foreground outline-none transition-colors duration-100 placeholder:text-muted-foreground focus:border-[#FF8400]/40 focus:ring-1 focus:ring-[#FF8400]/20';
const buttonClass = 'rounded-[10px] px-4 py-2 text-[13px] font-medium transition-colors duration-100';
const platformCardClass = 'rounded-[10px] bg-white/[0.016] border border-[#2a2a2a] px-4 py-[14px] flex items-center gap-[14px] w-full text-left transition-colors duration-100 hover:bg-white/[0.04] cursor-pointer';

// ─── Platform Card (list view) ──────────────────────────────────────────

function PlatformCard({
  platform,
  onClick,
}: {
  platform: MessagingPlatform;
  onClick: () => void;
}) {
  const Icon = PLATFORM_ICONS[platform.id] || Globe;
  const color = PLATFORM_COLORS[platform.id] || '#888';

  return (
    <button className={platformCardClass} onClick={onClick}>
      <div
        className="h-[38px] w-[38px] rounded-[10px] flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}18` }}
      >
        <Icon className="h-4 w-4" style={{ color }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{platform.name}</span>
          {platform.is_connected && (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
              <Check className="h-2.5 w-2.5" />
              Connected
            </span>
          )}
          {!platform.is_connected && platform.total_required > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-[#666]">
              Not configured
            </span>
          )}
        </div>
        <p className="text-xs text-[#666666] truncate">{platform.description}</p>
        <div className="flex gap-1.5 mt-1 flex-wrap">
          {platform.features.slice(0, 4).map(f => (
            <span key={f} className="rounded-full bg-white/[0.03] px-1.5 py-0.5 text-[9px] text-[#555] font-mono">
              {f}
            </span>
          ))}
          {platform.features.length > 4 && (
            <span className="text-[9px] text-[#444]">+{platform.features.length - 4}</span>
          )}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-[#444444] shrink-0" />
    </button>
  );
}

// ─── Toggle Switch ──────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200',
        checked ? 'bg-[#FF8400]' : 'bg-[#333]',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-md transition-transform duration-200',
          checked ? 'translate-x-[22px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}

// ─── Platform Detail View ───────────────────────────────────────────────

function PlatformDetail({
  platform,
  onBack,
  onRefresh,
}: {
  platform: MessagingPlatform;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectMsg, setConnectMsg] = useState<string | null>(null);
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus | null>(null);
  const [oauthLoading, setOauthLoading] = useState(false);

  const color = PLATFORM_COLORS[platform.id] || '#888';
  const Icon = PLATFORM_ICONS[platform.id] || Globe;

  // Initialize values from platform fields
  useEffect(() => {
    const init: Record<string, string> = {};
    for (const [key, field] of Object.entries(platform.fields)) {
      if (field.type === 'boolean') {
        init[key] = String(field.value);
      } else {
        init[key] = field.is_set && !field.is_secret ? field.value : '';
      }
    }
    setValues(init);
  }, [platform]);

  const envFields = Object.entries(platform.fields).filter(
    ([, f]) => !f.type
  ) as [string, MessagingPlatformField][];

  const configFields = Object.entries(platform.fields).filter(
    ([, f]) => f.type
  ) as [string, MessagingPlatformField & { type: string }][];

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testPlatformConnection(platform.id);
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, error: e instanceof Error ? e.message : 'Test failed' });
    } finally {
      setTesting(false);
    }
  }, [platform.id]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setConnectMsg(null);
    setTestResult(null);
    try {
      // 1. Save credentials
      const envUpdates: Record<string, string> = {};
      const configUpdates: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(values)) {
        const field = platform.fields[key];
        if (!field) continue;

        if (field.type === 'boolean') {
          configUpdates[key] = value === 'true';
        } else if (field.type) {
          configUpdates[key] = value;
        } else {
          envUpdates[key] = value;
        }
      }

      if (Object.keys(envUpdates).length > 0) {
        await updatePlatformEnv(platform.id, envUpdates);
      }
      if (Object.keys(configUpdates).length > 0) {
        await updatePlatformConfig(platform.id, configUpdates);
      }

      // 2. Test connection
      const testRes = await testPlatformConnection(platform.id);
      if (!testRes.success) {
        setTestResult(testRes);
        if (testRes.error?.toLowerCase().includes('bridge') || testRes.error?.toLowerCase().includes('offline')) {
          setConnectMsg('Bridge is offline. Make sure the gateway is running.');
        }
        setConnecting(false);
        return;
      }
      setTestResult(testRes);

      // 3. Restart gateway
      setConnectMsg('Restarting gateway...');
      const restartRes = await restartPlatformGateway(platform.id);
      if (!restartRes.success) {
        setConnectMsg('Saved & tested OK — gateway restart failed. Restart manually with hermes gateway restart.');
      } else {
        setConnectMsg('Connected! Restarting gateway...');
        onRefresh();
        setTimeout(() => setConnectMsg(null), 4000);
      }
    } catch (e) {
      setConnectMsg(e instanceof Error ? e.message : 'Connection failed');
    } finally {
      setConnecting(false);
    }
  }, [values, platform, onRefresh]);

  const handleOAuthSetup = useCallback(async () => {
    setOauthLoading(true);
    setConnectMsg(null);
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    const handleMessage = (event: MessageEvent) => {
      if (event.data === `oauth-success:${platform.id}`) {
        if (pollInterval) clearInterval(pollInterval);
        window.removeEventListener('message', handleMessage);
        setConnectMsg('Connected! Refreshing...');
        onRefresh();
        setTimeout(() => setConnectMsg(null), 3000);
      }
    };
    window.addEventListener('message', handleMessage);
    try {
      const status = await getOAuthStatus(platform.id);
      setOauthStatus(status);
      if (!status.available) {
        setConnectMsg(status.error || 'OAuth not available');
        window.removeEventListener('message', handleMessage);
        return;
      }
      const popup = window.open(
        status.auth_url,
        `${platform.id}-oauth`,
        'width=500,height=700,toolbar=no,menubar=no',
      );
      if (!popup) {
        setConnectMsg('Popup blocked — allow popups for this site and try again');
        window.removeEventListener('message', handleMessage);
        return;
      }
      // Poll platform status to detect when OAuth tokens are saved
      pollInterval = setInterval(async () => {
        try {
          const data = await fetch(`${getApiBaseUrl()}/api/hermes/messaging/platforms/${encodeURIComponent(platform.id)}`, {
            headers: { 'X-Hermes-Profile': getActiveProfile() },
          });
          if (data.ok) {
            const json = await data.json();
            if (json.platform?.is_connected) {
              if (pollInterval) clearInterval(pollInterval);
              window.removeEventListener('message', handleMessage);
              if (!popup.closed) popup.close();
              setConnectMsg('Connected! Refreshing...');
              onRefresh();
              setTimeout(() => setConnectMsg(null), 3000);
            }
          }
        } catch {
          // ignore poll errors
        }
      }, 2000);
      // Safety net: clean up after 5 minutes
      setTimeout(() => {
        if (pollInterval) clearInterval(pollInterval);
        window.removeEventListener('message', handleMessage);
        if (!popup.closed) popup.close();
      }, 300000);
    } catch (e) {
      if (pollInterval) clearInterval(pollInterval);
      window.removeEventListener('message', handleMessage);
      setConnectMsg(e instanceof Error ? e.message : 'OAuth setup failed');
    } finally {
      setOauthLoading(false);
    }
  }, [platform.id, onRefresh]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await disconnectPlatform(platform.id);
      onRefresh();
      onBack();
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  }, [platform.id, onRefresh, onBack]);

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-[#666] hover:text-[#999] transition-colors">
          <span className="text-sm">← Back</span>
        </button>
      </div>

      <div className="flex items-center gap-3">
        <div
          className="h-[44px] w-[44px] rounded-[12px] flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${color}18` }}
        >
          <Icon className="h-5 w-5" style={{ color }} />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground">{platform.name}</h3>
          <p className="text-[13px] text-[#666666]">{platform.description}</p>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3 rounded-[10px] border border-[#2a2a2a] bg-white/[0.02] px-4 py-3">
        {platform.is_connected ? (
          <div className="flex items-center gap-2 text-emerald-400 text-sm">
            <ShieldCheck className="h-4 w-4" />
            <span>Credentials configured</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[#888] text-sm">
            <AlertCircle className="h-4 w-4" />
            <span>Not configured — add your credentials below</span>
          </div>
        )}
        {platform.gateway_running && (
          <div className="ml-auto flex items-center gap-1.5 text-[10px] text-[#555]">
            <Zap className="h-3 w-3 text-emerald-500" />
            Gateway running
          </div>
        )}
      </div>

      {/* OAuth 1-click setup for Discord / Slack */}
      {['discord', 'slack'].includes(platform.id) && !platform.is_connected && (
        <div className="rounded-[10px] border border-[#2a2a2a] bg-white/[0.02] p-5 space-y-4">
          <div>
            <p className="text-[12px] font-semibold text-foreground mb-1">1-Click Setup</p>
            <p className="text-[12px] text-[#777]">
              Authorize with {platform.name} — your bot token is sent directly to hermes-bridge and never touches the browser.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleOAuthSetup}
              disabled={oauthLoading || connecting}
              className={cn(
                buttonClass,
                'bg-[#FF8400] text-white hover:bg-[#FF9B33] disabled:opacity-50 flex items-center gap-2',
              )}
            >
              {oauthLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              {oauthLoading ? 'Checking...' : `Connect with ${platform.name}`}
            </button>
            {connectMsg && (
              <span className="text-[12px] text-[#888]">{connectMsg}</span>
            )}
          </div>
          {!oauthStatus && !oauthLoading && (
            <p className="text-[11px] text-[#555]">
              Requires {platform.id === 'discord' ? 'DISCORD_CLIENT_ID' : 'SLACK_CLIENT_ID'} in <code className="text-[#FF8400]/60">~/.hermes/.env</code>.
            </p>
          )}
          {oauthStatus && !oauthStatus.available && (
            <p className="text-[11px] text-amber-400/80">{oauthStatus.error}</p>
          )}
          <details className="group">
            <summary className="text-[11px] text-[#555] hover:text-[#888] cursor-pointer list-none flex items-center gap-1">
              <span className="text-[10px] text-[#444] group-open:hidden">▶</span>
              <span className="text-[10px] text-[#444] hidden group-open:block">▼</span>
              Or enter token manually
            </summary>
            <div className="mt-3 space-y-3">
              {envFields.map(([key, field]) => (
                <div key={key}>
                  <label className="block text-[12px] text-[#999] mb-1">
                    {field.label}
                    {field.required && <span className="text-red-400 ml-1">*</span>}
                  </label>
                  <div className="relative">
                    <input
                      type={field.is_secret && !showSecrets[key] ? 'password' : 'text'}
                      value={values[key] ?? ''}
                      onChange={(e) => setValues(v => ({ ...v, [key]: e.target.value }))}
                      placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`}
                      className={textInputClass}
                    />
                    {field.is_secret && (
                      <button
                        onClick={() => setShowSecrets(s => ({ ...s, [key]: !s[key] }))}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#555] hover:text-[#888]"
                      >
                        {showSecrets[key] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* Telegram: open BotFather inline */}
      {platform.id === 'telegram' && !platform.is_connected && (
        <div className="rounded-[10px] border border-[#0088cc]/20 bg-[#0088cc]/5 px-4 py-3 text-sm text-[#0088cc]/80 space-y-2">
          <p className="font-medium text-foreground text-[13px]">Get your Telegram bot token</p>
          <p>Open Telegram, search for <strong>@BotFather</strong>, send <code className="text-[#FF8400]/80">/newbot</code>, follow the steps, and copy the token.</p>
          <button
            onClick={() => window.open('https://t.me/BotFather', '_blank')}
            className="mt-1 flex items-center gap-2 text-[12px] font-medium text-[#0088cc] hover:text-[#0088cc]/70 transition-colors"
          >
            <Zap className="h-3.5 w-3.5" />Open BotFather in Telegram
          </button>
        </div>
      )}

      {/* WhatsApp / SMS: Twilio inline guide */}
      {(platform.id === 'whatsapp' || platform.id === 'sms') && !platform.is_connected && (
        <div className="rounded-[10px] border border-[#FF6B00]/20 bg-[#FF6B00]/5 px-4 py-3 text-sm text-[#FF6B00]/80 space-y-2">
          <p className="font-medium text-foreground text-[13px]">Get your Twilio credentials</p>
          <p>Log into <strong>console.twilio.com</strong> — your Account SID is on the dashboard. Auth Token is under Account → Advanced → Auth Tokens. Phone Number is in Numbers → Active Numbers.</p>
          <button
            onClick={() => window.open('https://console.twilio.com', '_blank')}
            className="mt-1 flex items-center gap-2 text-[12px] font-medium text-[#FF6B00] hover:text-[#FF6B00]/70 transition-colors"
          >
            <Zap className="h-3.5 w-3.5" />Open Twilio Console
          </button>
        </div>
      )}

      {/* Email: Gmail app password guide */}
      {platform.id === 'email' && !platform.is_connected && (
        <div className="rounded-[10px] border border-[#EA4335]/20 bg-[#EA4335]/5 px-4 py-3 text-sm text-[#EA4335]/80 space-y-2">
          <p className="font-medium text-foreground text-[13px]">Generate an App Password</p>
          <p>Gmail requires an App Password (not your regular password). Go to <strong>myaccount.google.com → Security → 2-Step Verification</strong>, then find <strong>App passwords</strong> at the bottom.</p>
          <button
            onClick={() => window.open('https://myaccount.google.com/apppasswords', '_blank')}
            className="mt-1 flex items-center gap-2 text-[12px] font-medium text-[#EA4335] hover:text-[#EA4335]/70 transition-colors"
          >
            <Zap className="h-3.5 w-3.5" />Open Google App Passwords
          </button>
        </div>
      )}

      {/* Signal: setup guide */}
      {platform.id === 'signal' && (
        <div className="rounded-[10px] border border-[#3A76F0]/20 bg-[#3A76F0]/5 px-4 py-3 text-sm text-[#3A76F0]/80 space-y-2">
          <p className="font-medium text-foreground text-[13px]">Install signal-cli first</p>
          <p>Signal requires <code className="text-[#FF8400]/80">signal-cli</code> installed on your machine. Run:</p>
          <code className="block bg-[#141414] rounded px-3 py-2 text-[11px] text-[#ccc] mt-1">
            hermes gateway setup --platform signal
          </code>
          <button
            onClick={() => window.open('https://github.com/AsamK/signal-cli?tab=readme-ov-file#installation', '_blank')}
            className="mt-1 flex items-center gap-2 text-[12px] font-medium text-[#3A76F0] hover:text-[#3A76F0]/70 transition-colors"
          >
            <Zap className="h-3.5 w-3.5" />signal-cli installation guide
          </button>
        </div>
      )}

      {/* Setup note — shown for all non-oauth platforms */}
      {platform.setup_note && !['discord', 'slack'].includes(platform.id) && (
        <div className="rounded-[10px] border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-300/80">
          {platform.setup_note}
        </div>
      )}

      {/* Docs link */}
      {platform.docs_url && (
        <a
          href={platform.docs_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-[13px] text-[#FF8400] hover:text-[#FF9B33] transition-colors"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Setup guide
        </a>
      )}

      {/* Environment Variables — hidden for discord/slack when not connected (shown in OAuth card above) */}
      {envFields.length > 0 && !(['discord', 'slack'].includes(platform.id) && !platform.is_connected) && (
        <div className={cardClass}>
          <div className="px-4 py-3 border-b border-[#2a2a2a]">
            <p className={fieldLabelClass}>Credentials & Tokens</p>
          </div>
          <div className="p-4 space-y-3">
            {envFields.map(([key, field]) => (
              <div key={key}>
                <label className="block text-[12px] text-[#999] mb-1">
                  {field.label}
                  {field.required && <span className="text-red-400 ml-1">*</span>}
                </label>
                <div className="relative">
                  <input
                    type={field.is_secret && !showSecrets[key] ? 'password' : 'text'}
                    value={values[key] ?? ''}
                    onChange={(e) => setValues(v => ({ ...v, [key]: e.target.value }))}
                    placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`}
                    className={textInputClass}
                  />
                  {field.is_secret && (
                    <button
                      onClick={() => setShowSecrets(s => ({ ...s, [key]: !s[key] }))}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[#555] hover:text-[#888]"
                    >
                      {showSecrets[key] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </div>
                {field.is_set && field.is_secret && !values[key] && (
                  <p className="text-[10px] text-emerald-500/70 mt-1">✓ Token is set (hidden)</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Config Options (Discord toggles, etc.) */}
      {configFields.length > 0 && (
        <div className={cardClass}>
          <button
            onClick={() => setShowConfig(!showConfig)}
            className="w-full px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between"
          >
            <p className={fieldLabelClass}>Options</p>
            <ChevronDown className={cn(
              'h-4 w-4 text-[#555] transition-transform',
              showConfig ? 'rotate-180' : ''
            )} />
          </button>
          {showConfig && (
            <div className="p-4 space-y-3">
              {configFields.map(([key, field]) => (
                <div key={key} className="flex items-center justify-between">
                  <label className="text-[13px] text-[#ccc]">{field.label}</label>
                  {field.type === 'boolean' ? (
                    <Toggle
                      checked={values[key] === 'true'}
                      onChange={(v) => setValues(prev => ({ ...prev, [key]: String(v) }))}
                    />
                  ) : (
                    <input
                      type="text"
                      value={values[key] ?? ''}
                      onChange={(e) => setValues(v => ({ ...v, [key]: e.target.value }))}
                      placeholder={field.placeholder || ''}
                      className={cn(textInputClass, 'w-[200px]')}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleConnect}
          disabled={connecting}
          className={cn(
            buttonClass,
            'bg-[#FF8400] text-white hover:bg-[#FF9B33] disabled:opacity-50 flex items-center gap-2',
          )}
        >
          {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          {connecting ? 'Connecting...' : 'Connect'}
        </button>

        <button
          onClick={handleTest}
          disabled={testing || !platform.is_connected}
          className={cn(
            buttonClass,
            'border border-[#2a2a2a] text-[#ccc] hover:bg-white/[0.04] disabled:opacity-50 flex items-center gap-2',
          )}
        >
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TestTube2 className="h-3.5 w-3.5" />}
          Test
        </button>

        {platform.is_connected && (
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className={cn(
              buttonClass,
              'border border-red-500/20 text-red-400 hover:bg-red-500/5 disabled:opacity-50 flex items-center gap-2 ml-auto',
            )}
          >
            {disconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />}
            Disconnect
          </button>
        )}
      </div>

      {/* Connect status messages */}
      {connectMsg && (
        <p className={cn(
          'text-[12px]',
          connectMsg.includes('Failed') || connectMsg.includes('failed') || connectMsg.includes('offline') ? 'text-red-400' : 'text-emerald-400',
        )}>
          {connectMsg}
        </p>
      )}

      {/* Status messages */}
      {saveMsg && (
        <p className={cn(
          'text-[12px]',
          saveMsg.includes('Failed') || saveMsg.includes('Error') ? 'text-red-400' : 'text-emerald-400',
        )}>
          {saveMsg}
        </p>
      )}

      {testResult && (
        <div className={cn(
          'rounded-[10px] border px-4 py-3 text-sm',
          testResult.success
            ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300'
            : 'border-red-500/20 bg-red-500/5 text-red-300',
        )}>
          {testResult.success ? testResult.message : testResult.error}
        </div>
      )}
    </div>
  );
}

// ─── Main MessagingTab ──────────────────────────────────────────────────

export default function MessagingTab() {
  const [platforms, setPlatforms] = useState<MessagingPlatform[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMessagingPlatforms();
      setPlatforms(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load platforms');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selected = selectedPlatform
    ? platforms.find(p => p.id === selectedPlatform) || null
    : null;

  if (selected) {
    return (
      <PlatformDetail
        platform={selected}
        onBack={() => setSelectedPlatform(null)}
        onRefresh={load}
      />
    );
  }

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold text-foreground">Messaging Platforms</h3>
        <p className="text-[13px] text-[#666666]">
          Connect Telegram, Discord, Slack, WhatsApp, Signal, Email, and SMS to chat with your agent from anywhere.
        </p>
      </div>

      {/* Gateway status */}
      <div className="flex items-center gap-3 rounded-[10px] border border-[#2a2a2a] bg-white/[0.02] px-4 py-3">
        {platforms[0]?.gateway_running ? (
          <div className="flex items-center gap-2 text-sm text-emerald-400">
            <Zap className="h-4 w-4" />
            <span>Hermes gateway is running</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-[#888]">
            <AlertCircle className="h-4 w-4" />
            <span>Gateway not detected — start it with <code className="text-[#FF8400]">hermes gateway start</code></span>
          </div>
        )}
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto text-[#555] hover:text-[#888] transition-colors"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-[10px] border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
          {error.toLowerCase().includes('failed to reach') ||
          error.toLowerCase().includes('bridge returned') ||
          error.toLowerCase().includes('fetch') ? (
            <>
              <span className="font-semibold">Hermes Bridge is offline.</span>
              {' '}Start it with{' '}
              <code className="text-[#FF8400]">hermes bridge</code>
              {' '}or{' '}
              <code className="text-[#FF8400]">python main.py</code>
              {' '}from the{' '}
              <code className="text-[#FF8400]">hermes-bridge/</code>
              {' '}directory, then refresh.
            </>
          ) : (
            error
          )}
        </div>
      )}

      {/* Loading */}
      {loading && platforms.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-[#555]" />
        </div>
      )}

      {/* Platform cards */}
      <div className="space-y-2">
        {platforms.map(p => (
          <PlatformCard
            key={p.id}
            platform={p}
            onClick={() => setSelectedPlatform(p.id)}
          />
        ))}
      </div>

      {/* Info footer */}
      <div className="rounded-[10px] border border-[#2a2a2a] bg-white/[0.01] px-4 py-3">
        <p className="text-[11px] text-[#555] leading-relaxed">
          Credentials are stored locally in <code className="text-[#FF8400]/70">~/.hermes/.env</code> and{' '}
          <code className="text-[#FF8400]/70">~/.hermes/config.yaml</code>.
          After configuring a platform, restart the gateway with{' '}
          <code className="text-[#FF8400]/70">hermes gateway restart</code> to connect.
        </p>
      </div>
    </div>
  );
}

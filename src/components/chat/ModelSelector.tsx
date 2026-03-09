import React from 'react';
import { ChevronDown, Settings } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';
import { PROVIDERS } from '@/lib/providers';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export const ModelSelector: React.FC = () => {
  const { activeProvider, providers, updateProviderConfig } = useSettingsStore();
  const { setSettingsOpen } = useUIStore();
  const config = providers[activeProvider];
  const providerInfo = PROVIDERS[activeProvider];
  const models = providerInfo?.models || [];

  const displayModel = config.model.split('/').pop() || config.model;

  return (
    <div className="flex items-center justify-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-100">
            {displayModel}
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="max-h-64 overflow-y-auto">
          {models.map((model) => {
            const label = model.split('/').pop() || model;
            return (
              <DropdownMenuItem
                key={model}
                onClick={() => updateProviderConfig(activeProvider, { model })}
                className={model === config.model ? 'bg-accent' : ''}
              >
                <span className="text-xs">{label}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        onClick={() => setSettingsOpen(true)}
        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-100"
        title="Settings"
      >
        <Settings className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

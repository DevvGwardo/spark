import React, { useState } from 'react';
import { ChatSidebar } from '@/components/sidebar/ChatSidebar';
import { ChatArea } from '@/components/chat/ChatArea';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { SetupWizard } from '@/components/settings/SetupWizard';
import { GitHubPanel, GitHubAnalyzer } from '@/components/github';
import { KnowledgePanel } from '@/components/settings/KnowledgePanel';
import { PreviewSidebar } from '@/components/preview/PreviewSidebar';
import { useUIStore } from '@/stores/ui-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePreviewStore } from '@/stores/preview-store';
import { useTheme } from '@/hooks/useTheme';
import { PanelLeft, MessageSquare, Github, BookOpen, Bug, Eye } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tab = 'chat' | 'github' | 'analyzer' | 'knowledge';

export const AppLayout: React.FC = () => {
  useTheme();
  const { sidebarOpen, setSidebarOpen, toggleSidebar } = useUIStore();
  const { isSetupComplete } = useSettingsStore();
  const { togglePreview } = usePreviewStore();
  const [activeTab, setActiveTab] = useState<Tab>('chat');

  return (
    <>
      {!isSetupComplete && <SetupWizard />}
      <SettingsModal />

      <div className="h-[100dvh] flex bg-background">
        {/* Sidebar */}
        <div
          className={cn(
            'flex-shrink-0 border-r border-border bg-muted/30 transition-all duration-200 overflow-hidden',
            sidebarOpen ? 'w-[260px]' : 'w-0'
          )}
        >
          <div className="w-[260px] h-full">
            <ChatSidebar />
          </div>
        </div>

        {/* Mobile overlay */}
        {sidebarOpen && (
          <div
            className="md:hidden fixed inset-0 z-40 bg-foreground/10"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Main */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header with tabs */}
          <header className="flex items-center h-11 px-3 flex-shrink-0 border-b border-border">
            <button
              onClick={toggleSidebar}
              className="p-2 rounded-md hover:bg-muted transition-colors duration-100 text-muted-foreground hover:text-foreground"
              title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            
            {/* Tab navigation */}
            <div className="flex items-center gap-1 ml-4">
              <button
                onClick={() => setActiveTab('chat')}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors duration-100',
                  activeTab === 'chat' 
                    ? 'bg-secondary text-foreground' 
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                )}
              >
                <MessageSquare className="h-4 w-4" />
                Chat
              </button>
              <button
                onClick={() => setActiveTab('github')}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors duration-100',
                  activeTab === 'github' 
                    ? 'bg-secondary text-foreground' 
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                )}
              >
                <Github className="h-4 w-4" />
                GitHub
              </button>
              <button
                onClick={() => setActiveTab('analyzer')}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors duration-100',
                  activeTab === 'analyzer' 
                    ? 'bg-secondary text-foreground' 
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                )}
              >
                <Bug className="h-4 w-4" />
                Analyzer
              </button>
              <button
                onClick={() => setActiveTab('knowledge')}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors duration-100',
                  activeTab === 'knowledge' 
                    ? 'bg-secondary text-foreground' 
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                )}
              >
                <BookOpen className="h-4 w-4" />
                Knowledge
              </button>
            </div>
            
            <div className="flex-1" />
            <button
              onClick={togglePreview}
              className="p-2 rounded-md hover:bg-muted transition-colors duration-100 text-muted-foreground hover:text-foreground"
              title="Toggle preview"
            >
              <Eye className="h-4 w-4" />
            </button>
            <span className="text-xs font-medium text-muted-foreground tracking-wide">CloudChat</span>
            <div className="flex-1" />
            <div className="w-8" />
          </header>

          <main className="flex-1 overflow-hidden">
            {activeTab === 'chat' && <ChatArea />}
            {activeTab === 'github' && <GitHubPanel />}
            {activeTab === 'analyzer' && (
              <div className="h-full p-6">
                <GitHubAnalyzer />
              </div>
            )}
            {activeTab === 'knowledge' && (
              <div className="h-full p-6">
                <KnowledgePanel />
              </div>
            )}
          </main>
          
          <PreviewSidebar />
        </div>
      </div>
    </>
  );
};

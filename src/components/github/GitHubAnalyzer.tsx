import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Github, AlertTriangle, CheckCircle, Info, Bug, Zap } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { getApiBaseUrl } from '@/lib/api';
import ReactMarkdown from 'react-markdown';

interface AnalysisResult {
  type: 'bug' | 'improvement' | 'security' | 'performance';
  severity: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  file?: string;
  line?: number;
  suggestion: string;
}

interface RepoInfo {
  owner: string;
  repo: string;
  url: string;
}

const parseGitHubUrl = (url: string): RepoInfo | null => {
  try {
    const regex = /github\.com\/([^/]+)\/([^/]+)/;
    const match = url.match(regex);
    if (!match) return null;
    
    return {
      owner: match[1],
      repo: match[2].replace(/\.git$/, ''),
      url: url
    };
  } catch {
    return null;
  }
};

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

const severityConfig: Record<string, { color: BadgeVariant; icon: typeof AlertTriangle }> = {
  high: { color: 'destructive', icon: AlertTriangle },
  medium: { color: 'default', icon: Info },
  low: { color: 'secondary', icon: CheckCircle }
};

const typeConfig: Record<string, { color: BadgeVariant; icon: typeof Bug; label: string }> = {
  bug: { color: 'destructive', icon: Bug, label: 'Bug' },
  improvement: { color: 'default', icon: Zap, label: 'Improvement' },
  security: { color: 'destructive', icon: AlertTriangle, label: 'Security' },
  performance: { color: 'secondary', icon: Zap, label: 'Performance' }
};

export const GitHubAnalyzer: React.FC = () => {
  const [repoUrl, setRepoUrl] = useState('');
  const [_repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[]>([]);
  const [error, setError] = useState('');
  const { githubPAT } = useSettingsStore();

  const handleAnalyze = async () => {
    if (!repoUrl.trim()) return;
    
    const parsed = parseGitHubUrl(repoUrl.trim());
    if (!parsed) {
      setError('Invalid GitHub URL. Please enter a valid repository URL.');
      return;
    }

    if (!githubPAT) {
      setError('GitHub Personal Access Token is required. Please set it in Settings.');
      return;
    }

    setRepoInfo(parsed);
    setIsAnalyzing(true);
    setError('');
    setAnalysisResults([]);

    try {
      const apiBaseUrl = getApiBaseUrl();
      const response = await fetch(`${apiBaseUrl}/functions/v1/github-analyzer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          owner: parsed.owner,
          repo: parsed.repo,
          pat: githubPAT,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      setAnalysisResults(data.analysis || []);
    } catch (err) {
      console.error('Analysis failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to analyze repository');
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Github className="h-5 w-5" />
            GitHub Repository Analyzer
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="https://github.com/owner/repository"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAnalyze()}
            />
            <Button onClick={handleAnalyze} disabled={isAnalyzing}>
              {isAnalyzing ? 'Analyzing...' : 'Analyze'}
            </Button>
          </div>
          
          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {!githubPAT && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                A GitHub Personal Access Token is required to analyze repositories. 
                Set it in Settings → GitHub.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {isAnalyzing && (
        <Card>
          <CardHeader>
            <CardTitle>Analyzing Repository...</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </CardContent>
        </Card>
      )}

      {analysisResults.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Analysis Results
              <Badge variant="outline">
                {analysisResults.length} issue{analysisResults.length !== 1 ? 's' : ''} found
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-[600px]">
              <div className="space-y-4">
                {analysisResults.map((result, index) => {
                  const SeverityIcon = severityConfig[result.severity].icon;
                  const TypeIcon = typeConfig[result.type].icon;
                  
                  return (
                    <div key={index} className="border rounded-lg p-4 space-y-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <TypeIcon className="h-4 w-4" />
                          <h4 className="font-semibold">{result.title}</h4>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant={typeConfig[result.type].color}>
                            {typeConfig[result.type].label}
                          </Badge>
                          <Badge variant={severityConfig[result.severity].color}>
                            <SeverityIcon className="h-3 w-3 mr-1" />
                            {result.severity}
                          </Badge>
                        </div>
                      </div>
                      
                      {result.file && (
                        <div className="text-sm text-muted-foreground">
                          {result.file}{result.line && `:${result.line}`}
                        </div>
                      )}
                      
                      <div className="prose prose-sm max-w-none">
                        <ReactMarkdown>{result.description}</ReactMarkdown>
                      </div>
                      
                      <Separator />
                      
                      <div>
                        <h5 className="font-medium text-sm mb-2">Suggested Fix:</h5>
                        <div className="prose prose-sm max-w-none text-muted-foreground">
                          <ReactMarkdown>{result.suggestion}</ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
export interface PullRequestRecord {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  headRepo?: string;
  baseRepo?: string;
}

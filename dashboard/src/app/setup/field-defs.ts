// Single source of truth for setup field definitions (name, label, help text,
// affordance). Shared by the first-run wizard (wizard.tsx) and the post-setup
// settings overview (status-overview.tsx) so descriptions and point-and-click
// affordances stay in sync across both views.

import type { FieldDef } from './types'

export const REQUIRED_FIELDS: FieldDef[] = [
  { name: 'REPO_URL', label: 'Repo URL', placeholder: 'org/repo', affordance: 'repo', brand: 'github', helpText: 'The GitHub repo the dashboard tracks for PRs, reviews and tickets, in org/repo form.' },
  { name: 'GITHUB_TOKEN', label: 'GitHub token', affordance: 'detect', brand: 'github', helpText: 'Lets the dashboard read your PRs/reviews and push agent branches. PAT with repo scope.', helpUrl: 'https://github.com/settings/tokens/new?scopes=repo&description=do-some-work' },
  { name: 'GITHUB_USERNAME', label: 'GitHub username', brand: 'github', helpText: 'Identifies you when filtering your PRs and review requests. Auto-fills from your token.' },
  { name: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Claude Code OAuth token', brand: 'claude', helpText: 'Lets agent containers run Claude Code headless. Run `claude setup-token` to generate.', helpUrl: 'https://docs.claude.com/en/docs/claude-code/cli-reference' },
  { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', brand: 'anthropic', helpText: 'Powers the dashboard briefing and chat features.', helpUrl: 'https://console.anthropic.com/settings/keys' },
  { name: 'DASHBOARD_URL', label: 'Dashboard URL', helpText: 'Base URL containers use to call back to the dashboard. Pre-filled for your OS.' },
]

export const LINEAR_FIELDS: FieldDef[] = [
  { name: 'LINEAR_API_KEY', label: 'Linear API key', helpText: 'Enables Linear ticket lookup and the Tickets tab. Workspace links are configured automatically from your key. Find it under Linear › Settings › API.', helpUrl: 'https://linear.app/settings/api' },
]

export const LOCAL_REPO_FIELDS: FieldDef[] = [
  { name: 'REPO_PATH', label: 'Repo path', placeholder: '/Users/you/Code/your-org/your-repo', affordance: 'folder', helpText: 'Local path to the repo on this machine — used as a git reference cache for faster clones.' },
]

export const FIGMA_FIELDS: FieldDef[] = [
  { name: 'FIGMA_API_KEY', label: 'Figma API key', helpText: 'Enables the Figma MCP server inside agent containers. PAT with file_read + dev_resources scopes.', helpUrl: 'https://www.figma.com/developers/api#access-tokens' },
]

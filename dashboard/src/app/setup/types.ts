export type FieldStatus = 'untouched' | 'pending' | 'ok' | 'warning' | 'error'

export type ValidationResult = {
  status: FieldStatus
  message?: string
}

export type ValidationMap = Record<string, ValidationResult>

export type FieldDef = {
  name: string
  label: string
  helpUrl?: string
  helpText?: string
  placeholder?: string
  format?: 'text' | 'url'
  affordance?: 'folder' | 'repo' | 'detect'
  // Small brand mark shown before the label, for fields that map to a service.
  brand?: 'github' | 'claude' | 'anthropic'
}

export type StatusVar = {
  configured: boolean
  visibleValue?: string
  lastFour?: string
  isSecret: boolean
  mirrorMismatch?: boolean
  lastProbe?: { ok: boolean; message: string; ts: number }
}

export type StatusResponse = {
  complete: boolean
  missingRequired: string[]
  vars: Record<string, StatusVar>
}

export type DefaultsResponse = {
  DASHBOARD_URL: string
  REPO_PATH: string
  platform: string
}

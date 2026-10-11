// snagon-dev-mods's $.state contract (session-scoped values).
export type AppendedRules = string[]
export type EditRecord = { file: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'snagon-dev-mods': {
      appendedRules: AppendedRules
      edits: EditRecord[]
      gateChecked: string[]
      gateDenials: number
      notices: string[]
      installNotice: string
    }
  }
}

import { DRAWER_PRESETS } from './quick-actions'

// Built prompts open with the skill preamble; the human's ask follows it
export function taskSummary(prompt: string) {
  return prompt.replace(/^Run the \S+ skill in \S+ mode\.\s*/, '').split('\n')[0]
}

// A task's name in the words it was picked by: the preset's label when it came
// from one, else the first sentence of the ask. /api/tasks cuts prompts to 200
// chars, so a long-enough ask that's a prefix of a preset counts as that preset.
export function taskTitle(prompt: string) {
  const ask = taskSummary(prompt)
  const preset = DRAWER_PRESETS.find(p => ask.startsWith(p.prompt) || (ask.length >= 40 && p.prompt.startsWith(ask)))
  return preset?.label ?? ask.split(/(?<=\.)\s/)[0].replace(/\.$/, '')
}

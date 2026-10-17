// The flow pane (plan v7.1 §2.5, F37): the one module that reads the release code, at draw time and never to keep it.
import { fill } from '../flow/data/templates'
import { paneCode, paneLines } from './flow-owner'
import { session, type FlowHost } from './flow-host'

/** The echo the pane shows (the session's `shown` kind, while it waits) with its approval line; else that nothing waits. */
export async function paneView(h: FlowHost): Promise<{ title: string; lines: string[] }> {
  const s = (await session(h)).value, echo = s.shown ? s.pending[s.shown] : undefined
  return echo ? { title: echo.title, lines: paneLines(h.language, h.address, echo, paneCode()) } : { title: 'flow', lines: [fill(h.language, 'pane.empty', {})] }
}

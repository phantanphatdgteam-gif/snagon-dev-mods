// The TypeScript stack (R2 plan §3.1): its data (flow/data/stacks/typescript.ts) and its code, thin wrappers over the
// modules beside this one (-commands, -sources, -lex, -scan, -red, -tests), which hold the MVP's TypeScript code as it
// was.
import { readReport } from '../../flow/parse'
import { TYPESCRIPT } from '../../flow/data/stacks/typescript'
import type { StackEntry } from './index'
import { authEnvNames, judgedArgv, judgeEnv, npmrcHasAuth, proposeCommands, scriptBody, weakFlags } from './typescript-commands'
import { cacheFiles, cmdSourceVerdict, commandSources, moduleFiles, nodeModulesRebaseBlock, nodeModulesState, resolveSpec, runnerHash } from './typescript-sources'
import { lexLines } from './typescript-lex'
import { CODE, scanFile } from './typescript-scan'
import { redFindings, redShape } from './typescript-red'
import { addedTests, declChanges, evalIdsInTests, importsOf, securityForced } from './typescript-tests'

export const TYPESCRIPT_STACK: StackEntry = {
  data: TYPESCRIPT,
  code: {
    proposeCommands: (manifest, pm, overrides) => proposeCommands(TYPESCRIPT, manifest, pm, overrides),
    weakFlags,
    authEnvNames: names => authEnvNames(names, TYPESCRIPT),
    hasAuth: (_file, text) => npmrcHasAuth(text),
    judgeInput: scriptBody,
    judged: judgedArgv,
    judgeEnv,
    readReport,
    commandSources,
    cmdSourceVerdict: (changed, texts, fFiles, reached, setupChain) => cmdSourceVerdict(changed, texts, fFiles, TYPESCRIPT, reached, setupChain),
    runnerIntegrity: (io, top, _commands, home) => nodeModulesState(io, top, home),
    rebaseBlock: nodeModulesRebaseBlock,
    runnerV1: (io, top, commands) => runnerHash(io, top, [...new Set(commands.map(c => TYPESCRIPT.runnerPackages[c.runner] ?? c.runner))]),
    cacheFiles,
    lex: (path, kept) => (CODE.test(path) ? lexLines(kept) : null),
    // the lexer has no JSX mode: JSX text (`<p>src/*</p>`) could open a comment, so a .jsx/.tsx file is read hunk by hunk
    lexWhole: path => !/\.[jt]sx$/.test(path),
    scanFile,
    redShape,
    redFindings,
    declChanges,
    addedTests,
    importsOf,
    resolveImport: resolveSpec,
    moduleFiles,
    evalIdsInTests,
    securityForced: files => securityForced(files, TYPESCRIPT),
  },
}

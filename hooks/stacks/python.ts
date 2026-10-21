// The Python stack (R2 plan §3.1, §4.2): its data (flow/data/stacks/python.ts) and its code in the modules beside this
// one (-commands, -report, -lex, -scan, -red, -tests, -sources, -runner).
import { PYTHON } from '../../flow/data/stacks/python'
import type { StackEntry } from './index'
import { authEnvNames, configFor, configOptions, hasAuth, judgedArgv, judgeEnv, proposeCommands, urlEnvNames, weakFlags } from './python-commands'
import { readPytestReport } from './python-report'
import { cmdSourceVerdict, commandSources } from './python-sources'
import { baseLibraries, venvRebaseBlock, venvState } from './python-runner'
import { lexLines } from './python-lex'
import { CODE, scanFile } from './python-scan'
import { redFindings, redShape } from './python-red'
import { addedTests, declChanges, evalIdsInTests, importsOf, moduleFiles, resolveImport, securityForced } from './python-tests'

export const PYTHON_STACK: StackEntry = {
  data: PYTHON,
  code: {
    proposeCommands,
    weakFlags,
    authEnvNames: names => authEnvNames(names, PYTHON),
    urlEnvNames,
    hasAuth,
    judgeInput: configFor,
    configOptions,
    judged: judgedArgv,
    judgeEnv,
    readReport: (text, _root, run) => readPytestReport(text, run),
    commandSources,
    cmdSourceVerdict,
    runnerIntegrity: venvState,
    baseLibraries,
    rebaseBlock: venvRebaseBlock,
    // the judge reads no cache in the project: pytest's cache plugin is off, mypy's cache is in the run folder, ruff runs
    // with --no-cache, and bytecode is read and written only under PYTHONPYCACHEPREFIX
    cacheFiles: async () => [],
    lex: (path, kept) => (CODE.test(path) ? lexLines(kept) : null),
    scanFile,
    redShape,
    redFindings,
    declChanges,
    addedTests,
    importsOf,
    resolveImport,
    moduleFiles,
    evalIdsInTests: (io, p, globs) => evalIdsInTests(io, p, globs, PYTHON),
    securityForced: files => securityForced(files, PYTHON),
  },
}

// Barrel re-exports for the `src/pipeline/` module (Phase 40, PIPE-01).
//
// Consumers needing the 4-stage pipeline framework in one import:
//   import { IngestPipeline } from '@fwornle/km-core/pipeline';
//   import type { IngestPipelineOpts, IngestOpts, IngestResult } from '@fwornle/km-core/pipeline';
//
// The sub-path `@fwornle/km-core/pipeline` is wired in package.json `exports`
// (mirrors Phase 38's `./ontology` sub-path precedent). Consumers may also
// reach these symbols through the root barrel (`@fwornle/km-core`) — both
// import paths resolve to the same module.

export { IngestPipeline } from './IngestPipeline.js';
export type {
  IngestPipelineOpts,
  IngestOpts,
  IngestResult,
  PhaseCallback,
  StageName,
  Extractor,
  Synthesizer,
} from './types.js';

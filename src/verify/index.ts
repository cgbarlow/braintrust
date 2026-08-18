export { verifySources } from './sources.js';
export type { ClaimCheck, SentenceVerdict, Verdict, VerifyDeps, VerifyResult } from './sources.js';
export { checkCoverage, measureCoveredFraction, COVERAGE_ASSERTION, COVERAGE_FLOOR } from './coverage.js';
export type { CoverageCheck, CoverageMeasure } from './coverage.js';
export { checkStatementSupport, positionCheckKey, STATEMENT_SUPPORT_ASSERTION } from './support.js';
export type { FailingPosition, StatementSupportDeps, StatementSupportReport } from './support.js';

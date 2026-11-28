import * as A from "../annals/index.js";
import type { RepoInfo, ReviewOptions, ReviewSummary } from "../annals/index.js";
import { asLedger } from "./ledger.js";

export type { ReviewOptions, ReviewSummary } from "../annals/index.js";
export { escapeLiteral, wrapRuns } from "../annals/index.js";
export type { Run } from "../annals/index.js";

export function runReview(repo: RepoInfo, opts: ReviewOptions): Promise<ReviewSummary> {
  return A.runReview(asLedger(repo), opts);
}

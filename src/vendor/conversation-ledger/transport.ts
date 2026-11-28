import * as A from "../annals/index.js";
import type { AnnalsConfig, RepoInfo, TransportSetup } from "../annals/index.js";
import { asLedger } from "./ledger.js";

export { hasAuthorIdentity } from "../annals/index.js";
export type { TransportSetup } from "../annals/index.js";

export function ensureTransport(
  repo: RepoInfo,
  config: AnnalsConfig,
): Promise<TransportSetup | null> {
  return A.ensureTransport(asLedger(repo), config);
}

export function absorbIncoming(repo: RepoInfo): Promise<boolean> {
  return A.absorbIncoming(asLedger(repo));
}

export function ensureMergeConfig(repo: RepoInfo): Promise<void> {
  return A.ensureMergeConfig(asLedger(repo));
}

// MAIN-world entry (document_start). Owner: A.
// Hooks fetch/XHR to capture /api/timedtext URLs (posts AD_TIMEDTEXT_URL) and serves AD_REQ ops
// ('playerResponse' | 'json3' | 'audioTracks' | 'translate') with AD_RES over window.postMessage.
// Runs in the page world: no chrome.* APIs here.
import { BRIDGE_SOURCE, type BridgeMsg } from '../shared/messages';

/** Install the fetch/XHR hooks and the AD_REQ responder once per page. */
export function installHook(): void {
  // TODO A: hook fetch + XMLHttpRequest.prototype.open, answer AD_REQ.
  void BRIDGE_SOURCE;
  void (null as BridgeMsg | null);
}

installHook();

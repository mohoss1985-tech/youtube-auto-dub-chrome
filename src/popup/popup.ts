// Popup controller (§6). Owner: D.
// Supports ?state=<idle|preparing|dubbing|paused-ad|error|not-youtube|loading|empty> for screenshots.

/** Render the popup into `root` and wire settings, status, voices, test voice and keys. */
export async function initPopup(root: HTMLElement): Promise<void> {
  void root;
  // TODO D
}

const root = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (root) void initPopup(root);

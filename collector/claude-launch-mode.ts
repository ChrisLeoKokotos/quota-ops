/**
 * Browser presentation for provider collection (Claude and OpenAI).
 *
 * background: headless on every platform. It creates no window, so it can
 *   never take the foreground, dismiss a menu or receive the user's typing.
 *   Unattended (scheduled) collection only ever uses this mode.
 * visible: an ordinary headed window. Used only when a person asked for it
 *   (tray "Refresh with visible browser...", after a consent dialog) or for
 *   CLI diagnostics. It may take the foreground; the person knows it will.
 *
 * Earlier Windows builds ran a headed browser "minimized/off-screen" in the
 * background. Measured on Windows 11 (Nov 2026): it still took the foreground
 * from the user's active app on every collection, closed open tray menus and
 * routed keystrokes into a window nobody could see. It is not used any more.
 *
 * Neither mode changes the user agent, fingerprint or any browser security
 * setting, and neither opens a DevTools TCP port. Provider verification is
 * never bypassed: a challenged account is reported as needing a person.
 */
export type BrowserPresentation = "background" | "visible";

export interface CollectionLaunchMode {
  headless: boolean;
  args: string[];
}

export function collectionLaunchMode(presentation: BrowserPresentation): CollectionLaunchMode {
  return {
    headless: presentation === "background",
    args: ["--disable-extensions"],
  };
}

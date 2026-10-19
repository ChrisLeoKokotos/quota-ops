/**
 * Select the normal Chromium launch mode for Claude collection.
 *
 * On Windows the account's authenticated Usage page has been observed to
 * produce valid quota responses in headed mode while headless returned
 * claude_page_api_not_observed. Prefer normal headed Chromium for both runs.
 * The non-interactive run is started minimized/offscreen on Windows.
 *
 * This is NOT an authentication or challenge bypass: the same isolated
 * persistent browser profile is used, and login_required/unsupported states
 * continue to fail closed. The browser process is closed by the caller.
 */
export interface ClaudeLaunchMode {
  headless: boolean;
  args: string[];
}

export function claudeLaunchMode(
  platform: NodeJS.Platform,
  visible: boolean,
): ClaudeLaunchMode {
  const args = ["--disable-extensions"];
  if (platform === "win32") {
    if (!visible) {
      args.push(
        "--start-minimized",
        "--window-position=-32000,-32000",
        "--window-size=1280,900",
      );
    }
    return { headless: false, args };
  }
  return { headless: !visible, args };
}

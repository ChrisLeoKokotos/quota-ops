export interface StaticPublicationOptions {
  source: string;
  target: string;
  prepare: (stagingDirectory: string) => Promise<void>;
  /** Test seam for simulated Windows EPERM rename and rollback failures. */
  renamePath?: (from: string, to: string) => Promise<void>;
}

export declare function publishStaticBundle(
  options: StaticPublicationOptions,
): Promise<void>;

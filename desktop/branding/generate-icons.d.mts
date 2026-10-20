export interface DecodedImage {
  width: number;
  height: number;
  rgba: Buffer;
}

export interface BrandingAsset {
  name: string;
  bytes: number;
  sha256: string;
}

export interface BrandingResult {
  source: { path: string; width: number; height: number; sha256: string };
  assets: BrandingAsset[];
  appIconSizes: number[];
  trayIconSizes: number[];
}

export interface IcoFrameInput {
  size: number;
  data: Buffer;
}

export function decodePng(buffer: Buffer): DecodedImage;

export function resize(
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Buffer;

export function cropToContent(
  rgba: Buffer,
  width: number,
  height: number,
  alphaThreshold?: number,
): DecodedImage;

export function encodePng(rgba: Buffer, width: number, height: number): Buffer;

export function encodeIco(frames: IcoFrameInput[]): Buffer;

export function generateBrandingAssets(options?: {
  sourcePath?: string;
  outputDir?: string;
}): Promise<BrandingResult>;

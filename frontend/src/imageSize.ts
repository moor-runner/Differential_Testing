export interface ImageSize { width: number; height: number }

/** Preserve the image ratio and never enlarge a small source image. */
export function fitImageSize(image: ImageSize, available: ImageSize): ImageSize & { scale: number } {
  const scale = Math.min(1, Math.max(1, available.width) / image.width, Math.max(1, available.height) / image.height);
  return { width: image.width * scale, height: image.height * scale, scale };
}

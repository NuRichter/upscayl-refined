/**
 * exiftool-vendored starts a long-lived perl/exiftool process on first use.
 * Load it lazily and close it right after each copy so nothing keeps running
 * while the app sits idle.
 */
export async function copyMetadata(
  originalFile: string,
  outputFile: string,
  opts: { uprightPixels?: boolean } = {},
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ExifTool } = require("exiftool-vendored") as typeof import("exiftool-vendored");
  const et = new ExifTool({ maxProcs: 1, taskTimeoutMillis: 60000 });
  try {
    const args = ["-overwrite_original_in_place", "-tagsFromFile", originalFile];
    // The Refined engine writes upright pixels, so the copied orientation tag must be reset.
    if (opts.uprightPixels) args.push("-Orientation#=1");
    await et.write(outputFile, {}, { writeArgs: args });
  } finally {
    await et.end();
  }
}

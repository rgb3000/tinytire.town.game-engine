const THUMBNAIL_WIDTH = 1000;

export class GameScreenshot {
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async capture(sizes: { name: string; width: number }[]): Promise<Map<string, Blob>> {
    const results = new Map<string, Blob>();

    // Get the source image data from the canvas
    const sourceBlob = await new Promise<Blob>((resolve, reject) => {
      this.canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed to capture canvas'))),
        'image/webp',
        0.85,
      );
    });

    const sourceImg = await createImageBitmap(sourceBlob);

    for (const { name, width } of sizes) {
      if (width >= this.canvas.width) {
        // Full size — use the source blob directly
        results.set(name, sourceBlob);
      } else {
        // Resize via offscreen canvas
        const scale = width / this.canvas.width;
        const height = Math.round(this.canvas.height * scale);
        const offscreen = new OffscreenCanvas(width, height);
        const ctx = offscreen.getContext('2d');
        if (!ctx) throw new Error('Failed to get 2d context');
        ctx.drawImage(sourceImg, 0, 0, width, height);
        const blob = await offscreen.convertToBlob({ type: 'image/webp', quality: 0.85 });
        results.set(name, blob);
      }
    }

    sourceImg.close();
    return results;
  }

  async captureForHighscore(): Promise<{ thumbnail: Blob; full: Blob }> {
    const results = await this.capture([
      { name: 'thumbnail', width: THUMBNAIL_WIDTH },
      { name: 'full', width: this.canvas.width },
    ]);
    return {
      thumbnail: results.get('thumbnail')!,
      full: results.get('full')!,
    };
  }

  static async captureForHighscoreFromBlob(sourceBlob: Blob): Promise<{ thumbnail: Blob; full: Blob }> {
    const sourceImg = await createImageBitmap(sourceBlob);

    // Generate thumbnail
    const scale = THUMBNAIL_WIDTH / sourceImg.width;
    const thumbH = Math.round(sourceImg.height * scale);
    const offscreen = new OffscreenCanvas(THUMBNAIL_WIDTH, thumbH);
    const ctx = offscreen.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2d context');
    ctx.drawImage(sourceImg, 0, 0, THUMBNAIL_WIDTH, thumbH);
    const thumbnail = await offscreen.convertToBlob({ type: 'image/webp', quality: 0.85 });

    sourceImg.close();

    return { thumbnail, full: sourceBlob };
  }
}

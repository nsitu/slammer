// Polyfill for MediaStreamTrackProcessor (from Jan-Ivar)

if (!globalThis.MediaStreamTrackProcessor) {
    globalThis.polyfillingMSTP = true;
    globalThis.MediaStreamTrackProcessor = class MediaStreamTrackProcessor {
        constructor({ track }) {
            if (track.kind === "video") {
                this.readable = new ReadableStream({
                    async start(controller) {
                        this.video = document.createElement("video");
                        this.video.srcObject = new MediaStream([track]);
                        await Promise.all([
                            this.video.play(),
                            new Promise(r => (this.video.onloadedmetadata = r))
                        ]);
                        this.track = track;
                        this.canvas = new OffscreenCanvas(this.video.videoWidth, this.video.videoHeight);
                        this.ctx = this.canvas.getContext("2d", { desynchronized: true });
                        this.t1 = performance.now();
                    },
                    async pull(controller) {
                        while (performance.now() - this.t1 < 1000 / track.getSettings().frameRate) {
                            await new Promise(r => requestAnimationFrame(r));
                        }
                        this.t1 = performance.now();
                        this.ctx.drawImage(this.video, 0, 0);
                        controller.enqueue(new VideoFrame(this.canvas, { timestamp: this.t1 }));
                    }
                });
            }
        }
    };
}


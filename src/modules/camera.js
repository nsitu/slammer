class CameraManager {
  constructor() {
    this.stream = null;
    this.reader = null;
    this.videoWidth = 640;
    this.videoHeight = 480;
    this.currentFacingMode = 'environment';
    this.isStreaming = false;
    this.mstpType = 'unknown'; // Track MSTP implementation type
  }

  async initialize() {
    try {
      console.log('Requesting camera access...');

      // Detect device orientation and adjust constraints
      const isPortrait = window.innerHeight > window.innerWidth;
      const constraints = {
        video: {
          facingMode: this.currentFacingMode,
          // Adaptive resolution based on orientation
          ...(isPortrait ? {
            width: { ideal: 240 },
            height: { ideal: 320 }
          } : {
            width: { ideal: 640 },
            height: { ideal: 480 }
          })
        }
      };

      console.log('Camera constraints:', constraints);

      // Get user media stream
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);

      console.log('Camera access granted, setting up stream processor...');

      // Detect MSTP implementation type
      if (globalThis.polyfillingMSTP === true) {
        this.mstpType = 'polyfill';
        console.log('Using MediaStreamTrackProcessor polyfill');
      } else if (window.MediaStreamTrackProcessor) {
        this.mstpType = 'native';
        console.log('Using native MediaStreamTrackProcessor');
      } else {
        this.mstpType = 'unsupported';
        throw new Error('MediaStreamTrackProcessor not supported in this browser');
      }


      // Get video track and create processor
      const track = this.stream.getVideoTracks()[0];
      const processor = new MediaStreamTrackProcessor({ track });
      this.reader = processor.readable.getReader();

      // Get first frame to determine actual dimensions
      const { value: firstFrame } = await this.reader.read();
      this.videoWidth = firstFrame.displayWidth;
      this.videoHeight = firstFrame.displayHeight;

      console.log(`Camera stream ready: ${this.videoWidth}x${this.videoHeight}`);

      // Close the first frame
      firstFrame.close();

      return {
        width: this.videoWidth,
        height: this.videoHeight,
        facingMode: this.currentFacingMode,
        mstpType: this.mstpType
      };
    } catch (error) {
      console.error('Camera initialization failed:', error);
      throw error;
    }
  }

  async *getFrameStream() {
    this.isStreaming = true;
    let frameCount = 0;
    const targetFPS = 30;
    const frameInterval = Math.floor(30 / targetFPS); // Process every Nth frame

    try {
      while (this.isStreaming) {
        const { done, value: frame } = await this.reader.read();
        if (done) break;

        frameCount++;

        // Process frames at target FPS
        if (frameCount % frameInterval === 0) {
          yield frame;
        } else {
          frame.close();
        }
      }
    } catch (error) {
      console.error('Stream processing error:', error);
    }
  }

  stop() {
    this.isStreaming = false;

    // Stop the stream reader
    if (this.reader) {
      this.reader.releaseLock();
      this.reader = null;
    }

    // Stop video stream
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
  }

  getDimensions() {
    return {
      width: this.videoWidth,
      height: this.videoHeight
    };
  }
}

export { CameraManager }
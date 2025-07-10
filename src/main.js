import './style.css'

import { AlvaAR } from './alva_ar.js';
import { IMU } from './imu.js';

// Polyfill for MediaStreamTrackProcessor (from Jan-Ivar)
if (!globalThis.MediaStreamTrackProcessor) {
  console.log("Polyfilling MediaStreamTrackProcessor");
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

class CameraManager {
  constructor() {
    this.stream = null;
    this.reader = null;
    this.videoWidth = 640;
    this.videoHeight = 480;
    this.currentFacingMode = 'environment';
    this.isStreaming = false;
  }

  async initialize() {
    try {
      console.log('Requesting camera access...');

      // Get user media stream
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: this.videoWidth },
          height: { ideal: this.videoHeight },
          facingMode: this.currentFacingMode
        }
      });

      console.log('Camera access granted, setting up stream processor...');

      // Check if MediaStreamTrackProcessor is supported
      if (!window.MediaStreamTrackProcessor) {
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
        facingMode: this.currentFacingMode
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

const video = document.getElementById('cam');
const canvas = document.getElementById('src');
const ctx = canvas.getContext('2d');
const svg = document.getElementById('route');
let polyline;                 // <polyline> element
const pts = [];               // 2-D points we collect (as {x, z} objects)
let imu;                      // IMU instance
let cameraManager;            // Camera manager instance

// 1. Initialize camera and IMU -----------------------------------------------
async function initialize() {
  try {
    // Initialize camera manager
    cameraManager = new CameraManager();
    const cameraInfo = await cameraManager.initialize();

    // Set canvas dimensions based on actual camera resolution
    canvas.width = cameraInfo.width;
    canvas.height = cameraInfo.height;

    // Initialize IMU
    try {
      imu = await IMU.Initialize();
      console.log('IMU initialized successfully');
    } catch (error) {
      console.warn('IMU not available:', error);
      imu = null;
    }

    // Initialize SLAM
    const slam = await AlvaAR.Initialize(cameraInfo.width, cameraInfo.height);

    // Start processing
    await processFrames(slam);

  } catch (error) {
    console.error('Initialization failed:', error);
  }
}

// 2. Process camera frames ---------------------------------------------------
async function processFrames(slam) {
  for await (const frame of cameraManager.getFrameStream()) {
    try {
      // Draw frame to canvas for visualization (optional)
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);

      // Get ImageData for SLAM processing
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // Use IMU data if available, otherwise fall back to SLAM-only
      let pose;
      if (imu) {
        pose = slam.findCameraPoseWithIMU(imageData, imu.orientation, imu.motion);
      } else {
        pose = slam.Tick(imageData.data.buffer);
      }

      if (pose) {
        updatePath(pose);
      } else {
        // When tracking is lost, visualize feature points for debugging
        const dots = slam.getFramePoints && slam.getFramePoints();
        if (dots) {
          for (const p of dots) {
            ctx.fillStyle = 'white';
            ctx.fillRect(p.x, p.y, 2, 2);
          }
        }
      }

      // Close the frame to free memory
      frame.close();

    } catch (error) {
      console.error('Frame processing error:', error);
      frame.close();
    }
  }
}

// 3. Update path visualization -----------------------------------------------
function updatePath(pose) {
  // pose[12], pose[13], pose[14] = X,Y,Z translation (OV²SLAM / ORB conv.)
  const x = pose[12];
  const z = -pose[14];      // flip Z so forward = upward in SVG
  pts.push({ x, z }); // Store as objects for easier manipulation

  // Calculate bounding box of all points
  const minX = Math.min(...pts.map(p => p.x));
  const maxX = Math.max(...pts.map(p => p.x));
  const minZ = Math.min(...pts.map(p => p.z));
  const maxZ = Math.max(...pts.map(p => p.z));

  // Add padding around the path
  const padding = Math.max(0.1, Math.max(maxX - minX, maxZ - minZ) * 0.1);
  const viewBoxX = minX - padding;
  const viewBoxY = minZ - padding;
  const viewBoxWidth = maxX - minX + 2 * padding;
  const viewBoxHeight = maxZ - minZ + 2 * padding;

  // Update SVG viewBox to fit all points
  svg.setAttribute('viewBox', `${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}`);

  // Calculate responsive stroke width based on viewBox size
  const viewBoxDiagonal = Math.sqrt(viewBoxWidth * viewBoxWidth + viewBoxHeight * viewBoxHeight);
  const strokeWidth = Math.max(0.005, viewBoxDiagonal * 0.003); // 0.3% of diagonal, min 0.005

  if (!polyline) {
    polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', '#0f0');
    svg.appendChild(polyline);
  }

  // Update stroke width dynamically
  polyline.setAttribute('stroke-width', strokeWidth.toString());

  // Convert points back to string format for polyline
  polyline.setAttribute('points', pts.map(p => `${p.x},${p.z}`).join(' '));
}

// Start the application
initialize();

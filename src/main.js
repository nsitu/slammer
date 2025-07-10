import './modules/polyfillMSTP.js';
import './style.css'

import { AlvaAR } from './alva_ar.js';
import { IMU } from './imu.js';
import { Stats } from './stats.js';


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

    // No need to set canvas dimensions anymore

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

    // Initialize Stats tracking
    Stats.add('total');
    Stats.add('frame');
    Stats.add('slam');
    Stats.add('path');

    // Add stats display to the page
    document.body.appendChild(Stats.el);

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
      // Start overall timing
      Stats.next();
      Stats.start('total');

      // Time frame extraction
      Stats.start('frame');
      const imageData = await extractImageDataFromFrame(frame);
      Stats.stop('frame');

      // Time SLAM processing
      Stats.start('slam');
      let pose;
      if (imu) {
        pose = slam.findCameraPoseWithIMU(imageData, imu.orientation, imu.motion);
      } else {
        pose = slam.findCameraPose(imageData);
      }
      Stats.stop('slam');

      // Time path updates
      if (pose) {
        Stats.start('path');
        updatePath(pose);
        Stats.stop('path');
      }

      // Close the frame to free memory
      frame.close();

      // Complete timing and render stats
      Stats.stop('total');
      Stats.render();

    } catch (error) {
      console.error('Frame processing error:', error);
      frame.close();
      Stats.stop('total');
      Stats.render();
    }
  }
}

// Helper function to extract ImageData directly from VideoFrame using copyTo()
async function extractImageDataFromFrame(frame) {
  // Calculate buffer size for RGBA format (4 bytes per pixel)
  const bufferSize = frame.displayWidth * frame.displayHeight * 4;

  // Create buffer and copy VideoFrame data directly using copyTo()
  const buffer = new Uint8Array(bufferSize);

  try {
    // Copy VideoFrame to buffer with RGBA format
    await frame.copyTo(buffer, {
      format: "RGBA",
      colorSpace: "srgb"
    });
    // Create ImageData-like object that AlvaAR expects
    return {
      data: buffer,
      width: frame.displayWidth,
      height: frame.displayHeight
    };

  } catch (copyError) {
    console.error('VideoFrame.copyTo() failed:', copyError);
    // console.log('Falling back to OffscreenCanvas method...');
    // const offscreenCanvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
    // const ctx = offscreenCanvas.getContext('2d');
    // ctx.drawImage(frame, 0, 0);
    // return ctx.getImageData(0, 0, frame.displayWidth, frame.displayHeight);
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

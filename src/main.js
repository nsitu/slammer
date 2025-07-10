import './modules/polyfillMSTP.js';
import './style.css'

import { AlvaAR } from './modules/alva_ar.js';
import { IMU } from './modules/imu.js';
import { Stats } from './modules/stats.js';
import { isMobile, isIOS } from './modules/utils.js';
import { CameraManager } from './modules/camera.js';


const svg = document.getElementById('route');
let polyline;                 // <polyline> element
const pts = [];               // 2-D points we collect (as {x, z} objects)
let imu;                      // IMU instance
let cameraManager;            // Camera manager instance
let permissionGranted = false;
let startButton = null;

// 1. Initialize camera and IMU -----------------------------------------------
async function initialize() {
  try {
    console.log('Initializing camera manager...');
    cameraManager = new CameraManager();
    const cameraInfo = await cameraManager.initialize();

    console.log('Initializing IMU...');
    // Initialize IMU with permission check
    try {
      if (!permissionGranted && isIOS()) {
        console.log('IMU permission not granted yet');
        imu = null;
      } else {
        imu = await IMU.Initialize();
        console.log('IMU initialized successfully');
      }
    } catch (error) {
      console.warn('IMU initialization failed:', error);
      imu = null;
    }

    console.log(`Initializing SLAM... with width ${cameraInfo.width}, height ${cameraInfo.height}`);
    const slam = await AlvaAR.Initialize(cameraInfo.width, cameraInfo.height);


    // Initialize Stats tracking
    Stats.add('total');
    Stats.add('frame');
    Stats.add('slam');
    Stats.add('path');

    // Add device info to stats (if your Stats library supports it)
    const deviceInfo = `${cameraInfo.width}x${cameraInfo.height} | MSTP: ${cameraInfo.mstpType} | IMU: ${imu ? 'enabled' : 'disabled'}`;
    console.log('Device Info:', deviceInfo);

    // Add stats display to the page
    document.body.appendChild(Stats.el);

    console.log('Starting frame processing...');
    await processFrames(slam, deviceInfo);

  } catch (error) {
    console.error('Initialization failed:', error);
  }
}

// 2. Process camera frames ---------------------------------------------------
async function processFrames(slam, deviceInfo) {
  let frameProcessedCount = 0;
  let poseFoundCount = 0;
  let nonZeroPoseCount = 0;

  for await (const frame of cameraManager.getFrameStream()) {
    try {
      frameProcessedCount++;

      // Start overall timing
      Stats.next();
      Stats.start('total');

      // Time frame extraction
      Stats.start('frame');
      const imageData = await extractImageDataFromFrame(frame);
      Stats.stop('frame');

      // Add debugging for first few frames
      if (frameProcessedCount <= 3) {
        console.log(`Frame ${frameProcessedCount} - ImageData:`, {
          width: imageData.width,
          height: imageData.height,
          dataLength: imageData.data.length,
          expectedLength: imageData.width * imageData.height * 4,
          firstPixels: Array.from(imageData.data.slice(0, 12))
        });
      }

      // Time SLAM processing
      Stats.start('slam');
      let pose;
      if (imu) {
        pose = slam.findCameraPoseWithIMU(imageData, imu.orientation, imu.motion);
      } else {
        pose = slam.findCameraPose(imageData);
      }
      Stats.stop('slam');

      // Debug pose results
      if (pose) {
        poseFoundCount++;
        const hasMovement = pose[12] !== 0 || pose[13] !== 0 || pose[14] !== 0;

        if (hasMovement) {
          nonZeroPoseCount++;
          console.log(`Movement detected! (${nonZeroPoseCount}/${frameProcessedCount})`, {
            translation: [pose[12].toFixed(3), pose[13].toFixed(3), pose[14].toFixed(3)]
          });
        }

        if (frameProcessedCount <= 10 || frameProcessedCount % 30 === 0) {
          console.log(`Pose ${poseFoundCount}/${frameProcessedCount}: [${pose[12].toFixed(3)}, ${pose[13].toFixed(3)}, ${pose[14].toFixed(3)}] - Movement: ${hasMovement}`);
        }

        Stats.start('path');
        updatePath(pose);
        Stats.stop('path');
      } else {
        if (frameProcessedCount % 30 === 0) {
          console.log(`No pose found - Frame ${frameProcessedCount}, found ${poseFoundCount} poses, ${nonZeroPoseCount} with movement`);
        }
      }

      // Remove the Stats.setInfo call (doesn't exist) and just update the display
      // The deviceInfo should be set once during initialization
      Stats.stop('total');
      Stats.render();

      frame.close();

    } catch (error) {
      console.error('Frame processing error:', error);
      frame.close();
    }
  }
}

// Update the extractImageDataFromFrame function with debugging
async function extractImageDataFromFrame(frame) {
  try {
    // Calculate buffer size for RGBA format
    const expectedBufferSize = frame.displayWidth * frame.displayHeight * 4;
    const buffer = new Uint8Array(expectedBufferSize);

    // Copy VideoFrame to buffer with RGBA format
    await frame.copyTo(buffer, {
      format: "RGBA",
      colorSpace: "srgb"
    });

    // Create ImageData-like object
    const imageData = {
      data: buffer,
      width: frame.displayWidth,
      height: frame.displayHeight
    };

    // Debug: Check if image data looks valid
    const nonZeroPixels = buffer.filter(val => val > 0).length;
    const averageValue = buffer.reduce((sum, val) => sum + val, 0) / buffer.length;

    if (frameDebugCount < 3) {
      console.log(`ImageData validation:`, {
        bufferSize: buffer.length,
        expectedSize: expectedBufferSize,
        nonZeroPixels: nonZeroPixels,
        averagePixelValue: averageValue.toFixed(2),
        isBlank: averageValue < 10
      });
      frameDebugCount++;
    }

    return imageData;

  } catch (error) {
    console.error('Failed to extract image data from VideoFrame:', error);
    throw error;
  }
}

let frameDebugCount = 0; // Add this at module level

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

// iOS Permission handling and startup
function createStartButton() {
  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'overlay';

  // Create start button
  startButton = document.createElement('button');
  startButton.id = 'start-button';
  startButton.textContent = 'Start Tracking';

  // Create instruction text
  const instructions = document.createElement('div');
  instructions.id = 'instructions';

  if (isIOS()) {
    instructions.innerHTML = 'Please allow access to<br>camera and motion sensors';
  } else {
    instructions.innerHTML = 'Please allow camera access';
  }

  overlay.appendChild(startButton);
  overlay.appendChild(instructions);
  document.body.appendChild(overlay);

  // Handle button click
  startButton.addEventListener('click', async () => {
    try {
      // Request IMU permission on iOS
      if (isIOS() && typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        console.log('Requesting iOS motion permission...');
        const motionPermission = await DeviceMotionEvent.requestPermission();

        if (motionPermission !== 'granted') {
          throw new Error('Motion permission denied');
        }

        console.log('iOS motion permission granted');
      }

      // Request orientation permission on iOS if available
      if (isIOS() && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        console.log('Requesting iOS orientation permission...');
        const orientationPermission = await DeviceOrientationEvent.requestPermission();

        if (orientationPermission !== 'granted') {
          console.log('Orientation permission denied, continuing without...');
        } else {
          console.log('iOS orientation permission granted');
        }
      }

      permissionGranted = true;
      overlay.remove();

      // Now initialize the app
      await initialize();

    } catch (error) {
      console.error('Permission request failed:', error);
      alert(`Error: ${error.message}`);
    }
  });

  return overlay;
}

// App startup
document.addEventListener('DOMContentLoaded', () => {
  createStartButton();
});

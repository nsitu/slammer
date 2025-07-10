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

    console.log('Initializing SLAM...');
    const slam = await AlvaAR.Initialize(cameraInfo.width, cameraInfo.height);

    // Initialize Stats tracking
    Stats.add('total');
    Stats.add('frame');
    Stats.add('slam');
    Stats.add('path');

    // Add camera and IMU info to stats display
    const deviceInfo = `${cameraInfo.width}x${cameraInfo.height} | MSTP: ${cameraInfo.mstpType} | IMU: ${imu ? 'enabled' : 'disabled'}`;

    // Add stats display to the page
    document.body.appendChild(Stats.el);

    console.log('Starting frame processing...');
    // Start processing - pass the device info for display
    await processFrames(slam, deviceInfo);

  } catch (error) {
    console.error('Initialization failed:', error);
  }
}

// 2. Process camera frames ---------------------------------------------------
async function processFrames(slam, deviceInfo) {

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

      // Complete timing and render stats with device info
      Stats.stop('total');
      Stats.render(deviceInfo);

    } catch (error) {
      console.error('Frame processing error:', error);
      frame.close();
      Stats.stop('total');
      Stats.render(deviceInfo);
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

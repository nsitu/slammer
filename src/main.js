import './modules/polyfillMSTP.js';
import './style.css'
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { AlvaAR } from './modules/alva_ar.js';
import { AlvaARConnectorTHREE } from './modules/alva_ar_three.js';

import { IMU } from './modules/imu.js';
import { Stats } from './modules/stats.js';
import { isMobile, isIOS } from './modules/utils.js';
import { CameraManager } from './modules/camera.js';


const svg = document.getElementById('route');
let polyline;                 // <polyline> element
const pts = [];               // Now stores THREE.Vector3 objects instead of {x, z}
const markerPts = [];         // Array to store marker positions for connecting lines
const markerMeshes = [];      // Array to store marker mesh objects for cleanup
let imu;                      // IMU instance
let cameraManager;            // Camera manager instance
let permissionGranted = false;
let startButton = null;
let debugMode = false;        // Toggle for orbit controls vs AR mode

// Add this function before initialize()
function initializeThreeJS(width, height) {
  // Create scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // Create camera with AR-appropriate settings
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.01, 1000);

  // Create or get canvas element
  let canvas = document.getElementById('three-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'three-canvas';
    canvas.style.cssText = 'position: absolute; top: 0; left: 0; z-index: 1; width: 100%; height: 100%;';
    document.body.appendChild(canvas);
  }

  // Get actual viewport dimensions
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Create renderer
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    alpha: true
  });

  // Set renderer size to fill viewport, not camera resolution
  renderer.setSize(viewportWidth, viewportHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  // Update camera aspect ratio to match viewport
  camera.aspect = viewportWidth / viewportHeight;
  camera.updateProjectionMatrix();

  // Initialize pose application function
  const applyPose = AlvaARConnectorTHREE.Initialize(THREE);

  // Create line geometry for path visualization
  const pathGeometry = new THREE.BufferGeometry();
  const pathMaterial = new THREE.LineBasicMaterial({
    color: 0x00ff00,
    linewidth: 3
  });
  const pathLine = new THREE.Line(pathGeometry, pathMaterial);
  scene.add(pathLine);

  // Add some basic lighting
  const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(1, 1, 1);
  scene.add(directionalLight);

  // Add orbit controls for debugging (optional)
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.enableZoom = true;
  controls.enablePan = true;
  controls.enableRotate = true;

  // Set initial camera position for better view in debug mode
  camera.position.set(0, 2, 5);
  controls.target.set(0, 0, 0);
  controls.update();

  // Create group for marker connections (cylinders)
  const markerConnections = new THREE.Group();
  scene.add(markerConnections);

  // Handle window resize
  function handleResize() {
    const newWidth = window.innerWidth;
    const newHeight = window.innerHeight;

    // Update camera aspect ratio
    camera.aspect = newWidth / newHeight;
    camera.updateProjectionMatrix();

    // Update renderer size
    renderer.setSize(newWidth, newHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
  }

  // Add resize event listener
  window.addEventListener('resize', handleResize);

  // Also handle orientation change for mobile devices
  window.addEventListener('orientationchange', () => {
    // Small delay to ensure the viewport dimensions have updated
    setTimeout(handleResize, 100);
  });

  return { scene, camera, renderer, applyPose, pathLine, controls, markerConnections };
}

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

    // Initialize Three.js scene
    const { scene, camera, renderer, applyPose, pathLine, controls, markerConnections } = initializeThreeJS(cameraInfo.width, cameraInfo.height);

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
    await processFrames(slam, { scene, camera, renderer, applyPose, pathLine, controls, markerConnections }, deviceInfo);

  } catch (error) {
    console.error('Initialization failed:', error);
  }
}

// 2. Process camera frames ---------------------------------------------------
async function processFrames(slam, threeJsObjects, deviceInfo) {
  const { scene, camera, renderer, applyPose, pathLine, controls, markerConnections } = threeJsObjects;
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
        // Apply pose to camera for AR view (only if not in debug mode)
        if (!debugMode) {
          applyPose(pose, camera.quaternion, camera.position);
        }

        // Update 3D path
        updatePath(pose, pathLine, scene, markerConnections);

        // Render the scene
        if (debugMode) {
          controls.update(); // Update orbit controls only in debug mode
        }
        renderer.render(scene, camera);
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
function updatePath(pose, pathLine, scene, markerConnections) {
  // Extract position from pose matrix
  const x = pose[12];
  const y = pose[13];
  const z = pose[14];

  pts.push(new THREE.Vector3(x, y, z));

  // Limit the number of points for performance
  const maxPoints = 1000;
  if (pts.length > maxPoints) {
    pts.shift(); // Remove oldest point
  }

  // Dispose of old geometry and create new one to avoid buffer size warnings
  pathLine.geometry.dispose();
  pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);

  // Optional: Add markers at regular intervals
  if (pts.length % 10 === 0) {
    const markerPos = new THREE.Vector3(x, y, z);
    markerPts.push(markerPos);

    // Limit marker points to prevent excessive memory usage
    const maxMarkers = 100;
    if (markerPts.length > maxMarkers) {
      markerPts.shift(); // Remove oldest marker point

      // Also remove the corresponding mesh from scene and dispose of it
      if (markerMeshes.length > 0) {
        const oldMarker = markerMeshes.shift();
        scene.remove(oldMarker);
        oldMarker.geometry.dispose();
        oldMarker.material.dispose();
      }
    }

    const markerMesh = addPathMarker(scene, markerPos);
    markerMeshes.push(markerMesh);

    // Update marker connections with cylinders
    updateMarkerConnections(markerConnections);
  }
}

// Create 3D cylinder to connect two points
function createConnectionCylinder(startPos, endPos) {
  const distance = startPos.distanceTo(endPos);
  const cylinderGeometry = new THREE.CylinderGeometry(0.005, 0.005, distance, 8); // Radius 0.005, 8 segments
  const cylinderMaterial = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    transparent: true,
    opacity: 0.8
  });
  const cylinder = new THREE.Mesh(cylinderGeometry, cylinderMaterial);

  // Position cylinder at midpoint between start and end
  const midPoint = new THREE.Vector3().addVectors(startPos, endPos).multiplyScalar(0.5);
  cylinder.position.copy(midPoint);

  // Orient cylinder to point from start to end
  const direction = new THREE.Vector3().subVectors(endPos, startPos).normalize();
  const up = new THREE.Vector3(0, 1, 0);

  // If direction is parallel to up vector, use a different reference
  if (Math.abs(direction.dot(up)) > 0.99) {
    up.set(1, 0, 0);
  }

  cylinder.lookAt(endPos);
  cylinder.rotateX(Math.PI / 2); // Adjust for cylinder's default orientation

  return cylinder;
}

// Update marker connections with 3D cylinders
function updateMarkerConnections(markerConnections) {
  // Clear existing connections
  while (markerConnections.children.length > 0) {
    const child = markerConnections.children[0];
    markerConnections.remove(child);
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  }

  // Create new connections between consecutive markers
  for (let i = 0; i < markerPts.length - 1; i++) {
    const startPos = markerPts[i];
    const endPos = markerPts[i + 1];

    const connectionCylinder = createConnectionCylinder(startPos, endPos);
    markerConnections.add(connectionCylinder);
  }
}

// Optional: Add visual markers along the path
function addPathMarker(scene, position) {
  const markerGeometry = new THREE.SphereGeometry(0.02, 12, 12); // Larger sphere: radius 0.02, more segments for smoother appearance
  const markerMaterial = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    transparent: true,
    opacity: 0.9
  });
  const marker = new THREE.Mesh(markerGeometry, markerMaterial);
  marker.position.copy(position);
  scene.add(marker);
  return marker; // Return the mesh for tracking
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

// Add keyboard controls for debug mode
document.addEventListener('keydown', (event) => {
  if (event.key === 'd' || event.key === 'D') {
    debugMode = !debugMode;
    console.log('Debug mode:', debugMode ? 'ON (OrbitControls enabled)' : 'OFF (AR tracking)');

    // Show/hide debug info
    const debugInfo = document.getElementById('debug-info');
    if (!debugInfo) {
      const info = document.createElement('div');
      info.id = 'debug-info';
      info.style.cssText = `
        position: fixed; 
        top: 10px; 
        right: 10px; 
        background: rgba(0,0,0,0.8); 
        color: white; 
        padding: 10px; 
        border-radius: 5px;
        font-family: monospace;
        z-index: 1000;
      `;
      document.body.appendChild(info);
    }

    const info = document.getElementById('debug-info');
    info.style.display = debugMode ? 'block' : 'none';
    info.innerHTML = `
      Debug Mode: ${debugMode ? 'ON' : 'OFF'}<br>
      Press 'D' to toggle<br>
      ${debugMode ? 'OrbitControls: Active<br>AR Tracking: Disabled' : 'OrbitControls: Disabled<br>AR Tracking: Active'}
    `;
  }
});

// App startup
document.addEventListener('DOMContentLoaded', () => {
  createStartButton();
});

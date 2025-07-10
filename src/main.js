import './style.css'

import { AlvaAR } from './alva_ar.js';
import { IMU } from './imu.js';

const video = document.getElementById('cam');
const canvas = document.getElementById('src');
const ctx = canvas.getContext('2d');
const svg = document.getElementById('route');
let polyline;                 // <polyline> element
const pts = [];               // 2-D points we collect (as {x, z} objects)
let imu;                      // IMU instance

// 1. grab camera stream ------------------------------------------------------
const stream = await navigator.mediaDevices.getUserMedia({
  video: { facingMode: 'environment', width: 640, height: 480 }
});
video.srcObject = stream;

await video.play();           // wait for metadata
canvas.width = video.videoWidth;
canvas.height = video.videoHeight;

// 2. init IMU ----------------------------------------------------------------
try {
  imu = await IMU.Initialize();
  console.log('IMU initialized successfully');
} catch (error) {
  console.warn('IMU not available:', error);
  imu = null;
}

// 3. init SLAM ---------------------------------------------------------------
const slam = await AlvaAR.Initialize(canvas.width, canvas.height);

// 4. render loop -------------------------------------------------------------
function tick() {
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // Use IMU data if available, otherwise fall back to SLAM-only
  let pose;
  if (imu) {
    pose = slam.findCameraPoseWithIMU(img, imu.orientation, imu.motion);
  } else {
    pose = slam.Tick(img.data.buffer);   // fallback to SLAM-only
  }

  if (pose) {
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
    const viewBoxHeight = maxZ - minZ + 2 * padding;    // Update SVG viewBox to fit all points
    svg.setAttribute('viewBox', `${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}`);

    // Calculate responsive stroke width based on viewBox size
    // This ensures the line maintains visual consistency as the view scales
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
  } else {
    // When tracking is lost, we could visualize feature points for debugging
    // Similar to how imu.html shows dots when pose is lost
    const dots = slam.getFramePoints && slam.getFramePoints();
    if (dots) {
      for (const p of dots) {
        ctx.fillStyle = 'white';
        ctx.fillRect(p.x, p.y, 2, 2);
      }
    }
  }

  requestAnimationFrame(tick);
}
tick();

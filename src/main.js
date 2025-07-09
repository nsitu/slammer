import './style.css'

import { AlvaAR } from './alva_ar.js';

const video = document.getElementById('cam');
const canvas = document.getElementById('src');
const ctx = canvas.getContext('2d');
const svg = document.getElementById('route');
let polyline;                 // <polyline> element
const pts = [];               // 2-D points we collect

// 1. grab camera stream ------------------------------------------------------
const stream = await navigator.mediaDevices.getUserMedia({
  video: { facingMode: 'environment', width: 640, height: 480 }
});
video.srcObject = stream;

await video.play();           // wait for metadata
canvas.width = video.videoWidth;
canvas.height = video.videoHeight;

// 2. init SLAM ---------------------------------------------------------------
const slam = await AlvaAR.Initialize(canvas.width, canvas.height);

// 3. render loop -------------------------------------------------------------
function tick() {
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pose = slam.Tick(img.data.buffer);   // 4×4 column-major float32

  if (pose) {
    // pose[12], pose[13], pose[14] = X,Y,Z translation (OV²SLAM / ORB conv.)
    const x = pose[12];
    const z = -pose[14];      // flip Z so forward = upward in SVG
    pts.push(`${x},${z}`);

    if (!polyline) {
      polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      polyline.setAttribute('fill', 'none');
      polyline.setAttribute('stroke', '#0f0');
      polyline.setAttribute('stroke-width', '0.02');
      svg.appendChild(polyline);
    }
    polyline.setAttribute('points', pts.join(' '));
  }

  requestAnimationFrame(tick);
}
tick();

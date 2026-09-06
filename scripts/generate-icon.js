// scripts/generate-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      offscreen: true
    }
  });

  const svgHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          width: 1024px;
          height: 1024px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
        }
        svg {
          width: 1024px;
          height: 1024px;
        }
      </style>
    </head>
    <body>
      <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#0F172A" />
            <stop offset="50%" stop-color="#1E293B" />
            <stop offset="100%" stop-color="#090D16" />
          </linearGradient>

          <linearGradient id="glowGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#38BDF8" />
            <stop offset="50%" stop-color="#2563EB" />
            <stop offset="100%" stop-color="#7C3AED" />
          </linearGradient>

          <linearGradient id="boltGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#38BDF8" />
            <stop offset="50%" stop-color="#06B6D4" />
            <stop offset="100%" stop-color="#10B981" />
          </linearGradient>

          <filter id="neonGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="16" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <filter id="dropShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="24" stdDeviation="32" flood-color="#000000" flood-opacity="0.55" />
          </filter>
        </defs>

        <!-- macOS Big Sur Squircle Base -->
        <rect x="96" y="96" width="832" height="832" rx="196" fill="url(#bgGrad)" filter="url(#dropShadow)" />
        
        <!-- Subtle Inner Border -->
        <rect x="96" y="96" width="832" height="832" rx="196" fill="none" stroke="url(#glowGrad)" stroke-width="8" opacity="0.65" />

        <!-- Swarm Circle Orbit Accent -->
        <circle cx="512" cy="512" r="280" fill="none" stroke="url(#glowGrad)" stroke-width="6" stroke-dasharray="24 16" opacity="0.45" />

        <!-- Orbiting Swarm Nodes -->
        <circle cx="512" cy="232" r="18" fill="#38BDF8" filter="url(#neonGlow)" />
        <circle cx="792" cy="512" r="14" fill="#818CF8" filter="url(#neonGlow)" />
        <circle cx="512" cy="792" r="20" fill="#06B6D4" filter="url(#neonGlow)" />
        <circle cx="232" cy="512" r="14" fill="#3B82F6" filter="url(#neonGlow)" />

        <!-- Modern High-Tech Lightning Bolt / Torrent Symbol -->
        <path d="M560 260 L360 520 L480 520 L440 764 L664 480 L532 480 Z" 
              fill="url(#boltGrad)" 
              filter="url(#neonGlow)" />

        <!-- Center Core Glow -->
        <path d="M540 320 L400 500 L490 500 L460 700 L620 480 L520 480 Z" 
              fill="#FFFFFF" 
              opacity="0.35" />
      </svg>
    </body>
    </html>
  `;

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(svgHtml));
  
  // Allow rendering to settle
  await new Promise(resolve => setTimeout(resolve, 500));

  const image = await win.capturePage();
  const buildDir = path.join(__dirname, '..', 'build');
  if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
  }

  const pngPath = path.join(buildDir, 'icon.png');
  fs.writeFileSync(pngPath, image.toPNG());
  console.log(`Generated ${pngPath} (${image.getSize().width}x${image.getSize().height})`);

  // Create icon.iconset and icon.icns for macOS
  const iconsetDir = path.join(buildDir, 'icon.iconset');
  if (fs.existsSync(iconsetDir)) {
    fs.rmSync(iconsetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(iconsetDir, { recursive: true });

  const sizes = [16, 32, 64, 128, 256, 512];
  for (const s of sizes) {
    execSync(`sips -z ${s} ${s} "${pngPath}" --out "${path.join(iconsetDir, `icon_${s}x${s}.png`)}" > /dev/null 2>&1`);
    execSync(`sips -z ${s * 2} ${s * 2} "${pngPath}" --out "${path.join(iconsetDir, `icon_${s}x${s}@2x.png`)}" > /dev/null 2>&1`);
  }

  const icnsPath = path.join(buildDir, 'icon.icns');
  try {
    execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`);
    console.log(`Generated ${icnsPath}`);
    fs.rmSync(iconsetDir, { recursive: true, force: true });
  } catch (err) {
    console.error('iconutil error:', err.message);
  }

  app.quit();
});

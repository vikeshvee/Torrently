const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execSync } = require('child_process');

class CliInstaller {
  constructor() {
    this.commandName = 'torrently';
  }

  /**
   * Determine available installation directories in PATH order.
   */
  getCandidateDirs() {
    if (process.env.TORRENTLY_TEST_SANDBOX === '1' || process.env.NODE_ENV === 'test') {
      const sandboxBin = path.join(os.homedir(), 'bin');
      try { fs.mkdirSync(sandboxBin, { recursive: true }); } catch (e) {}
      return [sandboxBin];
    }

    const candidates = [];

    // 1. macOS Homebrew standard on Apple Silicon
    if (process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin')) {
      candidates.push('/opt/homebrew/bin');
    }

    // 2. Standard Unix / Intel Mac user bin
    if (fs.existsSync('/usr/local/bin')) {
      candidates.push('/usr/local/bin');
    }

    // 3. User local bin (~/.local/bin)
    const userLocalBin = path.join(os.homedir(), '.local', 'bin');
    candidates.push(userLocalBin);

    // 4. User bin (~/bin)
    const userBin = path.join(os.homedir(), 'bin');
    candidates.push(userBin);

    return candidates;
  }

  /**
   * Check if a directory is writable.
   */
  isWritable(dirPath) {
    if (!fs.existsSync(dirPath)) {
      try {
        fs.mkdirSync(dirPath, { recursive: true });
      } catch (e) {
        return false;
      }
    }
    try {
      fs.accessSync(dirPath, fs.constants.W_OK);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get the primary target directory where we can install without root.
   */
  getTargetDir() {
    const candidateDirs = this.getCandidateDirs();
    for (const dir of candidateDirs) {
      if (this.isWritable(dir)) {
        return dir;
      }
    }
    // Fallback to ~/.local/bin
    const fallback = path.join(os.homedir(), '.local', 'bin');
    if (!fs.existsSync(fallback)) {
      try { fs.mkdirSync(fallback, { recursive: true }); } catch (e) {}
    }
    return fallback;
  }

  /**
   * Detect where the installed torrently binary currently exists.
   */
  findInstalledPath() {
    const candidateDirs = this.getCandidateDirs();
    for (const dir of candidateDirs) {
      const fullPath = path.join(dir, this.commandName);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }

    if (process.env.TORRENTLY_TEST_SANDBOX === '1' || process.env.NODE_ENV === 'test') {
      return null;
    }

    // Check system `which torrently`
    try {
      const which = execSync(`which ${this.commandName} 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (which && fs.existsSync(which)) {
        return which;
      }
    } catch (e) {}

    return null;
  }

  /**
   * Generates the bash wrapper script content for 'torrently'.
   * Uses ELECTRON_RUN_AS_NODE with the packaged application binary if present,
   * or falls back to system node pointing to the project CLI script.
   */
  generateWrapperScript() {
    const devScriptPath = path.resolve(__dirname, '../../bin/torrently');
    const macAppPath = '/Applications/Torrently.app';

    return `#!/bin/bash
# Torrently CLI Launcher
# Generated automatically by Torrently

# Check for packaged Torrently.app first
if [ -d "${macAppPath}" ]; then
  APP_BIN="${macAppPath}/Contents/MacOS/Torrently"
  APP_CLI="${macAppPath}/Contents/Resources/app/src/cli.js"
  APP_CLI_ASAR="${macAppPath}/Contents/Resources/app.asar/src/cli.js"

  if [ -f "$APP_CLI" ]; then
    ELECTRON_RUN_AS_NODE=1 "$APP_BIN" "$APP_CLI" "$@"
    exit $?
  elif [ -f "$APP_CLI_ASAR" ]; then
    ELECTRON_RUN_AS_NODE=1 "$APP_BIN" "$APP_CLI_ASAR" "$@"
    exit $?
  fi
fi

# Fallback to dev repository script or system node
if [ -f "${devScriptPath}" ]; then
  if command -v node >/dev/null 2>&1; then
    exec node "${devScriptPath}" "$@"
  else
    exec "${devScriptPath}" "$@"
  fi
fi

# Fallback search in npm or electron
if command -v node >/dev/null 2>&1; then
  echo "Torrently application not found at /Applications/Torrently.app or ${devScriptPath}" >&2
  exit 1
fi

echo "Error: Neither Node.js nor Torrently.app was found to execute 'torrently'." >&2
exit 1
`;
  }

  /**
   * Ensures ~/.zshrc or ~/.bash_profile has ~/.local/bin in PATH if needed.
   */
  ensurePathInShellRc(targetDir) {
    if (targetDir !== path.join(os.homedir(), '.local', 'bin')) return;

    const currentPath = process.env.PATH || '';
    if (currentPath.includes(targetDir)) return;

    const zshrc = path.join(os.homedir(), '.zshrc');
    try {
      let content = '';
      if (fs.existsSync(zshrc)) {
        content = fs.readFileSync(zshrc, 'utf8');
      }
      if (!content.includes('.local/bin')) {
        fs.appendFileSync(zshrc, `\n# Added by Torrently\nexport PATH="$HOME/.local/bin:$PATH"\n`);
      }
    } catch (e) {}
  }

  /**
   * Get current installation status.
   */
  getStatus() {
    const installedPath = this.findInstalledPath();
    const isInstalled = Boolean(installedPath);
    let inPath = false;

    if (isInstalled) {
      try {
        const which = execSync(`which ${this.commandName} 2>/dev/null`, { encoding: 'utf8' }).trim();
        inPath = Boolean(which);
      } catch (e) {}
    }

    return {
      installed: isInstalled,
      path: installedPath || null,
      targetDir: this.getTargetDir(),
      inPath: inPath
    };
  }

  /**
   * Install the torrently CLI launcher.
   */
  install() {
    const targetDir = this.getTargetDir();
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const scriptPath = path.join(targetDir, this.commandName);
    const content = this.generateWrapperScript();

    fs.writeFileSync(scriptPath, content, { mode: 0o755 });
    fs.chmodSync(scriptPath, 0o755);

    this.ensurePathInShellRc(targetDir);

    return {
      success: true,
      path: scriptPath,
      targetDir: targetDir
    };
  }

  /**
   * Uninstall the torrently CLI launcher.
   */
  uninstall() {
    const candidateDirs = this.getCandidateDirs();
    let removed = false;
    let removedPath = null;

    for (const dir of candidateDirs) {
      const fullPath = path.join(dir, this.commandName);
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
          removed = true;
          removedPath = fullPath;
        } catch (e) {}
      }
    }

    return {
      success: true,
      removed: removed,
      path: removedPath
    };
  }

  /**
   * Auto-install CLI on startup if not already installed.
   */
  autoInstallIfEnabled() {
    try {
      const status = this.getStatus();
      if (!status.installed) {
        console.log('[Torrently CLI Installer] Auto-installing CLI utility...');
        const result = this.install();
        console.log(`[Torrently CLI Installer] CLI installed successfully at: ${result.path}`);
        return result;
      }
    } catch (err) {
      console.warn('[Torrently CLI Installer] Auto-install skipped:', err.message);
    }
    return null;
  }
}

module.exports = new CliInstaller();

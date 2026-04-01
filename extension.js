const vscode = require('vscode');
const { execSync } = require('child_process');

const DEFAULT_CONFIG = {
  sessionIdleMs: 5 * 60 * 1000,
  meaningfulSessionMinFiles: 1,
  activeEditWindowMs: 15 * 1000,
  debounceSaveMs: 1200,
};

class ActivityMonitoringService {
  constructor(context, onSessionDetected, config = DEFAULT_CONFIG) {
    this.context = context;
    this.onSessionDetected = onSessionDetected;
    this.config = config;

    this.disposables = [];
    this.openFileState = new Map();
    this.sessionFileState = new Map();
    this.sessionApproxLineChanges = new Map();
    this.pendingSaveTimers = new Map();

    this.sessionStartedAt = null;
    this.lastActivityAt = null;
    this.idleTimer = null;
  }

  start() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        console.log('AUTOTRIAGE EDIT DETECTED:', event.document.uri.fsPath);
        this.handleTextChange(event);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => this.handleSave(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.flushFileActivity(document)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          this.ensureTracked(editor.document);
        }
      })
    );
  }

  forceFlushCurrentSession() {
    this.finalizeCurrentSession('manual-flush');
  }

  dispose() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    for (const timer of this.pendingSaveTimers.values()) {
      clearTimeout(timer);
    }

    this.forceFlushCurrentSession();
    this.disposables.forEach((d) => d.dispose());
  }

  handleTextChange(event) {
    const document = event.document;
    if (!this.shouldTrackDocument(document)) {
      return;
    }

    const now = Date.now();
    this.ensureSessionStarted(now);
    this.lastActivityAt = now;
    this.resetIdleTimer();

    const key = document.uri.toString();
    const existing = this.ensureTracked(document);
    const approximateDelta = this.calculateApproximateLineDelta(event.contentChanges);

    const updated = {
      ...existing,
      lastEditAt: now,
      totalEditEvents: existing.totalEditEvents + 1,
      activeEditMs: existing.activeEditMs + this.estimateActiveEditMs(existing.lastEditAt, now),
      lastKnownLineCount: document.lineCount,
    };

    this.openFileState.set(key, updated);

    const priorSessionState = this.sessionFileState.get(key);
    const sessionState = priorSessionState || {
      ...updated,
      totalEditEvents: 0,
      activeEditMs: 0,
      firstEditAt: now,
      lastEditAt: now,
    };

    this.sessionFileState.set(key, {
      ...sessionState,
      firstEditAt: Math.min(sessionState.firstEditAt, updated.firstEditAt),
      lastEditAt: now,
      totalEditEvents: sessionState.totalEditEvents + 1,
      activeEditMs: sessionState.activeEditMs + this.estimateActiveEditMs(sessionState.lastEditAt, now),
      lastKnownLineCount: document.lineCount,
    });

    const previousApprox = this.sessionApproxLineChanges.get(key) || 0;
    this.sessionApproxLineChanges.set(key, previousApprox + approximateDelta);
  }

  handleSave(document) {
    if (!this.shouldTrackDocument(document)) {
      return;
    }

    const key = document.uri.toString();
    const existingTimer = this.pendingSaveTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.flushFileActivity(document);
      this.pendingSaveTimers.delete(key);
    }, this.config.debounceSaveMs);

    this.pendingSaveTimers.set(key, timer);
  }

  flushFileActivity(document) {
    if (!this.shouldTrackDocument(document)) {
      return;
    }

    const key = document.uri.toString();
    const tracked = this.openFileState.get(key);
    if (!tracked) {
      return;
    }

    this.openFileState.set(key, {
      ...tracked,
      lastKnownLineCount: document.lineCount,
    });
  }

  ensureTracked(document) {
    const key = document.uri.toString();
    const existing = this.openFileState.get(key);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const activity = {
      filePath: document.uri.fsPath,
      relativePath: this.toRelativePath(document.uri),
      languageId: document.languageId,
      firstEditAt: now,
      lastEditAt: now,
      totalEditEvents: 0,
      activeEditMs: 0,
      lastKnownLineCount: document.lineCount,
    };

    this.openFileState.set(key, activity);
    return activity;
  }

  ensureSessionStarted(now) {
    if (this.sessionStartedAt === null) {
      this.sessionStartedAt = now;
    }
  }

  resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.finalizeCurrentSession('idle-timeout');
    }, this.config.sessionIdleMs);
  }

  finalizeCurrentSession(reason) {
    if (this.sessionStartedAt === null || this.lastActivityAt === null) {
      this.clearSessionState();
      return;
    }

    const files = Array.from(this.sessionFileState.entries()).map(([key, file]) => {
      const approximateLinesChanged = this.sessionApproxLineChanges.get(key) || 0;
      return {
        filePath: file.filePath,
        relativePath: file.relativePath,
        languageId: file.languageId,
        timeSpentMs: file.activeEditMs,
        editEvents: file.totalEditEvents,
        approximateLinesChanged,
      };
    });

    const meaningfulFiles = files.filter((f) => f.editEvents > 0);
    if (meaningfulFiles.length < this.config.meaningfulSessionMinFiles) {
      console.log('AUTOTRIAGE: session ignored, not enough files edited');
      this.clearSessionState();
      return;
    }

    const workspaceRoot = this.getWorkspaceRoot();
    const session = {
      id: this.buildSessionId(this.sessionStartedAt),
      workspaceRoot,
      repoName: this.getRepoName(workspaceRoot),
      branchName: this.getBranchName(workspaceRoot),
      startedAt: this.sessionStartedAt,
      endedAt: this.lastActivityAt,
      files: meaningfulFiles.sort((a, b) => b.timeSpentMs - a.timeSpentMs),
      totalFilesEdited: meaningfulFiles.length,
      totalApproximateLinesChanged: meaningfulFiles.reduce((sum, file) => sum + file.approximateLinesChanged, 0),
      totalActiveEditMs: meaningfulFiles.reduce((sum, file) => sum + file.timeSpentMs, 0),
    };

    console.log('AUTOTRIAGE SESSION DETECTED:', reason, session);
    this.context.workspaceState.update('autotriage.lastSession', session);
    this.onSessionDetected(session);
    this.clearSessionState();
  }

  clearSessionState() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.sessionStartedAt = null;
    this.lastActivityAt = null;
    this.sessionFileState.clear();
    this.sessionApproxLineChanges.clear();
  }

  calculateApproximateLineDelta(changes) {
    let total = 0;

    for (const change of changes) {
      const insertedLines = change.text.length === 0 ? 0 : change.text.split(/\r?\n/).length;
      const replacedLines = change.range.end.line - change.range.start.line + 1;
      total += Math.max(insertedLines, replacedLines);
    }

    return total;
  }

  estimateActiveEditMs(previousAt, currentAt) {
    const delta = currentAt - previousAt;
    return Math.min(delta, this.config.activeEditWindowMs);
  }

  shouldTrackDocument(document) {
    if (document.isUntitled) {
      return false;
    }

    if (document.uri.scheme !== 'file') {
      return false;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return false;
    }

    const ignoredDirectories = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];
    const normalizedPath = document.uri.fsPath.replace(/\\/g, '/');

    return !ignoredDirectories.some((dir) => normalizedPath.includes(`/${dir}/`));
  }

  toRelativePath(uri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return uri.fsPath;
    }

    return vscode.workspace.asRelativePath(uri, false);
  }

  getWorkspaceRoot() {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    return folder ? folder.uri.fsPath : '';
  }

  getBranchName(workspaceRoot) {
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: workspaceRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return 'unknown-branch';
    }
  }

  getRepoName(workspaceRoot) {
    if (!workspaceRoot) {
      return 'unknown-repo';
    }

    try {
      const topLevel = execSync('git rev-parse --show-toplevel', {
        cwd: workspaceRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      const parts = topLevel.replace(/\\/g, '/').split('/').filter(Boolean);
      return parts[parts.length - 1] || 'unknown-repo';
    } catch {
      const parts = workspaceRoot.replace(/\\/g, '/').split('/').filter(Boolean);
      return parts[parts.length - 1] || 'unknown-repo';
    }
  }

  buildSessionId(startedAt) {
    return `session-${startedAt}`;
  }
}

function activate(context) {
  console.log('AUTOTRIAGE EXTENSION STARTED');
  vscode.window.showInformationMessage('AutoTriage extension activated');

  const tracker = new ActivityMonitoringService(context, (session) => {
    vscode.window.showInformationMessage(
      `AutoTriage detected a dev session: ${session.totalFilesEdited} files, ${session.totalApproximateLinesChanged} approx lines changed.`
    );
  });

  tracker.start();

  context.subscriptions.push(
    tracker,
    vscode.commands.registerCommand('autotriage.flushSession', () => {
      console.log('AUTOTRIAGE FLUSH COMMAND RAN');
      vscode.window.showInformationMessage('Flush command ran');
      tracker.forceFlushCurrentSession();
    })
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
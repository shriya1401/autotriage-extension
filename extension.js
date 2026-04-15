// AutoTriage VSCode Extension
const vscode = require('vscode');
const { execSync } = require('child_process');

const DEFAULT_CONFIG = {
  sessionIdleMs: 5 * 60 * 1000,
  meaningfulSessionMinFiles: 1,
  activeEditWindowMs: 15 * 1000,
  debounceSaveMs: 1200,
};

let currentIssuePanel = null;
let sidebarProvider = null;

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
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const timer of this.pendingSaveTimers.values()) clearTimeout(timer);
    this.forceFlushCurrentSession();
    this.disposables.forEach((d) => d.dispose());
  }

  handleTextChange(event) {
    const document = event.document;
    if (!this.shouldTrackDocument(document)) return;

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
    if (!this.shouldTrackDocument(document)) return;

    const key = document.uri.toString();
    const existingTimer = this.pendingSaveTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.flushFileActivity(document);
      this.pendingSaveTimers.delete(key);
    }, this.config.debounceSaveMs);

    this.pendingSaveTimers.set(key, timer);
  }

  flushFileActivity(document) {
    if (!this.shouldTrackDocument(document)) return;

    const key = document.uri.toString();
    const tracked = this.openFileState.get(key);
    if (!tracked) return;

    this.openFileState.set(key, {
      ...tracked,
      lastKnownLineCount: document.lineCount,
    });
  }

  ensureTracked(document) {
    const key = document.uri.toString();
    const existing = this.openFileState.get(key);
    if (existing) return existing;

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
    if (this.idleTimer) clearTimeout(this.idleTimer);
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
    if (document.isUntitled) return false;
    if (document.uri.scheme !== 'file') return false;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) return false;

    const ignoredDirectories = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];
    const normalizedPath = document.uri.fsPath.replace(/\\/g, '/');
    return !ignoredDirectories.some((dir) => normalizedPath.includes(`/${dir}/`));
  }

  toRelativePath(uri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) return uri.fsPath;
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
    if (!workspaceRoot) return 'unknown-repo';

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

async function generateIssueFromSession(session) {
  let combinedText = '';

  for (const file of session.files.slice(0, 5)) {
    try {
      const doc = await vscode.workspace.openTextDocument(file.filePath);
      combinedText += `\nFILE: ${file.relativePath}\n${doc.getText().slice(0, 2000)}\n`;
    } catch (err) {
      console.log('Could not read file:', file.filePath);
    }
  }

  const lowerText = combinedText.toLowerCase();
  const filesTouched = session.files.map((f) => f.relativePath);

  let issue = {
    title: `Implement updates across ${session.totalFilesEdited} files`,
    summary: `This session modified ${session.totalFilesEdited} file(s) in ${session.repoName} on branch ${session.branchName}.`,
    changes: [
      'Updated implementation across multiple files',
      'Modified code structure based on recent edits',
    ],
    filesTouched,
    acceptanceCriteria: [
      'Updated files reflect the intended implementation changes',
      'Changes remain consistent with the repository structure',
      'The generated issue accurately summarizes the coding session',
    ],
  };

  if (
    lowerText.includes('caches.open') ||
    lowerText.includes('caches.match') ||
    lowerText.includes("self.addeventlistener('install'") ||
    lowerText.includes("self.addeventlistener('fetch'") ||
    lowerText.includes('service worker')
  ) {
    issue = {
      title: 'Implement service worker caching and offline request handling',
      summary:
        'Implemented service worker lifecycle handling with cache setup, cached response matching, and offline fallback support.',
      changes: [
        'Added install event handling for service worker setup',
        'Cached static assets using caches.open(...)',
        'Added fetch event handling with caches.match(...)',
        'Introduced offline/network fallback behavior',
      ],
      filesTouched,
      acceptanceCriteria: [
        'Service worker installs and activates without errors',
        'Cached assets are served when available',
        'Offline fallback works when network requests fail',
        'Related frontend/test files reflect the new behavior',
      ],
    };
  }

  if (
    lowerText.includes('<html') ||
    lowerText.includes('<body') ||
    lowerText.includes('<script')
  ) {
    if (!lowerText.includes('caches.open') && !lowerText.includes('caches.match')) {
      issue = {
        title: 'Update frontend page structure and interactive behavior',
        summary:
          'Modified frontend page content and client-side behavior to support updated UI or test flows.',
        changes: [
          'Updated HTML structure',
          'Adjusted frontend rendering or script logic',
          'Aligned test/support files with the updated page behavior',
        ],
        filesTouched,
        acceptanceCriteria: [
          'Frontend renders correctly',
          'Updated scripts run without console errors',
          'Modified page behavior matches intended functionality',
        ],
      };
    }
  }

  return issue;
}

function formatIssueAsMarkdown(issue) {
  return `# ${issue.title}

## Summary
${issue.summary}

## What Changed
${(issue.changes || []).map((item) => `- ${item}`).join('\n')}

## Files Touched
${(issue.filesTouched || []).map((file) => `- \`${file}\``).join('\n')}

## Acceptance Criteria
${(issue.acceptanceCriteria || []).map((item) => `- [ ] ${item}`).join('\n')}
`;
}

class AutoTriageSidebarProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    this.update();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'flushSession') {
        await vscode.commands.executeCommand('autotriage.flushSession');
      }

      if (message.command === 'openPreview') {
        await vscode.commands.executeCommand('autotriage.showLastIssueDraft');
      }

      if (message.command === 'exportDraft') {
        await vscode.commands.executeCommand('autotriage.exportLastIssueDraft');
      }
    });
  }

  async update() {
    if (!this.view) return;

    const lastSession = this.context.workspaceState.get('autotriage.lastSession');
    const lastIssue = this.context.workspaceState.get('autotriage.lastGeneratedIssue');

    this.view.webview.html = this.getHtml(lastSession, lastIssue);
  }

  getHtml(session, issue) {
    const sessionHtml = session
      ? `
        <div class="card">
          <h3>Latest Session</h3>
          <p><strong>Repo:</strong> ${escapeHtml(session.repoName)}</p>
          <p><strong>Branch:</strong> ${escapeHtml(session.branchName)}</p>
          <p><strong>Files Edited:</strong> ${session.totalFilesEdited}</p>
          <p><strong>Approx Lines Changed:</strong> ${session.totalApproximateLinesChanged}</p>
        </div>
      `
      : `
        <div class="card">
          <h3>Latest Session</h3>
          <p>No session detected yet.</p>
        </div>
      `;

    const issueHtml = issue
      ? `
        <div class="card">
          <h3>Last Generated Issue</h3>
          <p><strong>Title:</strong> ${escapeHtml(issue.title)}</p>
          <p><strong>Summary:</strong> ${escapeHtml(issue.summary)}</p>
        </div>
      `
      : `
        <div class="card">
          <h3>Last Generated Issue</h3>
          <p>No issue draft generated yet.</p>
        </div>
      `;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 12px;
            color: #dddddd;
            background: #1e1e1e;
          }
          h2 {
            margin-top: 0;
            font-size: 20px;
          }
          .card {
            background: #252526;
            border: 1px solid #444;
            border-radius: 10px;
            padding: 12px;
            margin-bottom: 12px;
          }
          .button-row {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          button {
            padding: 10px;
            border: none;
            border-radius: 8px;
            background: #0e639c;
            color: white;
            cursor: pointer;
            font-weight: bold;
          }
          button.secondary {
            background: #555;
          }
          p {
            margin: 6px 0;
            font-size: 13px;
            line-height: 1.4;
          }
        </style>
      </head>
      <body>
        <h2>AutoTriage</h2>

        ${sessionHtml}
        ${issueHtml}

        <div class="card">
          <h3>Actions</h3>
          <div class="button-row">
            <button onclick="runCommand('flushSession')">Flush Session</button>
            <button class="secondary" onclick="runCommand('openPreview')">Open Preview</button>
            <button class="secondary" onclick="runCommand('exportDraft')">Export Markdown</button>
          </div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();

          function runCommand(command) {
            vscode.postMessage({ command });
          }
        </script>
      </body>
      </html>
    `;
  }
}

function getIssuePreviewHtml(issue) {
  const criteriaText = (issue.acceptanceCriteria || []).join('\n');
  const changesText = (issue.changes || []).join('\n');
  const filesTouchedText = (issue.filesTouched || []).join('\n');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>AutoTriage Issue Preview</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          padding: 20px;
          color: #dddddd;
          background: #1e1e1e;
        }
        h1 {
          font-size: 22px;
          margin-bottom: 16px;
        }
        label {
          display: block;
          margin-top: 16px;
          margin-bottom: 6px;
          font-weight: bold;
        }
        input, textarea {
          width: 100%;
          box-sizing: border-box;
          padding: 10px;
          border-radius: 8px;
          border: 1px solid #555;
          background: #252526;
          color: #ffffff;
        }
        textarea {
          min-height: 100px;
          resize: vertical;
        }
        .button-row {
          margin-top: 20px;
          display: flex;
          gap: 10px;
        }
        button {
          padding: 10px 14px;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-weight: bold;
        }
        .save-btn {
          background: #0e639c;
          color: white;
        }
        .close-btn {
          background: #555;
          color: white;
        }
        .note {
          margin-top: 16px;
          font-size: 13px;
          color: #bbbbbb;
        }
      </style>
    </head>
    <body>
      <h1>AutoTriage Issue Preview</h1>

      <label for="title">Issue Title</label>
      <input id="title" value="${escapeHtml(issue.title)}" />

      <label for="summary">Summary</label>
      <textarea id="summary">${escapeHtml(issue.summary)}</textarea>

      <label for="changes">What Changed (one per line)</label>
      <textarea id="changes">${escapeHtml(changesText)}</textarea>

      <label for="filesTouched">Files Touched (one per line)</label>
      <textarea id="filesTouched">${escapeHtml(filesTouchedText)}</textarea>

      <label for="criteria">Acceptance Criteria (one per line)</label>
      <textarea id="criteria">${escapeHtml(criteriaText)}</textarea>

      <div class="button-row">
        <button class="save-btn" onclick="saveIssue()">Save Draft</button>
        <button class="close-btn" onclick="closePanel()">Close</button>
      </div>

      <div class="note">
        Edit the generated issue draft here before publishing.
      </div>

      <script>
        const vscode = acquireVsCodeApi();

        const issueData = {
          title: ${JSON.stringify(issue.title)},
          summary: ${JSON.stringify(issue.summary)},
          changes: ${JSON.stringify(issue.changes || [])},
          filesTouched: ${JSON.stringify(issue.filesTouched || [])},
          acceptanceCriteria: ${JSON.stringify(issue.acceptanceCriteria || [])}
        };

        function saveIssue() {
          const updatedIssue = {
            ...issueData,
            title: document.getElementById('title').value,
            summary: document.getElementById('summary').value,
            changes: document.getElementById('changes').value.split('\\n').map(line => line.trim()).filter(Boolean),
            filesTouched: document.getElementById('filesTouched').value.split('\\n').map(line => line.trim()).filter(Boolean),
            acceptanceCriteria: document.getElementById('criteria').value.split('\\n').map(line => line.trim()).filter(Boolean)
          };

          vscode.postMessage({
            command: 'saveIssueDraft',
            issue: updatedIssue
          });
        }

        function closePanel() {
          vscode.postMessage({
            command: 'closePanel'
          });
        }
      </script>
    </body>
    </html>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showIssuePreviewPanel(context, issue) {
  if (currentIssuePanel) {
    currentIssuePanel.reveal(vscode.ViewColumn.One);
    currentIssuePanel.webview.html = getIssuePreviewHtml(issue);
    return;
  }

  currentIssuePanel = vscode.window.createWebviewPanel(
    'autotriageIssuePreview',
    'AutoTriage Issue Preview',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  currentIssuePanel.webview.html = getIssuePreviewHtml(issue);

  currentIssuePanel.webview.onDidReceiveMessage(
    async (message) => {
      if (message.command === 'saveIssueDraft') {
        await context.workspaceState.update('autotriage.lastGeneratedIssue', message.issue);
        vscode.window.showInformationMessage('AutoTriage issue draft saved.');
        if (sidebarProvider) {
          await sidebarProvider.update();
        }
      }

      if (message.command === 'closePanel') {
        currentIssuePanel.dispose();
      }
    },
    undefined,
    context.subscriptions
  );

  currentIssuePanel.onDidDispose(() => {
    currentIssuePanel = null;
  }, null, context.subscriptions);
}

function activate(context) {
  console.log('AUTOTRIAGE EXTENSION STARTED');
  vscode.window.showInformationMessage('AutoTriage extension activated');

  sidebarProvider = new AutoTriageSidebarProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('autotriageSidebar', sidebarProvider)
  );

  const tracker = new ActivityMonitoringService(context, async (session) => {
    vscode.window.showInformationMessage(
      `AutoTriage detected a dev session: ${session.totalFilesEdited} files, ${session.totalApproximateLinesChanged} approx lines changed.`
    );

    const issue = await generateIssueFromSession(session);
    await context.workspaceState.update('autotriage.lastGeneratedIssue', issue);

    if (sidebarProvider) {
      await sidebarProvider.update();
    }

    showIssuePreviewPanel(context, issue);
  });

  tracker.start();

  context.subscriptions.push(
    tracker,
    vscode.commands.registerCommand('autotriage.flushSession', async () => {
      console.log('AUTOTRIAGE FLUSH COMMAND RAN');
      vscode.window.showInformationMessage('Flush command ran');
      tracker.forceFlushCurrentSession();
      if (sidebarProvider) {
        await sidebarProvider.update();
      }
    }),
    vscode.commands.registerCommand('autotriage.showLastIssueDraft', async () => {
      const issue = context.workspaceState.get('autotriage.lastGeneratedIssue');

      if (!issue) {
        vscode.window.showWarningMessage('No generated issue draft found yet.');
        return;
      }

      showIssuePreviewPanel(context, issue);
    }),
    vscode.commands.registerCommand('autotriage.exportLastIssueDraft', async () => {
      const issue = context.workspaceState.get('autotriage.lastGeneratedIssue');

      if (!issue) {
        vscode.window.showWarningMessage('No generated issue draft found yet.');
        return;
      }

      const formattedIssue = formatIssueAsMarkdown(issue);
      const doc = await vscode.workspace.openTextDocument({
        content: formattedIssue,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand('autotriage.openSidebarPreview', async () => {
      if (sidebarProvider) {
        await sidebarProvider.update();
      }
    })
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
export interface SidebarResources { scriptUri: string; styleUri: string; }

export function getSidebarHtml(nonce: string, cspSource: string, resources: SidebarResources): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; script-src 'nonce-${nonce}'; connect-src 'none';">
  <title>Carrot AI</title>
  <link rel="stylesheet" href="${resources.styleUri}">
</head>
<body>
  <div id="app" class="app">
    <header class="chat-header">
      <button id="modelButton" class="header-model" type="button" aria-label="Choose model" title="Choose model">
        <span id="composerStatus" class="status-dot" aria-hidden="true"></span>
        <span id="composerModel" class="truncate"></span><span aria-hidden="true">⌄</span>
      </button>
      <div id="workingState" class="working-state" hidden aria-live="polite">
        <span class="header-loader" aria-hidden="true"></span><span id="workingLabel" class="truncate">Thinking…</span>
      </div>
      <span class="header-spacer"></span>
      <button id="newChatButton" class="icon-button" type="button" aria-label="New chat" title="New chat">+</button>
      <button id="historyButton" class="icon-button" type="button" aria-label="Chat history" title="Chat history">◷</button>
      <button id="moreButton" class="icon-button" type="button" aria-label="More actions" title="More actions">•••</button>
      <div id="headerMenu" class="menu header-menu" hidden>
        <button type="button" data-action="refreshModels">Refresh Models</button>
        <button id="localOnlyToggle" type="button" role="switch" aria-checked="true" data-action="toggleLocalOnly" title="ON uses only local models. OFF allows available cloud models too."><span>Local Models Only</span><span id="localOnlyState" class="toggle-state enabled">ON</span></button>
        <button type="button" data-action="testAgentTools">Test Agent Tools</button>
        <button type="button" data-action="clearHistory">Clear Chat History</button>
        <button type="button" data-action="settings">Settings</button>
        <button type="button" data-action="signOut">Sign Out</button>
      </div>
    </header>

    <div id="errorBanner" class="error-banner" role="status" aria-live="polite" hidden><span id="errorText"></span><button id="retry" type="button">Retry</button></div>
    <main id="conversationView" class="main-view"><div id="conversation" class="conversation" aria-live="polite"></div></main>
    <main id="historyView" class="main-view history-view" hidden>
      <div class="view-toolbar"><button id="historyBack" class="icon-button" type="button" aria-label="Back to conversation" title="Back">←</button><strong>Chats</strong></div>
      <div id="history" class="history-list"></div>
    </main>

    <section id="agentActivity" class="future-region" hidden aria-live="polite"></section>
    <section id="changedFiles" class="future-region" hidden></section>

    <footer id="composerArea" class="composer-area">
      <div id="contextChips" class="context-chips" hidden></div>
      <div class="composer">
        <textarea id="prompt" rows="1" aria-label="Message Carrot AI" placeholder="Ask Carrot…"></textarea>
        <div class="composer-toolbar">
          <div class="tools-anchor">
            <button id="toolsButton" class="toolbar-button" type="button" aria-expanded="false">+ Tools</button>
            <div id="toolsMenu" class="menu tools-menu" hidden>
              <button id="webSearchToggle" type="button" role="switch" aria-checked="false"><span>Web Search</span><span id="webSearchState">OFF</span></button>
              <button type="button" data-context="currentFile">Add current file</button>
              <button type="button" data-context="selection">Add selection</button>
              <button type="button" data-context="file">Add file…</button>
            </div>
          </div>
          <span id="searchBadge" class="search-badge" hidden>Web ON</span>
          <div class="mode-selector" role="group" aria-label="Chat mode">
            <button id="askMode" type="button" data-mode="ask">Ask</button><button id="agentMode" type="button" data-mode="agent" class="selected">Agent</button>
          </div>
          <span class="toolbar-spacer"></span>
          <button id="send" class="send-button" type="button" title="Send (Enter)" aria-label="Send message">↑</button>
        </div>
      </div>
    </footer>

    <div id="modelPicker" class="picker-backdrop" hidden>
      <section class="picker" role="dialog" aria-modal="true" aria-labelledby="pickerTitle">
        <div class="picker-header"><strong id="pickerTitle">Choose model</strong><button id="modelClose" class="icon-button" type="button" aria-label="Close model picker">×</button></div>
        <div id="modelList" class="model-list"></div>
      </section>
    </div>
  </div>
  <script nonce="${nonce}" src="${resources.scriptUri}"></script>
</body>
</html>`;
}

# Carrot AI VS Code Extension

Carrot has a dedicated Activity Bar container and themed sidebar, while retaining the `@carrot` VS Code Chat participant.

The sidebar follows a conversation-first layout: a compact model/header menu, animated high-level working status, independent conversation scrolling, an auto-growing composer, and a separate history view. Successful temporary activity collapses after the final response; errors remain visible. The UI never exposes hidden model reasoning.

The composer provides **Ask / Agent** modes, defaults to **Ask**, and remembers a manual mode selection across sidebar navigation and VS Code reloads. It also provides a Stop action during either mode and a compact **+ Tools** menu. Context actions can add the current workspace file, the current selection, or a chosen workspace file. Context content stays in extension-host memory; the Webview receives labels only, sensitive filenames are blocked, and explicit context is cleared after sending.

**Web Search** is OFF by default. When enabled, Agent mode receives an authenticated, query-bounded `web_search` tool backed by Carrot's existing internet search service; when disabled, that tool is absent from the registry. Ask mode uses the existing streaming-chat web context. Local Only still controls model routing independently: internet retrieval may run, but inference remains on an available local model.

Authenticated sidebar and `@carrot` conversations use the signed-in Carrot AI profile and that user's private cross-conversation context from the backend. Profile and conversation memory are isolated by the authenticated user ID and are never stored as shared extension state.

## Project agent

Coding-oriented requests use the P4 project-agent loop. The selected model can request bounded tools for project discovery, tree inspection, workspace search, file reads, current editor context, diagnostics, Git status, reviewed exact-replacement edits, file creation, multi-file WorkspaceEdit application, and allowlisted build/test/lint commands. The extension validates and executes every call; the Nest backend only performs authenticated model turns and never receives filesystem authority.

Agent tasks have iteration, time, search, file-size, result, and context limits. Sensitive files are excluded. Writes and commands require modal approval, workspace changes receive a VS Code diff preview before final confirmation, and Local Only is forwarded on every model turn. The composer Send button becomes Stop during an agent task.

Workspace discovery searches every explicitly opened root. Filename and content tools accept either one `query` or a structured `queries` array, normalize common authentication terms, and rank OR-matches instead of requiring an entire natural-language phrase to occur literally. Results retain `rootIndex` so follow-up reads stay in the correct sandbox root.

Project tasks require actual workspace evidence before a final answer is accepted. If a model describes a tool, claims it cannot access the workspace, emits malformed JSON, or answers before executing a tool, Carrot performs bounded corrective retries. Structured calls still pass through the registry validator; tool-like prose is never executed. After repeated failure, Carrot reports a model compatibility error instead of pretending the task succeeded.

Enable `carrot.debugAgent` to write sanitized model/provider selection, protocol mode, response shape, parser decisions, correction counts, tool arguments, result counts, timings, and failures to the Carrot AI output channels. Prompts, raw model text, workspace contents, JWTs, keys, and Secret Storage are not logged. Run **Carrot AI: Test Agent Tools** to manually test the selected model with a read-only `package.json` discovery task.

This extension is the VS Code-side authority for Carrot AI. It connects to the existing Nest backend but does not give that backend direct access to workspace paths or files.

## Development

1. Run `npm.cmd install` in this folder.
2. Ensure PostgreSQL and Ollama are running.
3. Start the existing Carrot backend from the repository root with `npm.cmd run start:dev`.
4. Open `vscode-extension` in VS Code and press `F5` to launch an Extension Development Host.
5. In the development host, run **Carrot AI: Sign In** and enter the same credentials used by the Carrot web app.
6. Run **Carrot AI: Select Model**, or leave the selection on local-first **Auto**.
7. Click the Carrot icon in the Activity Bar and send a message from the dedicated sidebar. The existing `@carrot hello` interface also remains available.

The backend URL is configurable with `carrot.backendUrl`; it defaults to `http://localhost:3000/api`. The extension defaults to the coding-focused `local:qwen2.5-coder:7b`, while model selection persists in VS Code global state. **Carrot AI: Refresh Models** re-reads the real Ollama inventory, so installing or removing a local model does not require extension code changes.

`carrot.localOnly` defaults to `true`. While enabled, cloud models are hidden and the backend rejects cloud model requests. Embedding models can be discovered but are never offered for chat.

The extension sends credentials only to `POST /api/auth/login`, stores the returned JWT in VS Code Secret Storage, and uses it for protected requests. Tokens and passwords are never logged or committed. Use **Carrot AI: New Chat**, **Delete Current Chat**, and **Clear Chat History** for explicit session lifecycle control. Destructive history commands require confirmation and the backend applies every operation only to the authenticated user.

## Sidebar security

The Webview has no direct network or filesystem access. It exchanges a validated, bounded message protocol with the extension host, which alone can call `CarrotClient`. A nonce-based Content Security Policy disallows remote scripts, inline/eval execution, and all Webview network connections. Model output is escaped before the local Markdown transform. JWTs, API keys, Secret Storage values, absolute workspace paths, and backend URLs are not placed in Webview state.

The sidebar reuses the backend SSE endpoint for incremental chat output. Persisted session data is reloaded from the backend after completion, so the Webview is not a second conversation database.

## Workspace authority

Only the extension host reads explicitly opened workspace roots. It sends bounded tool results—not arbitrary path authority—to the model through the authenticated backend. Sensitive files remain blocked, and every write or validation command remains subject to the P4 policy and approval flow.

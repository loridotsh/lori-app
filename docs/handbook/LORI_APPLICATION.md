# Lori application guide

What Lori does, why its features exist, and how people use them.

## Contents

- [Why Lori exists](#1-why-lori-exists)
- [Code: organize development work](#2-code-organize-development-work)
- [Code: inspect files and deliver changes](#3-code-inspect-files-and-deliver-changes)
- [Code: configure tools once](#4-code-configure-tools-once)
- [Code: automate recurring tasks](#5-code-automate-recurring-tasks)
- [Work: complete tasks through conversation](#6-work-complete-tasks-through-conversation)
- [Work: create, inspect, and edit files](#7-work-create-inspect-and-edit-files)
- [Work: explain information visually](#8-work-explain-information-visually)
- [Work: connect services and remember context](#9-work-connect-services-and-remember-context)
- [Settings, usage, and everyday controls](#10-settings-usage-and-everyday-controls)
- [Everyday examples](#11-two-everyday-examples)
- [Availability and sources](#12-availability-and-source-notes)

## 1. Why Lori exists

People increasingly work with several AI tools. Each tool has its own conversations, connections, settings, and way of asking for permission. Moving between them means repeating setup, finding earlier work, and deciding what the AI actually changed.

Lori brings that work into one desktop application. **Code** helps developers work with coding agents and repositories. **Work** helps people research, write, analyze information, and create documents through conversation. Both provide a place to review activity and results.

Developers use Code for software tasks. Founders, analysts, operations teams, and other knowledge workers can use Work for tasks such as preparing a report, analyzing a spreadsheet, or producing a presentation. Developers can use Work too.

### The two modes

| Mode | What you bring | What Lori helps you do |
| --- | --- | --- |
| **Code** | A code folder or repository and a coding agent. | Discuss changes, run tools, review files and differences, and manage Git work. |
| **Work** | A question, working folder, source files, or connected service. | Research, analyze, write, create files, and review proposed actions. |

An **agent** is the AI tool doing the task. A **provider** supplies access to AI models; a **model** is the particular AI you select. A **workspace** is a working folder. A **session** or **conversation** keeps a task's discussion and activity together. These distinctions help explain the features below.

## 2. Code: organize development work

### 2.1 Open, create, or clone a workspace

Lori lets you open an existing folder, create a workspace, or clone a repository. Its sessions stay grouped under that workspace in the sidebar.

**Why use it:** Developers can keep different products and tasks organized instead of searching through unrelated terminal windows. Start from the workspace actions, then choose the folder or repository you want to work on.

### 2.2 Choose a coding agent

Lori supports Claude Code, Codex, OpenCode, Antigravity, Hermes, Cursor, and Pi through agent adapters. It discovers available tools and provides setup or configuration entry points.

**Why use it:** You can choose the agent that suits a task without reorganizing your whole working environment. Agent sign-in, available models, and supported controls still depend on that tool.

### 2.3 Sessions and agent tabs

A session groups a development task; tabs let you open agents, a terminal, or a browser within it. You can rename sessions and return to existing work from the workspace tree.

**Why use it:** Keep a feature implementation, investigation, and review easy to find. Use separate sessions for separate tasks and tabs for the tools participating in one task.

### 2.4 Conversation view and terminal view

Supported agents have a conversation interface showing messages, tool activity, questions, and approvals. Native terminal-based agents run in terminal panes. Lori exposes controls according to the selected agent's capabilities.

**Why use it:** You can follow an agent's work in a readable interface while retaining the tools' native execution. Do not assume every agent offers the same conversation controls.

### 2.5 Split views, terminal tabs, and browser tabs

Tabs can be arranged in resizable splits. A terminal tab provides a command shell; a browser tab opens pages with normal address, back, forward, and reload controls.

**Why use it:** Developers can view an agent beside a running application or terminal output. A browser tab is a way to view a page; opening it does not itself give an agent permission to control the page.

### 2.6 Add context with file mentions and attachments

Supported composers offer file search through `@` mentions, slash commands, and compatible attachments. These make the intended files and instructions explicit.

**Why use it:** Point an agent at the relevant source instead of describing where to look. For example, mention a component and ask it to explain a bug before proposing a fix. Available attachment and command types vary by agent.

### 2.7 Model, reasoning, and plan controls

Where supported, the composer exposes model selection, reasoning effort, planning/collaboration mode, and related agent preferences. Plan mode provides a way to discuss an approach before implementation.

**Why use it:** Choose a suitable model and working style for a quick question, investigation, or larger change. Lori shows the settings the runtime supports rather than promising identical controls for every agent.

### 2.8 Questions, approvals, stopping, and follow-ups

The conversation can show an agent's questions and requested permissions. Supported runtimes also let you stop an active turn or queue a follow-up while work is in progress.

**Why use it:** You stay involved when an agent needs a decision, and can redirect a task without losing the discussion. Review the requested action and scope before approving it.

### 2.9 Resume, fork, and switch agents

Existing sessions can be resumed. Supported structured runtimes expose actions such as starting a fresh conversation, forking a conversation, closing it while retaining history, or deleting it. Agent switching uses transcript conversion to carry conversational context between compatible tools.

**Why use it:** Continue an investigation later, explore another approach, or move to a different agent. Conversation transfer does not imply that native tool state or every setting transfers identically.

### 2.10 Agent status and background work

Session and tab indicators distinguish running work, requests for attention, idle agents, and suspended sessions. Notifications and the tray can bring you back to the relevant task. Idle terminal suspension is configurable.

**Why use it:** You can work on another task while an agent runs, then return when a decision is needed. Closing a window and quitting the application can have different effects; check the desktop setting.

### 2.11 Agent coordination

Lori-managed Claude and Codex tabs can discover and message peers in the same session when coordination is enabled. Settings control approval for agent-created tabs, placement in a tab or split, and coordination limits.

**Why use it:** Developers can divide a task between cooperating agents while keeping their work visible. Coordination is scoped to supported tabs in the same session; it is not an unrestricted company-wide agent network.

### 2.12 New Chat and agent/model selection

Code also offers **New chat**, a conversation tab with an available agent/model picker, model search/favorites, attachments, and selected task skills. The supported chat integrations include Claude, Codex, Cursor, OpenCode, and Pi when their runtimes are available.

**Why use it:** Start a coding discussion from the conversation interface rather than opening a terminal first. Builds with mid-conversation agent switching enabled can keep the Lori transcript while changing the underlying agent; that rollout is separate from ordinary model selection and terminal agent handoff.

### 2.13 Chat access modes, skills, and context

The Chat interface exposes supported access modes, including supervised operation, edit approval, automatic review, and full access. A skills picker adds selected personal/project guidance to the task, and a context meter shows available context information.

**Why use it:** See which instructions and permissions apply to a chat and choose the level of supervision deliberately. Runtime limitations still apply; changing agents does not silently transfer every permission or elevate access.

## 3. Code: inspect files and deliver changes

Open the right sidebar to move between **Files**, **Changes**, and **History**.

### 3.1 File explorer and editor

The Files view browses the workspace tree and opens files in Lori's editor or an appropriate preview. Source files can be inspected and edited without leaving the application; supported media can be previewed.

**Why use it:** Read the surrounding implementation and inspect results rather than relying only on an agent's description.

### 3.2 Changes and the current-turn diff

Changes shows modified files and their differences. The turn-scoped view highlights the edits associated with an agent turn, while the broader change view supports reviewing the working tree.

**Why use it:** Developers and reviewers can see what actually changed, compare before and after, and catch unrelated edits before committing.

### 3.3 Stage, commit, push, pull, and sync

Lori provides in-app Git actions for staging and unstaging changes, committing, and communicating with a remote repository. Branch and conflict state remains relevant to those actions.

**Why use it:** Complete the normal review-and-delivery workflow alongside the agent that made the changes. Git authentication and repository permissions still apply.

### 3.4 Branches and isolated worktrees

Sessions can share a working folder or use a separate Git worktree: another checkout of the same repository on its own branch. New-session options include a new branch, an existing branch, an imported linked worktree, or a supported change request.

**Why use it:** Work on parallel tasks without putting all edits in one folder. Shared sessions remain useful for a single working tree; isolation is a deliberate choice.

### 3.5 Change requests and repository connections

Source Control settings connect supported GitHub, GitLab, and Bitbucket workflows. Lori can use change-request checkouts and available create/merge actions, with provider-specific permissions and repository rules.

**Why use it:** Bring review work into the same session as the code. Preferred clone protocol and merge strategy can be configured without assuming every repository permits the same actions.

### 3.6 Commit history and opening an IDE

History lets you browse and filter commits and inspect commit details. Workspace controls can also open the project in a detected external IDE.

**Why use it:** Understand why code changed, investigate an earlier revision, or move into your preferred editor when the task calls for it.

## 4. Code: configure tools once

### 4.1 Apps and service sign-in

**Extensions** includes apps that connect through a supported sign-in flow. You authorize the account, then manage the connection in Lori.

**Why use it:** Bring a service's available tools to your coding agents without manually repeating each connection setup. The service's own permissions and company policy determine what becomes available.

### 4.2 MCP plugins and custom connections

MCP is a standard way for an AI tool to access external tools or information. Lori's plugin catalog supports discovery, installation, configuration, enabling/disabling, removal, and custom MCP setup.

**Why use it:** Developers can add the tools their agents need from one place. Choose which supported agents receive a plugin; installing a plugin is separate from authenticating its service.

### 4.3 Memory integrations

The Code extensions catalog also has memory-oriented integrations, such as services that provide persistent context or documentation to coding tools.

**Why use it:** Equip coding agents with a chosen memory/context service. This is separate from Work's built-in memory, which is described later in this guide.

### 4.4 Skills: discover, install, and add your own

A skill is reusable guidance for a task. Code's Skills view supports discovering and installing skills, managing installed items, adding custom skills, selecting agent availability, and checking skill updates.

**Why use it:** Teams and individuals can reuse a reliable process instead of rewriting the same instructions for each task.

### 4.5 Publish a skill

Eligible skills can enter a publication flow with a package preview, listing details, confirmation, and submission status. This requires the appropriate personal Lori account and an enabled registry submission service; submission can involve review.

**Why use it:** Share a reusable skill with other users through the registry. Preparing a skill locally does not automatically publish it.

### 4.6 Per-agent synchronization

Lori translates supported extensions, skills, providers, and settings into each agent's native configuration. Agent toggles, sync status, warnings, and retry actions show whether delivery succeeded.

**Why use it:** Reduce duplicate setup across tools while keeping differences visible. A saved configuration and a successfully applied configuration are separate states.

### 4.7 Cloud, custom, and local AI providers

**LLM Providers** manages supported cloud providers, compatible custom endpoints, and local services such as Ollama and vLLM. Local-provider controls include relevant setup and model-management actions. Supported agent assignments determine which tools use a connection.

**Why use it:** Choose the model service appropriate to cost, capability, or local execution needs. Some agents support provider routing and others retain their own provider behavior. Company-managed entries are governed by Enterprise and are read-only where required.

## 5. Code: automate recurring tasks

### 5.1 Manual and scheduled automations

An automation combines a workspace, a supported coding agent, and instructions. It can run on demand or on a schedule, including hourly, daily, weekly, or a custom schedule.

**Why use it:** Developers can repeat tasks such as repository checks or maintenance reviews without recreating the prompt. Scheduled execution depends on the local application/runtime being available; it is not a hosted scheduling service.

### 5.2 Run limits and permissions

Automations include sandbox choices, maximum runtime, concurrency controls, pause/resume, run-now, and cancellation. Git repositories use the automation's isolation workflow; non-Git folders have different working-folder behavior.

**Why use it:** Keep unattended tasks within a chosen scope and prevent repeated jobs from consuming unlimited resources or overlapping unintentionally.

### 5.3 Run history and output

Each automation has run history, status, output, and an agent summary. Runs can show that they are queued, active, awaiting permission, completed, failed, or timed out.

**Why use it:** Check whether the task succeeded and inspect what happened. An automation's existence does not mean its most recent run completed successfully.

## 6. Work: complete tasks through conversation

### 6.1 Conversations and follow-up requests

Work keeps the question, responses, tool activity, and delivered files together. You can ask a follow-up to refine an answer or update a deliverable instead of starting again.

**Why use it:** Founders, analysts, writers, and developers can work toward an outcome such as a brief or analysis through an ordinary conversation.

### 6.2 Search, rename, pin, archive, and delete

Local Work conversations can be searched, renamed, pinned, archived, restored, or deleted. The sidebar distinguishes pinned and recent conversations; a workspace view groups local conversations by folder.

**Why use it:** Keep active work close and older work findable. Cloud history has its own available actions and is kept separately; see the Enterprise guide.

### 6.3 Choose a working folder and attach context

Local Work can use a selected folder. You can mention files or folders and provide supported attachments so the request refers to specific material. Workspaces settings let you name, group, pin, find, and relink saved folders.

**Why use it:** Keep a client's documents or a project's source material together and avoid repeatedly selecting the same location. Selecting a local folder does not upload it into Cloud.

### 6.4 Choose a provider and model

Work has its own provider connections and model selection. Supported providers may offer several connections or compatible endpoints; Enterprise can supply company-managed choices.

**Why use it:** Select a suitable model for drafting, reasoning, or analysis. Work connections and plugins are managed separately from Code's CLI configuration.

### 6.5 This computer or Cloud

The new-conversation composer offers **This computer / Cloud** when Cloud is available. This computer uses local Work resources; Cloud uses the enrolled company's services and cloud files. A conversation keeps its chosen location.

**Why use it:** Choose where a task's working state belongs. Local execution can still call an online model or connected service; it does not automatically mean offline processing.

### 6.6 Web research and reading sources

Work can search the public web when the research capability is available and read supported public pages. Connected research plugins provide another route to source material.

**Why use it:** Gather information for a decision or document and ask for links and source-based explanations. Search availability and service quotas vary; important claims still need source review.

### 6.7 Tool activity and task progress

Work shows tool activity, results, thinking/progress disclosures, and delivered-file links alongside the answer. You can expand details when you need to understand a step.

**Why use it:** See whether Lori is reading sources, processing a document, or waiting for a decision. A progress message is not proof that a file has been saved; use the delivered file and its preview.

### 6.8 Ask Me and Approve for Me

**Ask Me** requests decisions before applicable commands, file changes, and external actions. **Approve for Me** automatically handles eligible approvals under the same underlying scope checks. Your organization may require Ask Me.

**Why use it:** Choose the level of involvement appropriate to a task. Review staged document changes when prompted; permission to run a task can be separate from permission to apply its output.

### 6.9 Stop, reconnect, and continue

Work provides Stop for an active response and shows interrupted or failed states. Cloud reconnects can recover saved run state; a follow-up can continue from the visible result.

**Why use it:** Recover from a disconnected network or redirect a task. Stopping a run cannot undo a completed external action, and an uncertain external write is not automatically repeated.

## 7. Work: create, inspect, and edit files

### 7.1 The document workspace

Delivered files open in the existing **Files** area with file tabs, previews, and appropriate editing controls. You can keep the conversation and the document visible together and expand the document view.

**Why use it:** Review the actual result while asking for improvements. Work's file area is the common destination for documents, data files, and saved visuals.

### 7.2 Word documents, reports, and PDFs

With a capable document runtime, Work can create and revise Word documents and PDFs, inspect existing documents, convert supported files, and render pages for review. Ask for the audience, structure, and style you need.

**Why use it:** Produce a report, proposal, letter, or company brief as a usable file. Viewing a Word file here is primarily page-based; it is not a full word-processing ribbon. Changes can be requested through chat.

### 7.3 Spreadsheets and data analysis

Work can create or analyze spreadsheets and delimited data. Local Work provides sheet inspection and chat-requested revisions. In browser Cloud Work and supported desktop shared projects, compatible XLSX files also provide a grid with sheet selection, a formula bar, cell editing, copy/paste, undo/redo, and guarded saving when permitted.

**Why use it:** Inspect a forecast or dataset and adjust supported cells without leaving the task. Unsupported workbook features or calculations may use stored values or a page-preview fallback; this is not a guarantee of full Excel compatibility.

### 7.4 Presentations and page previews

Work can create and revise presentation files through its document tools. Supported presentations open as rendered slides, with navigation and zoom. PDF and other supported Office formats use appropriate page previews too.

**Why use it:** Check the content and layout of a deck, then ask Lori to revise it. The preview is for review, rather than a complete slide-design editor.

### 7.5 Text, Markdown, code, images, and delimited files

The file workspace provides source/edit and preview modes appropriate to supported formats. This includes rendered Markdown, text/code editing, images, and CSV/TSV views. Office-format preview availability depends on the runtime.

**Why use it:** Work with the actual source material and deliverables in one place, including ordinary files that do not need a document-generation tool.

### 7.6 Versions, comparisons, and safe saves

File workflows retain version information and compare/save controls where supported. Cloud edits check the version you opened, and local document workflows use their own revision checks. Conflicts should be resolved before replacing newer content.

**Why use it:** Review changes and avoid silently overwriting another edit. Keep the old result when asking for a new variation unless you want an in-place revision.

### 7.7 Download or open a file elsewhere

File actions let you export/download or open a local deliverable externally where supported and permitted. Shared projects can restrict downloads separately from viewing.

**Why use it:** Take the completed document into a meeting, another application, or an existing company process. A file you explicitly export is a separate copy.

## 8. Work: explain information visually

Ask naturally for a visual when it helps the task. A quick visual can appear in the answer; a reusable one can be saved as a `.lori.json` file and opened through the same file workspace. Follow-up changes stay in the conversation.

| Visual feature | What it does | Useful for |
| --- | --- | --- |
| **Diagrams** | Show connected steps or relationships; open a larger view for closer inspection. | Explaining a process, system, or decision flow. |
| **Mind maps** | Organize ideas in a parent-and-child tree. | Exploring a topic, planning content, or structuring notes. |
| **Timelines** | Lay out events or milestones in sequence. | Explaining a history, rollout, or project progression. |
| **Charts** | Plot supplied values for comparison or change over time. | Comparing results or explaining a dataset. |
| **Tables** | Present structured rows and columns. | Comparing choices or organizing reference information. |
| **Metrics** | Highlight a small set of values and their context. | Making key results easy to scan. |
| **Step guides** | Break a process into ordered steps. | Explaining a workflow or teaching a procedure. |
| **Calculators** | Let a reader vary supported inputs and see derived results. | Exploring assumptions or a simple business scenario. |
| **Simulations** | Show bounded scenarios with inputs and a shared time/playback view. | Understanding how a relationship changes over time. |
| **Quizzes** | Present questions and answer feedback. | Practicing material from selected sources. |
| **Flashcards** | Show question-and-answer cards for review. | Revising terminology, concepts, or facts. |

Controls explore the displayed data locally; they do not themselves change company records or call an external service. Check the underlying values and cited source material before relying on a generated visual.

## 9. Work: connect services and remember context

### 9.1 Work plugins

Work's bundled catalog includes Notion, Linear, GitHub, Slack, Asana, ClickUp, Miro, Intercom, Sentry, and Exa. Connect an eligible account through the indicated sign-in or token flow, inspect available tools, and manage connection status.

**Why use it:** Bring knowledge, issues, messages, support context, or research into a task. Available operations depend on the service account, plugin, and organization policy. Some services require an administrator-registered app.

### 9.2 Built-in task skills

Bundled skills guide activities such as research, document writing, spreadsheets, presentations, and PDFs. They supply task-specific instructions when enabled and available.

**Why use it:** Give Lori a repeatable approach to common deliverables. Work uses its bundled skills catalog; it does not automatically import Code's custom marketplace skills.

### 9.3 Personal and workspace memory

Work can retain useful facts, preferences, decisions, goals, and outcomes. Memory settings separate personal context from local workspace context and allow you to search, add, edit, and inspect notes and their sources.

**Why use it:** Avoid repeatedly explaining stable preferences or project background. Memory provides context, not authority to take an action.

### 9.4 Learning from earlier conversations

**History & learning** lets you select earlier conversations for learning and review background processing, usage, failures, retries, and stop actions.

**Why use it:** Bring relevant earlier work into memory deliberately. Processing can use additional model tokens; existing notes remain available if a learning job needs attention.

### 9.5 Forgetting and memory controls

You can forget notes and manage excluded topics and conversations. Memory can also be disabled; organization policy can prevent recall and learning while preserving saved notes.

**Why use it:** Keep retained context relevant and under control. Forgetting a memory and deleting visible chat history are different actions.

### 9.6 Shared Enterprise projects

When enabled for your company and granted to you, Cloud Work includes shared projects. Authorized colleagues can use project conversations, files, instructions, connections, and memory from the browser or enrolled desktop.

**Why use it:** Work on a shared initiative without copying context between personal chats. Read [the Enterprise guide](LORI_ENTERPRISE.md) for roles, sharing, and management controls.

## 10. Settings, usage, and everyday controls

| Feature | What it does and why you use it |
| --- | --- |
| **Account and Enterprise connection** | Sign in, inspect account/connection state, and connect or disconnect the installation from a company. Personal sign-in and Enterprise enrollment are separate access paths. |
| **Appearance** | Choose theme, color, and text presentation. Appearance is shared across Code and Work on the device. |
| **Workspace defaults** | Set the default coding tool, shared/worktree behavior, branch defaults, worktree location, and related session preferences. |
| **Environment variables** | Set variables used by new agent sessions and apply supported native configuration changes. Useful for a consistent development environment. |
| **Agent and terminal settings** | Configure executable/config paths, coordination, terminal font, line spacing, scrollback, and auto-fit behavior. |
| **Source Control settings** | Manage Git provider connections, clone protocol, and supported merge preferences. |
| **Desktop behavior** | Configure close-window behavior, tray visibility, notifications, launch at login, and idle suspension where supported. |
| **Usage** | Review local agent token totals, activity heatmap, and trends; inspect configuration activity and usage privacy controls. Provider costs and token reporting can be incomplete. |
| **Keyboard and layout controls** | Resize/collapse sidebars, navigate tabs, and use shortcuts to reach sessions, search, Settings, or Changes. These reduce repeated mouse navigation. |
| **About, updates, and What's New** | Check the app version, check/install supported updates, and review release notes. |

## 11. Two everyday examples

### A developer fixing a bug

1. Open the repository in Code and start a session, choosing a separate worktree if appropriate.
2. Select an agent, mention the relevant files, and ask it to investigate the bug.
3. Answer questions and inspect the proposed edits in Files and Changes.
4. Run the project's checks, review the diff, then use the available Git/change-request actions to deliver the fix.

### A founder preparing a report

1. Open Work, choose the working location and model, and provide the relevant files or service context.
2. Ask for the report with a clear audience, purpose, and desired file format.
3. Review requested actions and open the delivered file in Files.
4. Ask for corrections, inspect the revised pages, and export the version you want to share.

## 12. Availability and source notes

This guide describes the current implementation reviewed on **22 October 2026**. Installed-build features, agent capabilities, connected services, document runtime support, and company permissions determine what an individual user sees. Enterprise Projects require company enablement. User-visible previews do not imply full editing support for every file format.

Source areas checked: [application shell and Code interface][code], [agent conversation controls][agent-ui], [Chat interface][chat], [extensions and skills][extensions], [providers][providers], [automations][automations], [settings][settings], [Work interface][work], [native Work tools][tools], and [Work artifact behavior][artifacts]. Developer setup remains in the [desktop repository README][developer-readme].

[code]: https://github.com/loridotsh/lori/tree/f1f24c868ecd63b56eb3b31463d3769f09489512/src/components
[agent-ui]: https://github.com/loridotsh/lori/tree/f1f24c868ecd63b56eb3b31463d3769f09489512/src/components/agent-ui
[chat]: https://github.com/loridotsh/lori/tree/f1f24c868ecd63b56eb3b31463d3769f09489512/src/chat
[extensions]: https://github.com/loridotsh/lori/tree/f1f24c868ecd63b56eb3b31463d3769f09489512/src/components/marketplace
[providers]: https://github.com/loridotsh/lori/tree/f1f24c868ecd63b56eb3b31463d3769f09489512/src/components/providers
[automations]: https://github.com/loridotsh/lori/tree/f1f24c868ecd63b56eb3b31463d3769f09489512/src/components/automations
[settings]: https://github.com/loridotsh/lori/tree/f1f24c868ecd63b56eb3b31463d3769f09489512/src/components/settings
[work]: https://github.com/loridotsh/lori/tree/f1f24c868ecd63b56eb3b31463d3769f09489512/src/work
[tools]: https://github.com/loridotsh/lori/tree/f1f24c868ecd63b56eb3b31463d3769f09489512/src-tauri/src/work/tools
[artifacts]: https://github.com/loridotsh/lori/blob/f1f24c868ecd63b56eb3b31463d3769f09489512/docs/WORK_ARTIFACTS.md
[developer-readme]: https://github.com/loridotsh/lori/blob/f1f24c868ecd63b56eb3b31463d3769f09489512/README.md

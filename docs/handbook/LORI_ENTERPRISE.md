# Lori Enterprise guide

What the company platform does, who uses it, and how its features work together.

## Contents

- [Why Lori Enterprise exists](#1-why-lori-enterprise-exists)
- [People, teams, and devices](#2-people-teams-and-devices)
- [Access and resource assignments](#3-access-decide-which-resources-people-receive)
- [Company AI providers and Work controls](#4-company-ai-providers-and-work-controls)
- [Cloud Work](#5-cloud-work-complete-a-task-in-the-company-workspace)
- [Shared Projects](#6-shared-projects-work-with-colleagues)
- [Usage and audit](#7-usage-and-audit-understand-company-activity)
- [Retention, accounts, and company operation](#8-retention-accounts-and-company-operation)
- [Everyday examples](#9-two-everyday-examples)
- [Availability and sources](#10-availability-and-source-notes)

## 1. Why Lori Enterprise exists

A company needs more than a collection of individually configured AI tools. It needs to know who has access, which tools and models people may use, how company credentials are protected, and how access ends when a device or employee leaves.

Lori Enterprise gives the company a self-hosted place to manage those decisions. It also provides **Cloud Work**, where people complete tasks through the browser or an enrolled Lori desktop, and **shared Projects**, where authorized colleagues work with the same context.

Administrators and IT use Enterprise to manage access. Members use the resources their company makes available. Founders and team leads use its controls and aggregate reporting to understand how Lori is used across the company.

### Manage and Work

| Area | What you do there |
| --- | --- |
| **Manage** | Administer people, teams, devices, access rules, providers, Work availability, Projects, usage, and audit activity. |
| **Work** | Have private or shared-project conversations, attach files, use permitted models/tools, and review completed work. |

Switching these views changes what you are looking at. Your account's actual permissions determine what you can do.

### How the products connect

1. The company runs its Enterprise deployment at its own address.
2. An administrator invites a member and assigns access directly or through teams.
3. The member joins in the browser and deliberately connects a Lori desktop installation if needed.
4. Enterprise supplies the installation with its effective company configuration.
5. The member uses permitted Code and Work resources; Cloud Work keeps its state in the company deployment.
6. Saved access changes reach connected clients. Server-side company-provider and Cloud requests check current permission when used.

## 2. People, teams, and devices

### 2.1 Company setup

The first administrator creates the company and their account using a one-time setup token supplied by the installation operator. One Enterprise deployment represents one company.

**Why use it:** Establish a clear owner for the installation without shipping a permanent shared administrator password. Members subsequently join through invitations.

### 2.2 Invite people and manage invitations

**People** creates email-bound invitation links and shows pending invitations. Administrators copy/share links, regenerate them when necessary, or revoke them. Invitations expire and are single-use; the current product does not automatically email them.

**Why use it:** Bring the intended person into the company deliberately and remove outstanding links that should no longer work.

### 2.3 Member accounts, organization roles, and removal

People lists members and their organization roles. Administrators can manage supported role changes and remove a person. Removal revokes company access, active sessions, device authority, and team membership for that person.

**Why use it:** Keep access aligned with who currently works at the company. Removing company access does not remotely erase every personal file on a member's computer.

### 2.4 Teams and scoped team administrators

Teams group members and provide team-level assignments and exceptions. A team administrator manages the team-scoped operations delegated to them; organization administrators retain broader administration.

**Why use it:** Give Engineering, Operations, or another group the resources it needs without editing every person individually. Belonging to several teams can contribute several grants.

### 2.5 Connect a Lori desktop

A signed-in member selects the desktop connection action, opens Lori, and approves the named installation through the browser flow. That installation becomes associated with the company and member.

**Why use it:** Receive the company's managed resources without manually distributing company API keys or repeatedly configuring each agent. The user deliberately approves the connection.

### 2.6 Device inventory, synchronization, and revocation

**Devices** shows enrolled installations, connection/synchronization information, and available revocation actions. Members see their authorized device view; administrators can manage company device access.

**Why use it:** Check which installation is connected, investigate a configuration problem, or revoke a lost or retired device. Revocation withdraws its company authority; it is not operating-system device management.

### Understand the different roles

| Role | What it means |
| --- | --- |
| **Organization administrator** | Manages company-wide identity, policy, providers, and administration. |
| **Member** | Uses company resources according to effective access. |
| **Team administrator** | Has specific management rights within the assigned team. This does not make the person an organization administrator or project manager. |
| **Project Viewer, Contributor, or Manager** | Defines participation in a particular shared project, subject to further restrictions. These roles are explained below. |

## 3. Access: decide which resources people receive

### 3.1 Managed apps, plugins, skills, and providers

**Access** manages company assignments from the supported catalog. Assignments can be made at organization or team scope, with member-level decisions where supported. The enrolled desktop receives the effective result.

**Why use it:** Make approved resources available consistently instead of asking everyone to assemble the same setup independently.

### 3.2 Personal configuration boundaries

Company policy can allow or restrict personal apps/MCP plugins, AI providers, and skills. Managed assignments remain distinct from permission to add personal items.

**Why use it:** A company can provide approved tools while deciding how much personal customization is appropriate. Restricted personal items are kept locally rather than silently deleted, but are excluded from the managed experience when denied.

### 3.3 Organization, team, and member decisions

For Code catalog/personal-access policy, organization and team grants combine; an explicit global member decision resolves last. A team-member exception changes that team's contribution rather than automatically removing another team's grant.

**Why use it:** Understand why someone still has access after one assignment changes. For example, removing a team's plugin grant does not remove a separate organization grant. Use the effective-access explanation before assuming the final result.

### 3.4 Effective access and source explanations

Member and team views explain the resulting access and where it came from: the organization, a team, or an explicit member exception. Preview controls help administrators inspect the effect of a decision.

**Why use it:** Answer a practical question such as, "Why can this person use this provider?" without guessing from one policy screen.

### 3.5 Save and apply policy changes

Policy editors require an explicit save. If the saved policy changes while an administrator is editing, the interface supports reviewing/reloading the latest state instead of silently overwriting it. Connected desktops then refresh their effective configuration.

**Why use it:** Administrators can review a change's scope and avoid accidentally undoing another administrator's work. Company gateway and Cloud permissions are also enforced on the server.

## 4. Company AI providers and Work controls

### 4.1 Company-owned provider connections

Administrators connect a supported provider using a company API key. Enterprise stores the upstream secret on the server and supplies controlled access to authorized clients; members do not receive that upstream key.

**Why use it:** People can use company AI access without sharing a long-lived company secret across their computers. A connection must also be assigned to the relevant product/users.

### 4.2 Allowed models and request limits

Provider settings restrict available models and configure supported request limits. The company gateway checks the member, device, provider assignment, model, and current policy for an allowed request.

**Why use it:** Make model selection intentional and limit misuse. Request limits and estimated usage are different from a centralized billing budget or provider invoice.

### 4.3 Separate Code and Work assignments

Code and Work have separate access decisions even when they use a related company provider connection. Work's provider/model assignments are managed through its own controls.

**Why use it:** A company can enable a model for Work without assuming that every coding agent should use it. Seeing a connected provider does not by itself prove Work has an assigned model.

### 4.4 Allow Work and control personal additions

**Manage Work** controls whether members can use Work and whether they may add their own Work providers, plugins, and bundled skills. Team/member views expose the relevant scoped contributions or exceptions.

**Why use it:** Roll out Work to the right people and decide how much customization they receive. Cloud Work availability follows effective Work access; there is no independent Cloud enable switch to maintain.

### 4.5 Require approvals and allow memory

Organization safeguards can require action approvals even when a member prefers automatic approval. They can also disable Work memory recall and learning while preserving saved notes and personal preferences.

**Why use it:** Set a company-wide safeguard around commands, file changes, external writes, or retained context. A member preference cannot bypass an enforced safeguard.

### 4.6 Assign Work plugins and skills

Work management assigns the supported plugins and task skills. Plugin assignment makes a service eligible; the appropriate person or project still needs to connect an account before its tools can be used.

**Why use it:** Provide approved capabilities without confusing tool permission with access to a specific external account.

## 5. Cloud Work: complete a task in the company workspace

### 5.1 Private conversations and history

Browser Work provides a conversation sidebar, provider/model selection, a message composer, streaming replies, tool activity, and Files. Private history can be revisited, filtered within the available history, renamed, or deleted.

**Why use it:** Members can complete their own tasks inside the company deployment. Ordinary administration does not turn all private conversations into a team inbox.

### 5.2 Upload files and mention the relevant material

Members explicitly upload or attach supported files and select them as context. Files are listed in the authorized conversation or project scope and opened in the appropriate preview/editor.

**Why use it:** Give Lori the actual material for a report or analysis. A local desktop folder is not automatically available in Cloud.

### 5.3 Documents, spreadsheets, presentations, and visuals

Cloud Work uses the same general task model as desktop Work: request a result, review actions, inspect the file, and ask for refinements. Qualified workers support document generation/conversion; the interface provides supported document previews, text editing, compatible spreadsheet editing, and structured visuals.

**Why use it:** Work on company deliverables from the browser as well as desktop. [The application guide](LORI_APPLICATION.md#7-work-create-inspect-and-edit-files) explains each document feature and [the visual catalog](LORI_APPLICATION.md#8-work-explain-information-visually) explains the available visual formats.

### 5.4 Approvals and review of generated changes

Cloud Work offers Ask Me and eligible automatic approval under company policy. Commands and document work can produce staged outputs that need a separate review/apply decision before becoming final workspace changes.

**Why use it:** Inspect what will run and which file bytes will be applied. Approval is tied to the requested action; an old approval is not blanket permission for a different action.

### 5.5 Connected services and bundled skills

Cloud members connect their authorized accounts through Work's Plugins area. The catalog includes the supported knowledge, issue-tracking, development, communication, support, and research services listed in the application guide. Bundled skills guide common tasks.

**Why use it:** Combine company-approved tools with the account access needed for a real task. Cloud plugin connections are separate from a member's local desktop connections.

### 5.6 Cloud memory settings

Cloud Work has its own memory settings and personal/current-conversation scopes. Members can review, search, add, edit, or delete notes and mark sensitive material for manual review where offered.

**Why use it:** Retain useful context without treating local memory, private Cloud memory, and shared-project memory as one common store.

### 5.7 Use the same Cloud task on an enrolled desktop

An enrolled desktop can select Cloud in Work and access that member's Cloud conversations, activity, approvals, and files. Cloud plugin connections, memory, and retention management use the relevant browser settings.

**Why use it:** Begin in the browser and continue on desktop without manually copying the task. Local Work remains a separate location with separate resources.

### 5.8 Stop, reconnect, and preserve partial progress

Cloud run state is saved by the company service. Reconnecting can recover recorded messages and activity; Stop requests cancellation. Interrupted and uncertain outcomes remain visible.

**Why use it:** A temporary connection loss does not require pretending the task never started. An external action whose outcome is unknown is not automatically repeated.

## 6. Shared Projects: work with colleagues

Projects are available only when enabled for the deployment and granted to the member. Desktop project access also requires its compatible rollout to be enabled.

### 6.1 Project discovery and creation

**Work > Projects** shows the projects you may discover and the management actions you may perform. Administrators can inspect the company inventory; delegated users see their permitted projects. Management views support search and status/assignment filters.

**Why use it:** Find a shared initiative and create a project when authorized. Project-creation delegation and team administration are separate permissions.

### 6.2 Project details and instructions

A project has a name, description, and instructions guiding Lori's work in that scope. Authorized users can update those details through the project's permitted settings.

**Why use it:** Keep stable context for an initiative, such as its audience, purpose, and working expectations. Instructions guide responses; they do not override company permissions.

### 6.3 Shared conversations and files

Authorized project readers share project conversations and the project's Files area. Contributors can participate according to their granted actions. Deleting a normal project conversation does not delete the project's shared file collection.

**Why use it:** Let colleagues build on the same discussion and source files. Use separate projects for separate confidentiality boundaries: project content is not private to the person who created a chat.

### 6.4 Viewer, Contributor, and Manager roles

**Viewer** provides project reading. **Contributor** adds normal participation such as chat and permitted file/tool actions. **Manager** has a broader action set, still limited by project restrictions and explicit delegation for access/connections.

**Why use it:** Match responsibility to the task. A role name alone does not guarantee every action; downloads, external changes, and management can be restricted further.

### 6.5 Team grants, direct grants, blocks, and permission previews

Projects can grant access to teams or individual members, apply action restrictions, and explicitly block a member. Management includes inspecting effective access before relying on a grant.

**Why use it:** Share with a working group while handling individual exceptions. An explicit block removes project access even if a team would otherwise grant it.

### 6.6 Shared project memory and recall

Project memory retains permitted notes and supports recall from that project's authorized material. Appropriate settings expose note management; project conversations can use the shared context.

**Why use it:** Preserve decisions for the team without relying on one member's personal memory. Notes and recall stay within their project scope.

### 6.7 Dedicated project connections

Project connections are configured specifically for the project. Access to member-private or local accounts is not inherited automatically. Administrators can delegate connection management within the allowed boundaries.

**Why use it:** A shared task uses an account deliberately chosen for that project rather than whichever personal account a contributor happens to have connected.

### 6.8 Project safeguards and model/plugin restrictions

Project permissions control memory, required Ask Me decisions, downloads, external changes, and delegated access/connection management. Projects can further restrict eligible models and plugins; members still need the underlying company access.

**Why use it:** Tighten the environment for a particular initiative. A project setting does not grant a model or external tool that the company denies.

### 6.9 Shared-file conflicts and downloads

File saves check the version being edited. A stale save is refused so a member can resolve the conflict. Downloading requires the project's export permission; viewing and exporting are distinct capabilities.

**Why use it:** Protect colleagues' edits and control which shared content can be copied out. An already exported file is outside later managed revocation.

### 6.10 Archive, restore, and delete

Archiving keeps project content readable while stopping changes. Lifecycle controls can restore or delete a project when authorized. Deleted-project recovery is available for up to 30 days, bounded by organization retention.

**Why use it:** Close completed initiatives without immediately losing their reference material, and distinguish an archive from a deletion.

### 6.11 Administration without automatic content access

Administrators can manage project inventory, permissions, and lifecycle without automatically reading its conversations or files. A separate reason-bound, audited, temporary read-access mechanism exists for authorized administrative investigation.

**Why use it:** Separate operating the company system from opening a project's content. Hosting operators still have infrastructure-level responsibilities and access outside the ordinary application interface.

## 7. Usage and audit: understand company activity

### 7.1 Organization and Work usage views

Usage views report available token aggregates, activity over time, model/agent breakdowns, and estimated costs. Work usage includes its enrolled-desktop and Enterprise Cloud sources. Filters and member drill-downs help explain a selected period.

**Why use it:** Founders, administrators, and permitted members can understand adoption and usage patterns. Missing provider counters or prices remain incomplete/unpriced rather than becoming an exact bill.

### 7.2 Member rankings, visibility, and CSV export

Administrators can inspect member-level aggregates and configure whether a member sees their own usage. Relevant usage views provide CSV export. Collection and personal visibility are separate decisions.

**Why use it:** Review usage and share an analysis without confusing a hidden member view with stopped company collection.

### 7.3 Usage collection, retention, and deletion

Usage settings control collection, visibility defaults, and retained aggregate history. Available deletion actions remove organization or member usage history through explicit confirmation.

**Why use it:** Decide how long aggregate reporting is useful and remove it when required. Usage collection excludes prompts, responses, file paths, document contents, and credentials; it is not a conversation-content reporting feature.

### 7.4 Audit log and filtered export

**Audit log** records security and administration activity, with actor/action/resource search, action filters, pagination, and a filtered CSV export. Examples include enrollment, access changes, and supported administrative actions.

**Why use it:** Answer who changed access or performed an administrative operation. The audit log is not a transcript of every prompt or file's contents.

## 8. Retention, accounts, and company operation

### 8.1 Cloud conversation retention

Administrators configure Cloud retention separately from usage-aggregate retention. The current conversation-retention range is 1 to 365 days; project lifecycle recovery remains bounded by the applicable retention policy.

**Why use it:** Keep work available for an appropriate period and make its eventual removal intentional.

### 8.2 Account, sign-out, and appearance

Browser account controls manage the signed-in session, and theme controls support light, dark, or system appearance. Members see the access/settings destinations appropriate to their role.

**Why use it:** Keep a shared browser session under control and choose a readable working environment.

### 8.3 Installation, recovery, and upgrades

Operators install the company stack, manage its address/HTTPS, recover administrator access through the operator procedure, and maintain coordinated backups and upgrades. Cloud files and secrets/keys are part of recoverable company state, alongside the database.

**Why use it:** Keep the product usable after a server failure or staff change. Detailed commands belong in the installation/operator documentation rather than in everyday feature instructions.

## 9. Two everyday examples

### Onboard an employee

1. An administrator creates an invitation in People and shares the link with the intended person.
2. The member joins; the administrator adds the appropriate teams and assignments.
3. The member approves their desktop connection and receives effective company configuration.
4. The administrator checks device state and, for Work, confirms that the intended provider/model is assigned.

### Run a shared company initiative

1. An authorized person creates a project and adds its purpose and instructions.
2. The administrator or delegated manager grants the appropriate team/member roles and dedicated connections.
3. Contributors work in project conversations, review proposed actions, and inspect shared files; viewers read the permitted results.
4. Managers resolve access or file-conflict issues, then archive the project when the initiative finishes.

## 10. Availability and source notes

This guide describes the current implementation reviewed on **22 October 2026**. Deployment/build compatibility, Work policy, project enablement, role, assigned models, connected accounts, and worker capabilities determine what is available. The older published v0.1.2 installation package predates the current Cloud Work worker; operators need a compatible current release/build for those features.

The current product does not provide SSO, automatic invitation email, self-service password-recovery email, a full Office editing suite, or centralized provider billing budgets. These should not be presented as existing functionality.

Source areas checked: [Enterprise purpose][purpose], [interface routes][routes], [access and Work controls][controls], [identity/provider services][identity], [Cloud and project implementation][cloud-source], [project roles][roles], [Cloud behavior][cloud-guide], and [installation boundary][setup]. Developer setup remains in the [Enterprise repository README][developer-readme]; operating procedures are in the [operator guide][operator].

[purpose]: ../../PRODUCT.md
[routes]: ../../apps/web/src/app
[controls]: ../../apps/web/src/components
[identity]: ../../apps/api/src/auth
[cloud-source]: ../../apps/api/src/cloud
[roles]: ../../apps/api/src/cloud/projects/policy.ts
[cloud-guide]: ../WORK_CLOUD.md
[setup]: ../SETUP.md
[developer-readme]: ../../README.md
[operator]: ../../deploy/OPERATOR.md

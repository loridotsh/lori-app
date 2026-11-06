"use client";
import { trackVisibleConversation } from "../notifications/activity";

import type { ProjectNavigationContext } from "./projects/project-navigation";

import type {
  CloudConversationPage,
  CloudRunSnapshot,
  CloudSendMessage,
  CloudSubmitResponse,
  Viewer,
  CloudFile,
  CloudProjectDetail,
  PersonalProject,
  ProjectCapabilities,
} from "@lori-enterprise/contracts";
import Link from "next/link";
import {
  CheckIcon,
  CopyIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PaperclipIcon,
  MenuIcon,
  PanelLeftIcon,
  PlusIcon,
  PlugIcon,
  SearchIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AccountMenu, accountName } from "@/components/account-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { LoriLogo } from "@/components/lori-logo";
import { ResizableWorkSidebar } from "./resizable-work-sidebar";
import { mergeConversationHistory } from "./conversation-history";
import { CloudFiles, type OpenRequest } from "./cloud-files";
import { GeneratedMedia, previewMode } from "./files/file-preview";
import { CloudComposer } from "./cloud-composer";
import { useConversationFind } from "./find/useConversationFind";
import { captureScrollAnchor } from "./find/textMatches";
import { ConversationFindBar, ConversationFindHighlights, ConversationFindToggle, findHighlightClasses } from "./find/ConversationFind";
import { useConversationScroll } from "./use-conversation-scroll";
import { CloudApprovalControl } from "./cloud-approval-control";
import { mergeHistoryPage } from "./activity/history-page";
import { buildTranscript } from "./activity/transcript";
import { AssistantFlow } from "./activity/assistant-flow";
import { KNOWN_PLUGIN_NAMES } from "./activity/tool-presentation";
import { CloudDestinations } from "./cloud-destinations";
import { MoveConversationDialog } from "./personal/move-conversation-dialog";
import { ClientApiError } from "@/lib/client-api";
import {
  applyCloudEvent,
  cloudApi as baseCloudApi,
  cloudError,
  cloudMutation,
  cloudRunProblem,
  isActiveRun,
  readCloudEvents,
  validateCloudCapabilities,
  validateCloudConversation,
  validateCloudConversationPage,
  validateCloudSubmitResponse,
  validateCloudFile,
  validateCloudDetail,
  validateCloudSnapshot,
  defaultModelId,
  type CloudCapabilities,
  type CloudConversation,
  type CloudDetail,
  type CloudStreamState,
} from "@/lib/cloud-work-api";
import { cn } from "@/lib/utils";
import { RunProblemNotice, ThinkingIndicator } from "./cloud-run-status";
import { ConversationStatus } from "./conversation-status";
import { UserMessageText } from "./cloud-user-message";
import type { UploadProgress } from "./composer/attachment-chips";
import {
  describeRejections,
  MAX_UPLOAD_BYTES,
  prepareUploads,
} from "./composer/file-kinds";
import { DropOverlay, useFileDrop } from "./composer/use-file-drop";

type ActiveStatus = "queued" | "running" | "awaitingApproval";
const field =
  "min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-55";
const runLabel = {
  queued: "Waiting for the worker",
  running: "Responding",
  awaitingApproval: "Waiting for your approval",
  completed: "Completed",
  cancelled: "Stopped",
  failed: "Response failed",
  interrupted: "Response interrupted",
};
type Attempt = { conversationId: string; request: CloudSendMessage };

const WORK_OFF_ROUTE = "/work?cloud=off";
/** 403s that refuse one feature while the session and Work access stay valid. */
const NARROW_REFUSALS = new Set([
  "admin_required",
  "cloud_memory_disabled",
  "cloud_model_denied",
  "cloud_extension_policy_denied",
  "cloud_extension_disabled",
]);
const WORK_OFF_REASON =
  "Work is turned off for your account. An administrator can turn it on in Work access.";

export interface PersonalWorkspaceBinding {
  /** Changing the selected panel activates it from any workspace destination. */
  panelProjectId: string | null;
  /** New conversations started from the composer are filed in this personal project. */
  newChatProjectId: string | null;
  /** Active projects a conversation can be moved into. */
  projects: PersonalProject[];
  /** Instructions and files of a project, shown in place of the conversation. */
  panel: ((onDirtyChange: (value: boolean) => void, onBusyChange: (value: boolean) => void) => ReactNode) | null;
  onClosePanel: () => void;
  /** The member started an unfiled conversation. */
  onNewConversation: () => void;
  /** A conversation was filed, moved or created. */
  onConversationChanged: (conversation: CloudConversation) => void;
}

export interface WorkspaceBootstrap {
  capabilities: CloudCapabilities;
  detail: CloudDetail | null;
  files: CloudFile[];
}

export function CloudWorkspace({
  admin,
  viewer,
  projectCapabilities,
  project,
  projectNavigation,
  initialConversationId,
  initialConversations,
  initialSidebarCollapsed = false,
  onSidebarCollapsedChange,
  sidebarScroll,
  bootstrap,
  onProjectAccessLost,
  onPrivateConversation,
  projectSettings,
  personal,
  onWorkOff = () => window.location.replace(WORK_OFF_ROUTE),
}: {
  admin: boolean;
  /** Personal projects: owner-only folders over this member's private conversations. */
  personal?: PersonalWorkspaceBinding;
  viewer?: Viewer;
  projectCapabilities?: ProjectCapabilities | null;
  project?: CloudProjectDetail;
  initialConversationId?: string;
  initialConversations?: CloudConversationPage;
  initialSidebarCollapsed?: boolean;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
  sidebarScroll?: { current: number };
  bootstrap?: WorkspaceBootstrap;
  onProjectAccessLost?: () => void;
  onPrivateConversation?: () => void;
  projectNavigation?: (beforeNavigate: () => boolean, context: ProjectNavigationContext) => ReactNode;
  projectSettings?: (onDirtyChange: (value: boolean) => void, onBusyChange: (value: boolean) => void) => ReactNode;
  /** Called once when Work is definitively off. Defaults to leaving for the Work access page. */
  onWorkOff?: () => void;
}) {
  const newChatProjectId = personal?.newChatProjectId ?? null;
  const cloudApi = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    if (!project) {
      // A chat started inside a personal project is created there, so it is never briefly unfiled.
      if (newChatProjectId && path === "/conversations" && init?.method === "POST")
        return baseCloudApi<T>(`/personal-projects/${encodeURIComponent(newChatProjectId)}/conversations`, init);
      return baseCloudApi<T>(path, init);
    }
    const headers = new Headers(init?.headers); headers.set("x-lori-project-id", project.id);
    const target = /^\/conversations(?:\?|$)/.test(path) ? `/projects/${project.id}${path}` : path;
    // The project header scopes /capabilities on the server to the project's assigned models.
    return baseCloudApi<T>(target, { ...init, headers });
  }, [project, newChatProjectId]);
  const closePersonalPanel = useRef(personal?.onClosePanel);
  closePersonalPanel.current = personal?.onClosePanel;
  const onNewPersonalConversation = useRef(personal?.onNewConversation);
  onNewPersonalConversation.current = personal?.onNewConversation;
  const [moving, setMoving] = useState(false);
  const canChat = !project || project.access.actions.includes("chat");
  const canExportArtifacts = !project || project.access.actions.includes("export");
  const canWriteFiles = !project || project.access.actions.includes("files.write");
  const [projectFiles, setProjectFiles] = useState<CloudFile[]>(bootstrap?.files ?? []);
  const projectCreateId = useRef<string | null>(null);
  const [view, setView] = useState<
    "conversation" | "providers" | "plugins" | "settings"
  >("conversation");
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("view") === "plugins") setView("plugins");
  }, []);
  useEffect(() => {
    if (personal?.panelProjectId) setView("conversation");
  }, [personal?.panelProjectId]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const restoreSidebarScroll = useCallback((node: HTMLDivElement | null) => {
    if (node && sidebarScroll) node.scrollTop = sidebarScroll.current;
  }, [sidebarScroll]);
  useEffect(() => { onSidebarCollapsedChange?.(sidebarCollapsed); }, [sidebarCollapsed, onSidebarCollapsedChange]);
  const [query, setQuery] = useState("");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [fileDirty, setFileDirty] = useState(false);
  const unsavedChanges = useRef(false);
  unsavedChanges.current = fileDirty || settingsDirty;
  const [filesOpen, setFilesOpen] = useState(false);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  const [attached, setAttached] = useState<Record<string, string[]>>({});
  const [uploadPending, setUploadPending] = useState<{
    file: File;
    requestId: string;
    conversationId: string;
    /** The cleaned name and media type declared, kept so a retry repeats the same request. */
    name?: string;
    mimeType?: string;
  } | null>(null);
  const [uploading, setUploading] = useState<UploadProgress | null>(null);
  const [uploadNotice, setUploadNotice] = useState("");
  const uploadInput = useRef<HTMLInputElement>(null);
  const filesToggle = useRef<HTMLButtonElement>(null);
  const accessEpoch = useRef(0);
  const [announcement, setAnnouncement] = useState("");
  const mobileSidebar = useRef<HTMLDialogElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [capabilities, setCapabilities] = useState<CloudCapabilities | null>(
    bootstrap?.capabilities ?? null,
  );
  const [conversations, setConversations] = useState<CloudConversation[]>(initialConversations?.conversations ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(initialConversations?.nextCursor ?? null);
  const [detail, setDetail] = useState<CloudDetail | null>(bootstrap?.detail ?? null);
  const currentDetail = useRef(detail);
  currentDetail.current = detail;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [gatewayId, setGatewayId] = useState(bootstrap?.capabilities.providers[0]?.gatewayId ?? "");
  const [modelId, setModelId] = useState(defaultModelId(bootstrap?.capabilities.providers[0]));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!bootstrap);
  const [operationBusy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const busy = operationBusy || fileBusy || settingsBusy;
  const [pending, setPending] = useState<Attempt | null>(null);
  const [stream, setStream] = useState<CloudStreamState>({
    sequence: 0,
    text: "",
  });
  const [streamStatus, setStreamStatus] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyRequestOwner = useRef(0);
  useEffect(() => () => { ++historyRequestOwner.current; }, []);
  const historyAnchor = useRef<{ id: string; restore: () => void } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selected = detail?.conversation.id ?? "new";
  const draft = drafts[selected] ?? "";
  const selection = useRef(0);
  const foregroundLoad = useRef<number | null>(null);
  const desiredConversation = useRef<string | null>(bootstrap?.detail?.conversation.id ?? null);
  const activeRun = detail?.runs.find(isActiveRun);
  const activeRunId = activeRun?.id;
  const streamOwner = useRef<string | undefined>(undefined);
  const visibleStreamText = streamOwner.current === activeRunId ? stream.text : "";
  const { messages, content: messageContent, following: followResponse, paused: pauseFollow, onScroll: onTranscriptScroll, remember: rememberScroll } =
    useConversationScroll(selected, detail?.messages, visibleStreamText);
  const latestRun = detail?.runs[0];
  const isEmpty = !detail?.messages.length && !activeRun;
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    const node = messages.current;
    if (anchor && node && anchor.id === detail?.conversation.id) {
      anchor.restore();
      historyAnchor.current = null;
      onTranscriptScroll();
    }
  }, [detail?.messages, detail?.conversation.id, messages, onTranscriptScroll]);
  const loadEarlierMessages = async () => {
    if (!detail?.historyCursor || loadingHistory) return false;
    const id = detail.conversation.id;
    const epoch = accessEpoch.current;
    const requestOwner = ++historyRequestOwner.current;
    setLoadingHistory(true);
    try {
      const page = validateCloudDetail(await cloudApi<CloudDetail>(`/conversations/${encodeURIComponent(id)}?before=${encodeURIComponent(detail.historyCursor)}`));
      if (epoch !== accessEpoch.current || desiredConversation.current !== id || requestOwner !== historyRequestOwner.current) return false;
      const node = messages.current;
      if (node) historyAnchor.current = { id, restore: captureScrollAnchor(node) };
      setDetail(previous => previous?.conversation.id === id ? mergeHistoryPage(previous, page, true) : previous);
      return true;
    } catch (failure) {
      if (epoch === accessEpoch.current && desiredConversation.current === id && requestOwner === historyRequestOwner.current) handleFailure(failure);
      return false;
    } finally { if (requestOwner === historyRequestOwner.current) setLoadingHistory(false); }
  };

  const find = useConversationFind({
    scope: `${project?.id ?? "private"}:${selected}`,
    enabled: view === "conversation" && !!detail && !!capabilities?.enabled && !loading,
    container: messageContent, viewport: messages,
    hasEarlier: !!detail?.historyCursor, historyKey: detail?.historyCursor ?? "",
    loadingEarlier: loadingHistory, historyPaused: operationBusy,
    loadEarlier: loadEarlierMessages,
    onInspect: () => { followResponse.current = false; rememberScroll(); },
  });
  pauseFollow.current = find.active;

  const usable =
    capabilities?.contractVersion === 1 &&
    capabilities.enabled &&
    capabilities.available &&
    capabilities.features.chat;

  const onConversationChanged = useRef(personal?.onConversationChanged);
  onConversationChanged.current = personal?.onConversationChanged;
  const updateConversation = useCallback((conversation: CloudConversation) => {
    // A chat filed in a personal project lives under that project, not in the unfiled list.
    setConversations((previous) =>
      conversation.personalProjectId
        ? previous.filter((item) => item.id !== conversation.id)
        : mergeConversationHistory(previous, [conversation]),
    );
    if (!project) onConversationChanged.current?.(conversation);
  }, [project]);
  const handleFailure = useCallback((failure: unknown) => {
    setError(cloudError(failure));
    const projectRevoked = failure instanceof ClientApiError && failure.status === 404 && failure.code === "project_not_found";
    if (projectRevoked) onProjectAccessLost?.();
    if (
      failure instanceof ClientApiError &&
      (projectRevoked || [401, 403].includes(failure.status)) &&
      // A refusal of one feature (memory, a model, an extension) is not a lost session.
      !(failure.status === 403 && NARROW_REFUSALS.has(failure.code))
    ) {
      // Cloud setup can change while a request is in flight. Withdraw private
      // data, but keep the settings needed to recover from a disabled runtime.
      // Work turned off mid-session is a definitive "off", not a lost session.
      const workDisabled =
        failure.status === 403 && failure.code === "work_disabled";
      // The server has no Cloud Work worker configured. Work itself is still
      // on, so this must never look like Work being off (which leaves the page).
      const notConfigured =
        failure.status === 403 && failure.code === "cloud_disabled";
      const setupRequired = workDisabled || notConfigured;
      setBusy(false);
      setLoading(false);
      setView((previous) =>
        setupRequired && previous === "settings" && !workDisabled
          ? previous
          : "conversation",
      );
      accessEpoch.current++;
      setAttached({});
      setUploadPending(null);
      setFilesOpen(false);
      setProjectFiles([]);
      selection.current++;
      desiredConversation.current = null;
      setPending(null);
      setDrafts({});
      setNextCursor(null);
      setGatewayId("");
      setModelId("");
      setCapabilities((previous) =>
        !previous || !setupRequired
          ? null
          : workDisabled
            ? { ...previous, enabled: false }
            : { ...previous, available: false },
      );
      setDetail(null);
      setConversations([]);
      setStream({ sequence: 0, text: "" });
    }
  }, [onProjectAccessLost]);
  const loadConversation = useCallback(
    async (id: string, background = false, signal?: AbortSignal) => {
      if (
        !background &&
        unsavedChanges.current &&
        !window.confirm("Discard your unsaved changes?")
      )
        return;
      // A stream refresh must not supersede an explicit navigation and leave it busy.
      if (
        background &&
        (foregroundLoad.current !== null || desiredConversation.current !== id)
      )
        return;
      desiredConversation.current = id;
      if (!background) {
        rememberScroll();
        closePersonalPanel.current?.();
      }
      const generation = ++selection.current;
      if (!background) {
        foregroundLoad.current = generation;
        ++historyRequestOwner.current;
        setLoadingHistory(false);
        historyAnchor.current = null;
        setBusy(true);
        setError("");
        setRenaming(false);
        setConfirmDelete(false);
        setView("conversation");
        mobileSidebar.current?.close();
      }
      try {
        const loaded = validateCloudDetail(
          await cloudApi<CloudDetail>(
            `/conversations/${encodeURIComponent(id)}`,
            { signal },
          ),
        );
        if (!signal?.aborted && generation === selection.current) {
          if (project) setProjectFiles(loaded.files ?? []);
          setDetail(previous => previous?.conversation.id === loaded.conversation.id ? mergeHistoryPage(previous, loaded) : loaded);
          const latest = loaded.runs[0];
          if (latest && !isActiveRun(latest))
            setAnnouncement(
              `Lori response ${runLabel[latest.status].toLowerCase()}.`,
            );
          updateConversation(loaded.conversation);
          return loaded;
        }
      } catch (failure) {
        if (!signal?.aborted && generation === selection.current) {
          handleFailure(failure);
          if (failure instanceof ClientApiError && [401, 403, 404].includes(failure.status))
            return null;
        }
      } finally {
        if (!background && foregroundLoad.current === generation) {
          foregroundLoad.current = null;
          if (generation === selection.current) setBusy(false);
        }
      }
    },
    [updateConversation, handleFailure, rememberScroll, cloudApi],
  );
  const load = useCallback(
    async (signal?: AbortSignal, background = false) => {
      if (!background) setLoading(true);
      const epoch = accessEpoch.current;
      setError("");
      try {
        const available = validateCloudCapabilities(
          await cloudApi<CloudCapabilities>("/capabilities", {
            signal,
          }),
        );
        if (signal?.aborted || epoch !== accessEpoch.current) return;
        setCapabilities(available);
        if (available.contractVersion !== 1 || !available.enabled) return;
        if (project) {
          const shared = await cloudApi<{ files: CloudFile[] }>(`/conversations/${project.id}/files`, { signal });
          if (!signal?.aborted && epoch === accessEpoch.current) setProjectFiles(shared.files);
        }
        const page = validateCloudConversationPage(
          await cloudApi<CloudConversationPage>("/conversations", {
            signal,
          }),
        );
        if (!signal?.aborted && epoch === accessEpoch.current) {
          setConversations(page.conversations);
          setNextCursor(page.nextCursor);
        }
      } catch (failure) {
        if (!signal?.aborted) handleFailure(failure);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [handleFailure, cloudApi, project],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal, !!bootstrap);
    return () => controller.abort();
  }, [load]);
  // Refresh list activity without clearing the transcript or changing selection.
  useEffect(() => {
    if (!capabilities?.enabled) return;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const page = validateCloudConversationPage(await cloudApi<CloudConversationPage>("/conversations", { signal }));
        if (!signal.aborted) {
          setConversations(previous => mergeConversationHistory(previous, page.conversations));
          const shown = currentDetail.current;
          const latest = page.conversations.find(item => item.id === shown?.conversation.id);
          if (shown && latest && (latest.revision > shown.conversation.revision ||
            latest.latestRunStatus !== undefined && latest.latestRunStatus !== (shown.runs[0]?.status ?? null))) {
            await loadConversation(latest.id, true, signal);
          }
        }
      } catch (failure) { if (!signal.aborted) handleFailure(failure); }
    };
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { clearInterval(timer); controller?.abort(); };
  }, [capabilities?.enabled, cloudApi, handleFailure, loadConversation]);
  const openedInitialConversation = useRef<string | null>(bootstrap?.detail?.conversation.id ?? null);
  useEffect(() => {
    if (!initialConversationId || !capabilities?.enabled || openedInitialConversation.current === initialConversationId) return;
    openedInitialConversation.current = initialConversationId;
    void loadConversation(initialConversationId);
  }, [initialConversationId, capabilities?.enabled, loadConversation]);
  useEffect(() => {
    if (!project || busy || loading) return;
    const url = new URL(window.location.href);
    const conversationId = detail?.conversation.id ?? null;
    if (url.searchParams.get("conversation") === conversationId) return;
    if (conversationId) url.searchParams.set("conversation", conversationId);
    else url.searchParams.delete("conversation");
    window.history.replaceState(null, "", url);
  }, [project, busy, loading, detail?.conversation.id]);
  useEffect(() => trackVisibleConversation(view === "conversation" && !loading && capabilities?.enabled && detail?.conversation.id
    ? { conversationId: detail.conversation.id, projectId: project?.id ?? null } : null),
    [view, loading, capabilities?.enabled, detail?.conversation.id, project?.id]);
  const workOff = capabilities?.enabled === false;
  const leftForWorkOff = useRef(false);
  useEffect(() => {
    // The server already redirected on load; this covers Work being turned off
    // while the page is open. Withdraw private data first, then leave once.
    if (!workOff || leftForWorkOff.current) return;
    leftForWorkOff.current = true;
    onWorkOff();
  }, [workOff, onWorkOff]);
  // Manage Work Access is the single switch for Cloud Work, so a change made
  // there (possibly in another tab) must appear here without a manual reload.
  const capabilitiesRef = useRef(capabilities);
  capabilitiesRef.current = capabilities;
  useEffect(() => {
    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const next = validateCloudCapabilities(
          await cloudApi<CloudCapabilities>("/capabilities"),
        );
        if (cancelled) return;
        const previous = capabilitiesRef.current;
        if (previous && JSON.stringify(previous) === JSON.stringify(next))
          return;
        setCapabilities(next);
        if (next.contractVersion === 1 && next.enabled && !previous?.enabled)
          void load();
      } catch {
        // Foreground requests surface access and connectivity problems.
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => {
      if (capabilitiesRef.current?.enabled === false) void refresh();
    }, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  useEffect(() => {
    const available =
      capabilities?.providers.find((item) => item.gatewayId === gatewayId) ??
      capabilities?.providers[0];
    if (!available) {
      setGatewayId("");
      setModelId("");
      return;
    }
    setGatewayId(available.gatewayId);
    if (!available.modelIds.includes(modelId))
      setModelId(defaultModelId(available));
  }, [capabilities, gatewayId, modelId]);

  useEffect(() => {
    streamOwner.current = activeRunId;
    setStream({ sequence: 0, text: "" });
    setStreamStatus("");
    if (!activeRunId || !detail) return;
    const controller = new AbortController();
    // Terminal events close SSE, but durable reconciliation has its own lifetime.
    const reconciliation = new AbortController();
    const epoch = accessEpoch.current;
    const conversationId = detail.conversation.id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let state: CloudStreamState = { sequence: 0, text: "" };
    const reconcile = async () => {
      if (reconciliation.signal.aborted || epoch !== accessEpoch.current ||
          desiredConversation.current !== conversationId) return;
      const loaded = await loadConversation(conversationId, true, reconciliation.signal);
      if (reconciliation.signal.aborted || epoch !== accessEpoch.current ||
          desiredConversation.current !== conversationId) return;
      if (loaded === null || (loaded && !loaded.runs.some((run) => run.id === activeRunId && isActiveRun(run))))
        return;
      setStreamStatus("Reconnecting… Your response is saved on the server.");
      timer = setTimeout(() => void reconcile(), 2000);
    };
    const connect = async () => {
      try {
        const snapshot = validateCloudSnapshot(
          await cloudApi<CloudRunSnapshot>(
            `/runs/${encodeURIComponent(activeRunId)}`,
            { signal: controller.signal },
          ),
        );
        if (controller.signal.aborted) return;
        if (
          !Number.isSafeInteger(snapshot.run.lastSequence) ||
          snapshot.run.lastSequence < 0 ||
          typeof snapshot.assistantText !== "string"
        )
          throw new Error("invalid_snapshot");
        state = {
          sequence: snapshot.run.lastSequence,
          text: snapshot.assistantText,
        };
        setStream(state);
        setDetail((previous) =>
          previous?.conversation.id === conversationId
            ? {
                ...previous,
                // Keep the live reply mounted until its durable message loads.
                runs: isActiveRun(snapshot.run) ? previous.runs.map((run) => run.id === snapshot.run.id ? snapshot.run : run) : previous.runs,
                toolInvocations: snapshot.toolInvocations
                  ? [...(previous.toolInvocations ?? []).filter((tool) => tool.runId !== snapshot.run.id), ...snapshot.toolInvocations]
                  : previous.toolInvocations,
                approvals: snapshot.approvals
                  ? [...(previous.approvals ?? []).filter((approval) => approval.runId !== snapshot.run.id), ...snapshot.approvals]
                  : previous.approvals,
              }
            : previous,
        );
        if (!isActiveRun(snapshot.run)) {
          await reconcile();
          return;
        }
        setStreamStatus(runLabel[snapshot.run.status]);
        let terminal = false;
        await readCloudEvents(
          activeRunId,
          state.sequence,
          controller.signal,
          (event) => {
            // Ignore an already-applied event for status and tools as well as text.
            if (event.sequence <= state.sequence) return;
            state = applyCloudEvent(state, event);
            setStream(state);
            if (project && event.data.file) setProjectFiles(previous => upsert(previous, event.data.file!));
            if (event.data.invocation || event.data.approval || event.data.file || event.type === "run.started")
              setDetail((previous) =>
                previous?.conversation.id === conversationId
                  ? {
                      ...previous,
                      runs: previous.runs.map((run) => {
                        if (run.id !== activeRunId) return run;
                        if (event.type === "approval.requested") return { ...run, status: "awaitingApproval" };
                        if (event.type === "run.started") return { ...run, status: "running" };
                        if (event.type === "approval.decided") {
                          const pending = upsert(previous.approvals ?? [], event.data.approval!)
                            .some((approval) => approval.runId === run.id && approval.status === "pending");
                          return { ...run, status: pending ? "awaitingApproval" : "running" };
                        }
                        return run;
                      }),
                      toolInvocations: event.data.invocation
                        ? upsert(
                            previous.toolInvocations ?? [],
                            event.data.invocation,
                          )
                        : previous.toolInvocations,
                      approvals: event.data.approval
                        ? upsert(previous.approvals ?? [], event.data.approval)
                        : previous.approvals,
                      files: event.data.file
                        ? upsert(previous.files ?? [], event.data.file)
                        : previous.files,
                    }
                  : previous,
              );
            if (event.type === "run.started") setStreamStatus("Responding");
            if (event.type === "approval.requested")
              setStreamStatus("Waiting for your approval");
            if (event.type === "approval.decided")
              setStreamStatus("Responding");
            if (
              [
                "run.completed",
                "run.cancelled",
                "run.failed",
                "run.interrupted",
              ].includes(event.type)
            ) {
              terminal = true;
              controller.abort();
            }
          },
          ...(project ? [project.id] as [string] : [] as []),
        ).catch((failure: unknown) => {
          if (!terminal) throw failure;
        });
        if (terminal) {
          await reconcile();
          return;
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (
          failure instanceof ClientApiError &&
          [401, 403, 404].includes(failure.status)
        ) {
          handleFailure(failure);
          setStreamStatus("Live updates paused");
          return;
        }
        // The bounded connection renewing itself is routine, not a failure.
        if (
          failure instanceof ClientApiError &&
          failure.code === "stream_snapshot_refresh"
        ) {
          timer = setTimeout(() => void connect(), 0);
          return;
        }
      }
      if (!controller.signal.aborted) {
        setStreamStatus("Reconnecting… Your response is saved on the server.");
        timer = setTimeout(() => void connect(), 2000);
      }
    };
    void connect();
    return () => {
      controller.abort();
      reconciliation.abort();
      if (timer) clearTimeout(timer);
    };
    // The run ID owns this connection; ordinary conversation metadata changes do not restart it.
  }, [activeRunId, loadConversation, handleFailure]);
  const submit = async (attempt: Attempt) => {
    followResponse.current = true;
    setBusy(true);
    const epoch = accessEpoch.current;
    setError("");
    try {
      const accepted = validateCloudSubmitResponse(
        await cloudApi<CloudSubmitResponse>(
          `/conversations/${encodeURIComponent(attempt.conversationId)}/messages`,
          cloudMutation(attempt.request),
        ),
      );
      if (epoch !== accessEpoch.current) return;
      setPending(null);
      setAttached((previous) => ({
        ...previous,
        [attempt.conversationId]: [],
      }));
      setDrafts((previous) => ({
        ...previous,
        [attempt.conversationId]: "",
      }));
      updateConversation(accepted.conversation);
      desiredConversation.current = accepted.conversation.id;
      setDetail((previous) => ({
        ...(previous?.conversation.id === accepted.conversation.id ? previous : {}),
        conversation: accepted.conversation,
        messages: (() => {
          const messages =
            previous?.conversation.id === attempt.conversationId
              ? previous.messages
              : [];
          return messages.some(
            (item) => item.runId === accepted.run.id && item.role === "user",
          )
            ? messages
            : [
                ...messages,
                {
                  id: attempt.request.requestId,
                  runId: accepted.run.id,
                  runStatus: accepted.run.status,
                  role: "user" as const,
                  text: attempt.request.text,
                  createdAt: accepted.run.createdAt,
                },
              ];
        })(),
        runs: [accepted.run, ...(previous?.conversation.id === accepted.conversation.id ? previous.runs.filter(run => run.id !== accepted.run.id) : [])],
      }));
      await loadConversation(attempt.conversationId);
    } catch (failure) {
      if (epoch !== accessEpoch.current) return;
      const unknown =
        !(failure instanceof ClientApiError) ||
        failure.status === 0 ||
        failure.status >= 500;
      if (unknown) {
        setPending(attempt);
        setError(
          unknown
            ? "The server may have received this message. Your draft is kept. Retry this same request to safely check its result."
            : cloudError(failure),
        );
      } else {
        setPending(null);
        handleFailure(failure);
      }
    } finally {
      setBusy(false);
    }
  };

  // Stable between renders unless the files change, so messages are not re-scanned needlessly.
  const mentionable = useMemo(
    () => [
      ...(detail?.files ?? []).map((file) => file.path),
      ...KNOWN_PLUGIN_NAMES,
    ],
    [detail?.files],
  );
  const existingPaths = useMemo(
    () => new Set((detail?.files ?? []).map((file) => file.path)),
    [detail?.files],
  );
  const filesAvailable = !!capabilities?.features.files;
  const openFile = filesAvailable
    ? (path: string) => {
        setOpenRequest((previous) => ({ path, nonce: (previous?.nonce ?? 0) + 1 }));
        setFilesOpen(true);
      }
    : undefined;
  /** Replies from image and video models link to the file; show the file itself. */
  const renderGeneratedFile = (path: string) => {
    const file = path.startsWith("generated/") ? detail?.files?.find((item) => item.path === path) : undefined;
    if (!file || !openFile) return undefined;
    const mode = previewMode(file);
    if (mode !== "image" && mode !== "video") return undefined;
    return <GeneratedMedia file={file} canDownload={canExportArtifacts} onOpen={() => openFile(path)} />;
  };
  // A request to open a file belongs to one opening of the panel.
  useEffect(() => {
    if (!filesOpen) setOpenRequest(null);
  }, [filesOpen]);
  const invocationsFor = (runId: string) =>
    (detail?.toolInvocations ?? []).filter((item) => item.runId === runId);
  const approvalsFor = (runId: string) =>
    (detail?.approvals ?? []).filter((item) => item.runId === runId);
  const refreshAfterDecision = async () => {
    if (detail) await loadConversation(detail.conversation.id);
  };
  const runProblem =
    !activeRun && latestRun
      ? cloudRunProblem(latestRun.status, latestRun.errorCode)
      : null;
  /** Re-sends the last message with the current model; the member's draft is left alone. */
  const retryLast = async () => {
    if (!detail || busy || activeRun || pending || uploadPending) return;
    const last = detail.messages.findLast((item) => item.role === "user");
    if (!last || !gatewayId || !modelId) return;
    const conversationId = detail.conversation.id;
    const keep = drafts[conversationId] ?? "";
    await submit({
      conversationId,
      request: {
        requestId: crypto.randomUUID(),
        text: last.text,
        gatewayId,
        modelId,
        expectedRevision: detail.conversation.revision,
        attachmentIds: last.attachments?.map((file) => file.id) ?? [],
      },
    });
    setDrafts((previous) => ({ ...previous, [conversationId]: keep }));
  };

  const ensureConversation = async () => {
    const epoch = accessEpoch.current;
    if (detail) return detail.conversation;
    const created = validateCloudConversation(
      await cloudApi<CloudConversation>("/conversations", cloudMutation(project ? { requestId: projectCreateId.current ??= crypto.randomUUID() } : {})),
    );
    if (epoch !== accessEpoch.current)
      throw new ClientApiError(
        "access_changed",
        "Work access changed. Load again.",
        403,
      );
    projectCreateId.current = null;
    desiredConversation.current = created.id;
    updateConversation(created);
    setDetail({ conversation: created, messages: [], runs: [], files: project ? projectFiles : [] });
    setDrafts((previous) => ({
      ...previous,
      [created.id]: previous.new ?? "",
      new: "",
    }));
    if (project) setAttached(previous => ({ ...previous, [created.id]: previous.new ?? [], new: [] }));
    return created;
  };
  /** Uploads one file. Resolves true when it was saved and attached. */
  const upload = async (
    file: File,
    saved?: NonNullable<typeof uploadPending>,
    extras?: { name?: string; mimeType?: string },
  ): Promise<boolean> => {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("Files must be 20 MB or smaller.");
      return false;
    }
    setBusy(true);
    setError("");
    let attempt = saved;
    const epoch = accessEpoch.current;
    let succeeded = false;
    try {
      const conversationId =
        saved?.conversationId ?? project?.id ?? (await ensureConversation()).id;
      attempt = saved ?? {
        file,
        conversationId,
        requestId: crypto.randomUUID(),
        ...(extras?.name ? { name: extras.name } : {}),
        ...(extras?.mimeType ? { mimeType: extras.mimeType } : {}),
      };
      const uploaded = validateCloudFile(
        await cloudApi<CloudFile>(
          `/conversations/${encodeURIComponent(conversationId)}/files?path=${encodeURIComponent(attempt.name ?? file.name)}&requestId=${attempt.requestId}${attempt.mimeType ? `&mimeType=${encodeURIComponent(attempt.mimeType)}` : ""}`,
          {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: file,
          },
        ),
      );
      if (epoch !== accessEpoch.current) return false;
      if (project) setProjectFiles(previous => upsert(previous, uploaded));
      setUploadPending(null);
      setDetail((previous) =>
        previous && (project || previous.conversation.id === conversationId)
          ? { ...previous, files: upsert(previous.files ?? [], uploaded) }
          : previous,
      );
      setAttached((previous) => ({
        ...previous,
        [project ? selected : conversationId]: [
          ...new Set([...(previous[project ? selected : conversationId] ?? []), uploaded.id]),
        ],
      }));
      setAnnouncement(`${uploaded.path} attached.`);
      succeeded = true;
    } catch (failure) {
      if (epoch !== accessEpoch.current) return false;
      if (
        attempt &&
        (!(failure instanceof ClientApiError) ||
          failure.status === 0 ||
          failure.status >= 500)
      ) {
        setUploadPending(attempt);
        setError(
          "The file may have been uploaded. Check this same upload before continuing.",
        );
      } else {
        setUploadPending(null);
        handleFailure(failure);
      }
    } finally {
      setBusy(false);
      if (uploadInput.current) uploadInput.current.value = "";
    }
    return succeeded;
  };
  /** Why files cannot be added right now, or null when they can. */
  const uploadBlockedReason: string | null = !capabilities?.features.files
    ? "File uploads are not available in this workspace."
    : !canWriteFiles
      ? "Your project role does not allow file uploads."
    : !capabilities.enabled
      ? "Cloud Work is turned off for your account."
      : activeRun
        ? "Wait for the current response to finish."
        : busy
          ? "Another action is in progress."
          : uploadPending
            ? "Check the saved upload first."
            : pending
              ? "Check the saved request first."
              : fileDirty
                ? "Save or discard your file changes first."
                : null;
  /**
   * Adds files from the picker, a drop, or the clipboard. They go up one at a
   * time into one conversation; if a reply is lost the rest wait for the member
   * to check that upload, rather than risking a duplicate.
   */
  const uploadFiles = async (
    picked: File[],
    options: { paste?: boolean; folders?: number } = {},
  ) => {
    setUploadNotice("");
    if (uploadBlockedReason) {
      setUploadNotice(uploadBlockedReason);
      return;
    }
    const { accepted, rejected } = prepareUploads(picked, {
      existing: (detail?.files ?? []).map((file) => file.path),
      paste: options.paste,
    });
    const notes = [
      options.folders
        ? `${options.folders === 1 ? "A folder was" : `${options.folders} folders were`} skipped: add the files inside instead.`
        : "",
      describeRejections(rejected),
    ]
      .filter(Boolean)
      .join(" ");
    if (!accepted.length) {
      if (notes) setUploadNotice(notes);
      return;
    }
    let conversationId: string;
    setBusy(true);
    try {
      conversationId = (await ensureConversation()).id;
    } catch (failure) {
      handleFailure(failure);
      return;
    } finally {
      setBusy(false);
    }
    for (const [index, item] of accepted.entries()) {
      setUploading({ done: index, total: accepted.length, name: item.name });
      const ok = await upload(
        item.file,
        {
          file: item.file,
          conversationId,
          requestId: crypto.randomUUID(),
          name: item.name,
          ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        },
        { name: item.name, mimeType: item.mimeType },
      );
      if (!ok) {
        const left = accepted.length - index - 1;
        setUploading(null);
        if (left > 0)
          setUploadNotice(
            `${left} more file${left === 1 ? " was" : "s were"} not uploaded. Resolve this one, then add ${left === 1 ? "it" : "them"} again.`,
          );
        return;
      }
    }
    setUploading(null);
    if (notes) setUploadNotice(notes);
  };
  const drop = useFileDrop({
    blocked: capabilities?.features.files ? uploadBlockedReason : null,
    onFiles: (files, info) =>
      void uploadFiles(files, { folders: info.folders }),
  });
  const newConversation = useCallback(() => {
    if (busy || pending || uploadPending || fileBusy || settingsBusy) return false;
    if (
      (fileDirty || settingsDirty) &&
      !window.confirm("Discard your unsaved changes?")
    )
      return false;
    selection.current++;
    desiredConversation.current = null;
    ++historyRequestOwner.current;
    setLoadingHistory(false);
    historyAnchor.current = null;
    setDetail(null);
    setError("");
    setRenaming(false);
    setConfirmDelete(false);
    setFilesOpen(false);
    setView("conversation");
    closePersonalPanel.current?.();
    onNewPersonalConversation.current?.();
    mobileSidebar.current?.close();
    requestAnimationFrame(() => composer.current?.focus());
    return true;
  }, [busy, pending, uploadPending, fileBusy, settingsBusy, fileDirty, settingsDirty]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        document.querySelector("dialog[open], [aria-modal=true]")
      )
        return;
      if (
        event.key.toLowerCase() === "n" &&
        !busy &&
        !pending &&
        !uploadPending
      ) {
        event.preventDefault();
        newConversation();
      }
      if (event.key === "\\") {
        event.preventDefault();
        setSidebarCollapsed((value) => !value);
      }
      if (event.key === ",") {
        event.preventDefault();
        if (
          !(fileDirty || settingsDirty) ||
          window.confirm("Discard your unsaved changes?")
        ) {
          setView("settings");
          closePersonalPanel.current?.();
        }
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [busy, pending, uploadPending, newConversation, fileDirty, settingsDirty]);
  const navigate = (next: typeof view) => {
    if (workOff || fileBusy || settingsBusy) return;
    if (
      (fileDirty || settingsDirty) &&
      !window.confirm("Discard your unsaved changes?")
    )
      return;
    setView(next);
    closePersonalPanel.current?.();
    mobileSidebar.current?.close();
  };
  const leaveWork = () =>
    !busy &&
    !fileBusy && !settingsBusy &&
    (!(fileDirty || settingsDirty || Object.values(drafts).some(value => value.trim())) ||
      window.confirm("Leave Work and discard your unsaved changes?"));
  const sidebar = (mobile = false) => {
    const collapsed = sidebarCollapsed && !mobile;
    const rowLayout = collapsed
      ? "justify-center px-0"
      : "gap-2.5 px-2.5 text-left";
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div
          className={cn(
            "flex h-14 shrink-0 items-center gap-2",
            collapsed ? "justify-center px-0" : "justify-between px-4",
          )}
        >
          <LoriLogo compact={collapsed} label={viewer?.cloud ? "Lori" : undefined} />
          {mobile ? (
            <Button
              aria-label="Close conversations"
              size="icon"
              variant="ghost"
              onClick={() => mobileSidebar.current?.close()}
            >
              <XIcon />
            </Button>
          ) : null}
        </div>
        <div className="px-3">
          <button
            type="button"
            title={collapsed ? "New conversation" : undefined}
            aria-label="New conversation"
            disabled={
              busy || !!pending || !!uploadPending || !capabilities?.enabled || (!onPrivateConversation && !canChat)
            }
            onClick={project && onPrivateConversation ? onPrivateConversation : newConversation}
            className={cn(
              "flex min-h-9 w-full items-center rounded-lg text-[13px] font-medium outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none",
              !collapsed && "border border-sidebar-border bg-background/70",
              rowLayout,
            )}
          >
            <PlusIcon aria-hidden className="size-4 shrink-0" />
            {!collapsed && "New conversation"}
          </button>
        </div>
        {!collapsed && (
          <>
            <div className="relative mx-3 mt-1.5">
              <SearchIcon
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                aria-label="Search conversations"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={project ? "Search project conversations" : "Search conversations"}
                className="h-8 w-full rounded-md border-0 bg-transparent pl-9 pr-2 text-[13px] outline-none placeholder:text-muted-foreground hover:bg-sidebar-accent/50 focus:bg-background focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div
              role="region"
              aria-label="Conversation history"
              ref={mobile ? undefined : restoreSidebarScroll}
              onScroll={event => { if (!mobile && sidebarScroll) sidebarScroll.current = event.currentTarget.scrollTop; }}
              tabIndex={0}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 pt-3 [overflow-anchor:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {projectNavigation?.(leaveWork, {
                mobile,
                conversationId: detail?.conversation.id ?? null, runStatus: detail?.runs[0]?.status, conversations, query,
                disabled: fileBusy || settingsBusy || (operationBusy && foregroundLoad.current === null) || !!pending || !!uploadPending || loading,
                openConversation: id => { void loadConversation(id); }, newConversation,
                personalProjectId: detail?.conversation.personalProjectId ?? null,
                revision: detail?.conversation.revision,
              })}
              {!project && <><p className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">
                Conversations
              </p>
              <nav aria-label="Cloud conversations">
                {conversations
                  .filter((item) =>
                    item.title
                      .toLocaleLowerCase()
                      .includes(query.toLocaleLowerCase()),
                  )
                  .map((conversation) => (
                    <button
                      key={conversation.id}
                      title={conversation.title || "Untitled conversation"}
                      type="button"
                      aria-current={
                        selected === conversation.id && view === "conversation"
                          ? "page"
                          : undefined
                      }
                      disabled={busy || !!pending || !!uploadPending}
                      onClick={() => void loadConversation(conversation.id)}
                      className={cn(
                        "flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                        selected === conversation.id && view === "conversation"
                          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {conversation.title || "Untitled conversation"}
                      </span>
                      <ConversationStatus status={conversation.id === detail?.conversation.id ? detail.runs[0]?.status : conversation.latestRunStatus} />
                    </button>
                  ))}
                {!loading && !conversations.length && (
                  <p className="px-3 py-2 text-xs leading-5 text-muted-foreground">
                    Your conversations will appear here.
                  </p>
                )}
                {query &&
                  !conversations.some((item) =>
                    item.title
                      .toLocaleLowerCase()
                      .includes(query.toLocaleLowerCase()),
                  ) && (
                    <p
                      role="status"
                      className="px-3 py-2 text-xs leading-5 text-muted-foreground"
                    >
                      {nextCursor
                        ? "No match in the conversations loaded so far. Load older conversations to search further."
                        : "No matching conversations."}
                    </p>
                  )}
                {nextCursor && (
                  <Button
                    variant="ghost"
                    className="w-full justify-start text-xs"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const epoch = accessEpoch.current;
                      try {
                        const page = validateCloudConversationPage(
                          await cloudApi<CloudConversationPage>(
                            `/conversations?cursor=${encodeURIComponent(nextCursor)}`,
                          ),
                        );
                        if (epoch !== accessEpoch.current) return;
                        setConversations((previous) => mergeConversationHistory(previous, page.conversations));
                        setNextCursor(page.nextCursor);
                      } catch (failure) {
                        handleFailure(failure);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Load older conversations
                  </Button>
                )}
              </nav></>}
            </div>
          </>
        )}
        {collapsed && <div className="flex-1" />}
        <nav
          aria-label="Work navigation"
          className={cn("shrink-0 border-t border-sidebar-border py-1.5", collapsed ? "mx-2" : "mx-3")}
        >
          {(
            [
              {
                id: "providers",
                label: "LLM Providers",
                Icon: SlidersHorizontalIcon,
              },
              { id: "plugins", label: "Plugins", Icon: PlugIcon },
              { id: "settings", label: "Settings", Icon: SettingsIcon },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              title={workOff ? WORK_OFF_REASON : collapsed ? label : undefined}
              aria-label={label}
              aria-current={view === id ? "page" : undefined}
              disabled={workOff}
              onClick={() => navigate(id)}
              className={cn(
                "flex min-h-8 w-full items-center rounded-md text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
                rowLayout,
                view === id
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <Icon aria-hidden className="size-4 shrink-0" />
              {!collapsed && label}
            </button>
          ))}
        </nav>
        {!collapsed && viewer && (
          <p
            className="mx-3 shrink-0 truncate px-2.5 pb-3 pt-1 text-xs text-muted-foreground"
            title={`${accountName(viewer)} (${viewer.user.email}) · ${viewer.organization.name}`}
          >
            {accountName(viewer)}
          </p>
        )}
      </div>
    );
  };
  return (
    <section
      aria-label="Cloud Work"
      className="fixed inset-0 flex h-dvh min-h-0 overflow-hidden overscroll-none bg-background text-foreground selection:bg-primary/20"
    >
      <ResizableWorkSidebar collapsed={sidebarCollapsed}>
        {sidebar()}
      </ResizableWorkSidebar>
      <dialog
        ref={mobileSidebar}
        aria-label="Conversations"
        className="m-0 h-dvh max-h-none w-[min(18rem,calc(100vw-1.5rem))] max-w-none border-0 bg-sidebar p-0 text-foreground open:animate-sheet-in backdrop:animate-backdrop-in md:hidden"
        onClose={() => setSidebarOpen(false)}
      >
        {sidebar(true)}
      </dialog>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open conversations"
              aria-expanded={sidebarOpen}
              onClick={() => {
                mobileSidebar.current?.showModal();
                setSidebarOpen(true);
              }}
            >
              <MenuIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="hidden size-8 text-muted-foreground hover:text-foreground md:inline-flex"
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-controls="work-sidebar"
              aria-expanded={!sidebarCollapsed}
              aria-label={
                sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
              }
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              <PanelLeftIcon aria-hidden className="size-[18px]" strokeWidth={1.7} />
            </Button>
            <div className="min-w-0">
            {project && <p className="truncate text-[11px] leading-4 text-muted-foreground" title={project.name}>{project.name}{project.access.audited ? " · Audited access" : project.status === "archived" ? " · Archived" : ""}</p>}
            <h1 className="min-w-0 truncate text-[13px] font-medium">
              {personal?.panel
                ? "Personal project"
                : view === "conversation"
                ? detail?.conversation.title || "New conversation"
                : view === "providers"
                  ? "LLM Providers"
                  : view === "plugins"
                    ? "Plugins"
                    : "Settings"}
            </h1></div>
            {!project && <span className="hidden shrink-0 text-[11px] text-muted-foreground lg:inline">Enterprise Cloud</span>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {view === "conversation" && detail && !personal?.panel && <ConversationFindToggle find={find} />}
            {view === "conversation" && detail && !personal?.panel && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-9"
                    aria-label="Conversation actions"
                    title="Conversation actions"
                    disabled={
                      busy || !!activeRun || !!pending || !!uploadPending
                    }
                  >
                    <MoreHorizontalIcon aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={!canChat}
                    onSelect={() => {
                      setTitle(detail.conversation.title);
                      setRenaming(true);
                      setConfirmDelete(false);
                    }}
                  >
                    Rename conversation
                  </DropdownMenuItem>
                  {personal && !project && (
                    <DropdownMenuItem onSelect={() => setMoving(true)}>
                      Move to project…
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!!project && !project.access.actions.includes("conversations.delete")}
                    onSelect={() => {
                      setConfirmDelete(true);
                      setRenaming(false);
                    }}
                  >
                    Delete conversation
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {capabilities?.enabled &&
              capabilities.features.files &&
              (!!detail?.files?.length || !!project || filesOpen) &&
              view === "conversation" && !personal?.panel && (
                <Button
                  size="sm"
                  variant="ghost"
                  ref={filesToggle}
                  disabled={fileBusy || (filesOpen && fileDirty)}
                  aria-label="Files"
                  title={project ? "Project files" : "Conversation files"}
                  className="h-9 gap-1.5 px-2 text-xs"
                  aria-pressed={filesOpen}
                  onClick={() => {
                    if (fileBusy) return;
                    if (
                      filesOpen &&
                      fileDirty &&
                      !window.confirm("Discard your unsaved file changes?")
                    )
                      return;
                    setFilesOpen((value) => !value);
                  }}
                >
                  <FolderIcon aria-hidden />
                  <span className="hidden sm:inline">Files</span>
                </Button>
              )}
            <ThemeToggle compact />
            {viewer && <AccountMenu viewer={viewer} compact />}
          </div>
        </header>
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {announcement}
        </p>
        {error && (
          <div
            role="alert"
            className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3 text-xs"
          >
            <p className="min-w-0 flex-1 text-destructive">{error}</p>
            {uploadPending ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void upload(uploadPending.file, uploadPending)}
              >
                Check saved upload
              </Button>
            ) : pending ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void submit(pending)}
              >
                Retry saved request
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || loading}
                onClick={() =>
                  detail
                    ? void loadConversation(detail.conversation.id)
                    : void load()
                }
              >
                Load again
              </Button>
            )}
            {!capabilities && (
              <Link
                className="underline underline-offset-4"
                href="/sign-in?callback=%2Fwork%2Fcloud"
              >
                Sign in
              </Link>
            )}
          </div>
        )}
        {personal?.panel && view === "conversation" ? (
          personal.panel(setSettingsDirty, setSettingsBusy)
        ) : view !== "conversation" ? (
          <CloudDestinations
            viewer={viewer}
            projectCapabilities={projectCapabilities}
            beforeManageNavigate={leaveWork}
            project={project}
            projectSettings={projectSettings?.(setSettingsDirty, setSettingsBusy)}
            onFailure={handleFailure}
            conversationId={detail?.conversation.id ?? null}
            conversationTitle={detail?.conversation.title}
            onDirtyChange={setSettingsDirty}
            onBusyChange={setSettingsBusy}
            view={view}
            capabilities={capabilities}
            admin={admin}
            loading={loading}
            active={gatewayId && modelId ? { gatewayId, modelId } : undefined}
            onReload={() => void load()}
            onBack={() => navigate("conversation")}
            onSaved={() => void load()}
          />
        ) : loading ? (
          <p role="status" className="p-8 text-sm text-muted-foreground">
            Loading Cloud Work…
          </p>
        ) : !capabilities ? (
          <p className="p-8 text-sm text-muted-foreground">
            Use Load again to check your Cloud Work access and server status.
          </p>
        ) : capabilities.contractVersion !== 1 ? (
          <p role="status" className="p-8 text-sm">
            Update Lori Enterprise to use this Cloud Work client.
          </p>
        ) : !capabilities.enabled ? (
          <div className="mx-auto my-auto max-w-lg p-8">
            <h2 className="text-lg font-medium">Cloud Work is turned off</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {admin
                ? "Cloud Work follows your organization’s Work access. Enable Work for your organization or this account and it becomes available here automatically."
                : "Work is turned off for your account. Ask an administrator to enable it."}
            </p>
            {admin && (
              <Button asChild className="mt-4" variant="outline">
                <Link href="/work">Manage Work access</Link>
              </Button>
            )}
          </div>
        ) : (
          <>
            {!usable && (
              <p
                role="status"
                className="shrink-0 border-b border-border px-5 py-3 text-xs text-muted-foreground"
              >
                Cloud Work cannot start a response. Ask an administrator to
                check the worker and your allowed providers and models.
              </p>
            )}
            {renaming && detail ? (
              <form
                className="flex flex-wrap gap-2 border-b border-border p-3"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setBusy(true);
                  try {
                    const saved = await cloudApi<CloudConversation>(
                      `/conversations/${encodeURIComponent(detail.conversation.id)}`,
                      cloudMutation(
                        {
                          title: title.trim(),
                          expectedRevision: detail.conversation.revision,
                        },
                        "PATCH",
                      ),
                    );
                    setDetail({ ...detail, conversation: saved });
                    updateConversation(saved);
                    setRenaming(false);
                  } catch (failure) {
                    handleFailure(failure);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <input
                  aria-label="Conversation title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  maxLength={200}
                  className={cn(field, "flex-1")}
                  autoFocus
                />
                <Button disabled={busy || !title.trim()}>Save name</Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setRenaming(false)}
                >
                  Cancel
                </Button>
              </form>
            ) : null}
            {confirmDelete && detail ? (
              <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
                <p className="flex-1 text-sm">
                  Delete this conversation and its stored responses?
                </p>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await cloudApi(
                        `/conversations/${encodeURIComponent(detail.conversation.id)}?expectedRevision=${detail.conversation.revision}`,
                        { method: "DELETE" },
                      );
                      setConversations((previous) =>
                        previous.filter(
                          (item) => item.id !== detail.conversation.id,
                        ),
                      );
                      setDrafts((previous) => {
                        const copy = { ...previous };
                        delete copy[detail.conversation.id];
                        return copy;
                      });
                      setDetail(null);
                      setConfirmDelete(false);
                    } catch (failure) {
                      handleFailure(failure);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Delete conversation
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep conversation
                </Button>
              </div>
            ) : null}
            <div
              className="relative flex min-h-0 min-w-0 flex-1"
              {...drop.bind}
            >
              {drop.dragging ? <DropOverlay blocked={drop.blocked} /> : null}
              <div data-conversation-find-scope className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <ConversationFindBar find={find} />
                <ConversationFindHighlights find={find} viewport={messages} />
                <div
                  ref={messages}
                  onScroll={onTranscriptScroll}
                  role="log"
                  tabIndex={0}
                  aria-label="Conversation messages"
                  aria-live="off"
                  className={cn(
                    "min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-auto px-4 py-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:px-8",
                    isEmpty && "hidden",
                  )}
                >
                  <div ref={messageContent} className={`space-y-8 ${findHighlightClasses}`}>
                  {detail?.historyCursor ? <div className="mx-auto max-w-[70ch] text-center">
                    <Button type="button" variant="ghost" size="sm" disabled={loadingHistory} onClick={() => void loadEarlierMessages()}>
                      {loadingHistory ? "Loading earlier messages…" : "Load earlier messages"}
                    </Button>
                  </div> : null}

                  {buildTranscript(detail?.messages ?? [], detail?.toolInvocations ?? [], activeRun, visibleStreamText).map((entry) => (
                    <article key={entry.key} data-conversation-message={entry.key} className={cn("group mx-auto max-w-[70ch] min-w-0 motion-safe:animate-fade-in", entry.type === "user" && "flex flex-col items-end")}>
                      <h3 className="sr-only">{entry.type === "user" ? entry.message.author?.name ?? "You" : "Lori"}</h3>
                      {entry.type === "user" ? <>
                        {!!entry.message.attachments?.length && <ul className="mb-2 flex flex-wrap gap-2">
                          {entry.message.attachments.map(file => <li key={file.id}>
                            <a className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                              href={`/api/v1/work/cloud/files/${encodeURIComponent(file.id)}/content?download=true`} download>
                              <PaperclipIcon aria-hidden className="size-3" />{file.path}
                            </a>
                          </li>)}
                        </ul>}
                        {entry.message.author && <p className="mb-1 text-xs text-muted-foreground">{entry.message.author.name}</p>}
                        <UserMessageText text={entry.message.text} mentionable={mentionable} revealForSearch={find.searching && find.revealMessageId === entry.key} />
                        <CopyMessage text={entry.message.text} />
                      </> : <>
                        <AssistantFlow text={entry.text} invocations={invocationsFor(entry.runId)} approvals={approvalsFor(entry.runId)}
                          canExport={canExportArtifacts}
                          streaming={entry.active} existingPaths={existingPaths} onOpenFile={openFile}
                          renderFile={renderGeneratedFile}
                          onChanged={refreshAfterDecision} onFailure={handleFailure} />
                        {entry.active && activeRun ? <ThinkingIndicator
                          status={activeRun.status as ActiveStatus}
                          connectionStatus={streamOwner.current === activeRunId ? streamStatus : ""}
                          text={visibleStreamText} invocations={invocationsFor(activeRun.id)} approvals={approvalsFor(activeRun.id)}
                          since={activeRun.createdAt} workerAvailable={!!capabilities?.available} hasText={!!visibleStreamText}
                        /> : entry.text ? <CopyMessage text={entry.text} /> : null}
                      </>}
                    </article>
                  ))}
                  {!activeRun && runProblem ? (

                    <div className="mx-auto max-w-[70ch]">
                      <RunProblemNotice
                        problem={runProblem}
                        admin={admin}
                        disabled={
                          busy || !usable || !!pending || !!uploadPending
                        }
                        onRetry={() => void retryLast()}
                        onChooseModel={() => navigate("providers")}
                        onNewConversation={newConversation}
                      />
                    </div>
                  ) : null}
                  </div>
                </div>
                <form
                  className={cn(
                    "mx-auto flex min-h-0 max-h-full w-full max-w-[784px] shrink-0 flex-col px-4 sm:px-8",
                    isEmpty
                      ? "my-auto overflow-y-auto py-8 sm:py-12 [@media(max-height:420px)]:py-3"
                      : "pb-5 pt-2 [@media(max-height:420px)]:pb-2",
                  )}
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (
                      !draft.trim() ||
                      busy ||
                      activeRun ||
                      pending ||
                      uploadPending ||
                      fileDirty ||
                      !usable ||
                      !gatewayId ||
                      !modelId
                    )
                      return;
                    const epoch = accessEpoch.current;
                    if (new TextEncoder().encode(draft.trim()).length > 60000) {
                      setError(
                        "This message is too long. Shorten it before sending.",
                      );
                      return;
                    }
                    setBusy(true);
                    setError("");
                    try {
                      const conversation = await ensureConversation();
                      if (epoch !== accessEpoch.current) return;
                      await submit({
                        conversationId: conversation.id,
                        request: {
                          requestId: crypto.randomUUID(),
                          text: draft.trim(),
                          gatewayId,
                          modelId,
                          expectedRevision: conversation.revision,
                          attachmentIds: attached[conversation.id] ?? [],
                        },
                      });
                    } catch (failure) {
                      handleFailure(failure);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {isEmpty && (
                    <header className="mb-7 text-center sm:mb-8 [@media(max-height:420px)]:mb-3">
                      <h2 className="text-[28px] font-semibold leading-tight tracking-[-0.03em] [@media(max-height:420px)]:text-xl">
                        What would you like to work on?
                      </h2>
                    </header>
                  )}
                  <input
                    ref={uploadInput}
                    type="file"
                    multiple
                    aria-label="Attach files"
                    className="hidden"
                    tabIndex={-1}
                    onChange={(event) => {
                      const picked = [...(event.target.files ?? [])];
                      // Reset first so choosing the same file again still fires.
                      event.target.value = "";
                      if (picked.length) void uploadFiles(picked);
                    }}
                  />
                  {uploadNotice ? (
                    <p
                      role="status"
                      className="mx-auto mb-2 flex w-full max-w-[784px] items-start gap-2 px-1 text-xs leading-5 text-muted-foreground"
                    >
                      <span className="min-w-0 flex-1">{uploadNotice}</span>
                      <button
                        type="button"
                        className="shrink-0 rounded px-1 underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setUploadNotice("")}
                      >
                        Dismiss
                      </button>
                    </p>
                  ) : null}
                  <CloudComposer
                    key={`${project?.id ?? "private"}:${selected}`}
                    textareaRef={composer}
                    value={draft}
                    onChange={(value) =>
                      setDrafts((previous) => ({
                        ...previous,
                        [selected]: value,
                      }))
                    }
                    disabled={busy || !!pending || !!uploadPending || !canChat}
                    controlsDisabled={
                      busy || !!activeRun || !!pending || !!uploadPending
                    }
                    sendDisabled={
                      !canChat ||
                      busy ||
                      !!pending ||
                      !!uploadPending ||
                      fileDirty ||
                      !usable ||
                      !draft.trim() ||
                      !gatewayId ||
                      !modelId
                    }
                    disabledReason={
                      fileDirty
                        ? "Save or discard your file changes first"
                        : pending
                          ? "Check the saved request first"
                          : uploadPending
                            ? "Check the saved upload first"
                            : !usable
                              ? "Cloud Work is unavailable"
                              : !modelId
                                ? "Choose a model"
                                : !draft.trim()
                                  ? "Write a message to send"
                                  : busy
                                    ? "Sending…"
                                    : undefined
                    }
                    running={!!activeRun}
                    stopDisabled={operationBusy}
                    onStop={() => {
                      if (!activeRun) return;
                      void (async () => {
                        setBusy(true);
                        try {
                          await cloudApi(
                            `/runs/${encodeURIComponent(activeRun.id)}/cancel`,
                            cloudMutation({}),
                          );
                          await loadConversation(activeRun.conversationId);
                        } catch (failure) {
                          handleFailure(failure);
                        } finally {
                          setBusy(false);
                        }
                      })();
                    }}
                    providers={capabilities.providers}
                    gatewayId={gatewayId}
                    modelId={modelId}
                    onModel={(gateway, model) => {
                      setGatewayId(gateway);
                      setModelId(model);
                    }}
                    files={project ? projectFiles : detail?.files ?? []}
                    attachments={attached[selected] ?? []}
                    onRemoveAttachment={(id) =>
                      setAttached((previous) => ({
                        ...previous,
                        [selected]: (previous[selected] ?? []).filter(
                          (item) => item !== id,
                        ),
                      }))
                    }
                    filesAvailable={capabilities.features.files}
                    canUpload={canWriteFiles}
                    onUpload={() => { if (canWriteFiles) uploadInput.current?.click(); }}
                    uploading={uploading}
                    onPasteFiles={
                      capabilities.features.files && canWriteFiles
                        ? (pasted) => void uploadFiles(pasted, { paste: true })
                        : undefined
                    }
                    extensionsAvailable={capabilities.features.extensions}
                    projectId={project?.id}
                    onFiles={() => setFilesOpen(true)}
                    approvalControl={capabilities.features.tools && canChat ? <CloudApprovalControl compact projectId={project?.id} /> : undefined}
                    fileDirty={fileDirty}
                  />
                </form>
              </div>
              {filesOpen && capabilities.features.files && (
                <CloudFiles
                  key={detail?.conversation.id ?? "new"}
                  returnFocusRef={filesToggle}
                  conversationId={detail?.conversation.id ?? project?.id ?? null}
                  files={project ? projectFiles : detail?.files ?? []}
                  readOnly={!canWriteFiles}
                  allowExport={!project || project.access.actions.includes("export")}
                  disabled={operationBusy || !!activeRun || !!pending || !!uploadPending}
                  onFiles={(files) => {
                    if (project) setProjectFiles(files);
                    setDetail((previous) =>
                      previous &&
                      previous.conversation.id === detail?.conversation.id
                        ? { ...previous, files }
                        : previous,
                    );
                    setAttached((previous) => ({
                      ...previous,
                      [selected]: (previous[selected] ?? []).filter((id) =>
                        files.some((file) => file.id === id),
                      ),
                    }));
                  }}
                  onDirtyChange={setFileDirty}
                  onBusyChange={setFileBusy}
                  onClose={() => setFilesOpen(false)}
                  onFailure={handleFailure}
                  openRequest={openRequest}
                />
              )}
            </div>
          </>
        )}
      </div>
      {personal && !project && detail && (
        <MoveConversationDialog
          open={moving}
          conversation={detail.conversation}
          projects={personal.projects}
          onClose={() => setMoving(false)}
          onMoved={(moved) => {
            setDetail((previous) => (previous?.conversation.id === moved.id ? { ...previous, conversation: { ...previous.conversation, ...moved, personalProjectId: moved.personalProjectId } } : previous));
            updateConversation(moved);
            setAnnouncement(moved.personalProjectId ? "Conversation moved to the project." : "Conversation moved out of its project.");
          }}
        />
      )}
    </section>
  );
}

function CopyMessage({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="mt-1 flex items-center gap-2">
      <button
        type="button"
        aria-label="Copy message"
        title={copied ? "Copied" : "Copy message"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setError("");
          } catch {
            setError("Could not copy. Try again.");
          }
        }}
        className="rounded-md p-1.5 text-muted-foreground opacity-0 outline-none transition-[opacity,background-color,color] duration-150 hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        {copied ? (
          <CheckIcon aria-hidden className="size-3.5" />
        ) : (
          <CopyIcon aria-hidden className="size-3.5" />
        )}
      </button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

function upsert<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [...items, next];
}

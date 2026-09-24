import { createControllerStore } from "./controller-store.js";
import { ApiError } from "./chrome-api.js";
import {
  acceptedMutationSchema, abandonRequestSchema, contextPageSchema, conversationListRequestSchema,
  directEditPageSchema, directEditContentSchema, receiptLookupSchema, reviewPageListSchema, reviewPageSchema, validateSaveEvidence,
  reviewerMutationSchema, reviewStatusSchema, submissionHistoryPageSchema, submissionReadSchema,
  threadPageSchema, type Infer, type Schema,
  type ConversationExchange, type ConversationPage, type ConversationReview, type ConversationTarget,
  type DirectEdit, type HandlingReceipt, type PagingScope, type ReviewerMessage, type ReviewStatus, type SendRequest,
} from "./contracts/index.js";

type Thread = Infer<typeof threadPageSchema>["items"][number];
type HistoryItem = Infer<typeof submissionHistoryPageSchema>["items"][number];
type Submission = Infer<typeof submissionReadSchema>;
type Mutation = Infer<typeof reviewerMutationSchema> | Infer<typeof abandonRequestSchema>;
export interface ConversationDraft {
  text: string; intent: "discuss" | "request-change"; selectionStart: number; selectionEnd: number;
  composing: boolean; messageId: string | null; messageVersion: number | null;
}
export const conversationDraft = (): ConversationDraft => ({
  text: "", intent: "discuss", selectionStart: 0, selectionEnd: 0, composing: false, messageId: null, messageVersion: null,
});
interface Context {
  items: ConversationExchange[]; nextCursor: string | null; highWater: number; totalCount: number;
}
interface Options {
  reviewId: string; entryKey: string;
  request(path: string, options?: RequestInit): Promise<unknown>;
  barrier(): Promise<void>;
  baseline(): Promise<void>;
  navigate(key: string): Promise<void>;
  jump(threadId: string): void;
  revert(): Promise<void>;
  id?(): string;
}
type Confirmation = { action: "end" | "abandon" | "resolve" | "delete" | "revert"; id: string; version: number; description: string };
type Pending = { body: Mutation; accepted: (receipt: HandlingReceipt) => void; message: string; draftId?: string };

export function createConversationController(options: Options) {
  const reference = { reviewId: options.reviewId, entryKey: options.entryKey };
  let review: ConversationReview | null = null;
  let status: ReviewStatus | null = null;
  let pages: ConversationPage[] = [], threads: Thread[] = [], edits: DirectEdit[] = [], history: HistoryItem[] = [];
  let historyCursor: string | null = null, historyDepth = 50;
  let historyLoading: Promise<void> | null = null;
  const contexts = new Map<string, Context>(), drafts = new Map<string, ConversationDraft>();
  const savingDrafts = new Set<string>();
  const historyOpened = new Set<string>();
  const submissions = new Map<string, Submission>(), collapsed = new Set<string>(), attention = new Set<string>();
  const fingerprints = new Map<string, string>(), excluded = new Set<string>();
  const lastRecorded = new Map<string, string>();
  const readingPositions = new Map<string, { feedback: number; focus: number }>();
  const readingAnchors = new Map<string, { messageId: string; offset: number }>();
  let note = conversationDraft();
  let newMessage: { pageKey: string; target: ConversationTarget; draft: ConversationDraft } | null = null;
  let filters = { open: true, resolved: true };
  let focusId: string | null = null, open = false, error = "", notice = "", captureNotice = "", connected = true;
  let host: "feedback" | "focus" | "adjacent" | "compose" = "feedback";
  let confirmation: Confirmation | null = null, uncertain: Pending | null = null;
  let busy = false, confirming = false, dispatching = false, loading = false, disposed = false;
  let serial = Promise.resolve(), refreshing: Promise<void> | null = null, refreshAgain = false;
  let selectionKnown = false;
  const writable = () => !!review && review.state === "open" && !uncertain;
  const displayExchanges = (thread: Thread) => (contexts.get(thread.thread.threadId)?.items ??
    (thread.latestExchange ? [thread.latestExchange] : [])).filter((item) =>
    historyOpened.has(thread.thread.threadId) || item.reviewer.submissionId === null ||
    item.reviewer.messageId === thread.latestExchange?.reviewer.messageId);
  function pendingSelection() {
    if (!selectionKnown || !status) return null;
    const messages: SendRequest["messages"] = [], selectedEdits: SendRequest["edits"] = [];
    const keys = new Set<string>();
    let pendingMessages = 0;
    for (const thread of threads) {
      if (!thread.pendingMessageCount) continue;
      const pending = contexts.get(thread.thread.threadId)?.items.filter(({ reviewer }) => reviewer.submissionId === null);
      if (!pending || pending.length !== thread.pendingMessageCount) return null;
      pendingMessages += pending.length;
      for (const { reviewer } of pending) if (!excluded.has(reviewer.messageId)) {
        messages.push({ threadId: reviewer.threadId, messageId: reviewer.messageId, version: reviewer.version });
        keys.add(thread.thread.pageKey);
      }
    }
    if (pendingMessages !== status.pendingMessageCount || edits.length !== status.pendingEditCount) return null;
    for (const edit of edits) if (!excluded.has(edit.editId)) {
      selectedEdits.push({ pageKey: edit.pageKey, editId: edit.editId, version: edit.version });
      keys.add(edit.pageKey);
    }
    const overallNote = note.text.trim() ? { body: note.text, intent: note.intent } : undefined;
    if (overallNote) keys.add(reference.entryKey);
    return { pageKeys: [...keys], messages, edits: selectedEdits, ...(overallNote ? { overallNote } : {}),
      pendingCount: pendingMessages + edits.length };
  }
  const sendBlocked = () => {
    const keys = new Set([reference.entryKey, ...(pendingSelection()?.pageKeys ?? [])]);
    return status?.blockers.some((blocker) => blocker.targetKeys.some((key) => keys.has(key))) ?? false;
  };
  function selectionSummary() {
    const selected = !loading && connected && !uncertain ? pendingSelection() : null;
    return selected ? { pendingCount: selected.pendingCount, messages: selected.messages.length, edits: selected.edits.length,
      note: !!selected.overallNote, total: selected.messages.length + selected.edits.length + (selected.overallNote ? 1 : 0) } : null;
  }
  const draftCount = () => [...drafts.values(), note, ...(newMessage ? [newMessage.draft] : [])].filter((draft) => draft.text.length > 0).length;
  const store = createControllerStore(() => ({
    review, status, pages, edits, history, historyCursor,
    threads: threads.map((thread) => ({
      ...thread, exchanges: displayExchanges(thread), context: contexts.get(thread.thread.threadId) ?? null,
      draft: drafts.get(thread.thread.threadId) ?? null, expanded: !collapsed.has(thread.thread.threadId),
      attention: attention.has(thread.thread.threadId),
    })),
    submissions: [...submissions.entries()].map(([id, value]) => ({ id, value })),
    excluded: [...excluded], note, newMessage, filters, focusId, host, open, error, notice, captureNotice, connected,
    confirmation, uncertain: uncertain ? { operation: uncertain.body.operation, requestId: uncertain.body.requestId, message: uncertain.message } : null,
    busy: busy || confirming || dispatching, loading, savingDraftIds: [...savingDrafts], sendBlocked: sendBlocked(), draftCount: draftCount(), attentionCount: attention.size,
    selection: selectionSummary(),
    unsavedMessageDraftCount: [...drafts.values(), ...(newMessage ? [newMessage.draft] : [])].filter((draft) => draft.text.length > 0).length,
  }));
  function publish() { if (!disposed) store.publish(); }
  function revealFocusedThread() {
    const current = threads.find((item) => item.thread.threadId === focusId);
    if (current) filters = { ...filters, [current.thread.status]: true };
  }
  function fail(value: unknown) { error = value instanceof Error ? value.message : String(value); publish(); }
  async function post<T>(body: unknown, decoder: Schema<T>): Promise<T> {
    return decoder.parse(await options.request("/api/conversation", { method: "POST", body: JSON.stringify(body) }));
  }
  function scope(collection: PagingScope["collection"], threadId: string | null = null): PagingScope {
    return { ...reference, collection, pageKey: null, threadId, submissionId: null, status: "all" };
  }
  async function page<T>(collection: PagingScope["collection"], decoder: Schema<T>, query: { limit?: number; cursor?: string } = {}, threadId: string | null = null) {
    return post(conversationListRequestSchema.parse({ operation: "list", scope: scope(collection, threadId), query }), decoder);
  }
  async function all<T>(collection: PagingScope["collection"], decoder: Schema<{ items: T[]; nextCursor: string | null }>) {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      const result = await page(collection, decoder, { limit: 100, ...(cursor ? { cursor } : {}) });
      items.push(...result.items); cursor = result.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }
  async function readContext(id: string, minimum = 1, pending = 0): Promise<Context> {
    const latest = await page("context", contextPageSchema, {}, id);
    let result = latest;
    let items = [...latest.items];
    while (result.nextCursor && (items.length < minimum || items.filter((item) => item.reviewer.submissionId === null).length < pending)) {
      result = await page("context", contextPageSchema, { cursor: result.nextCursor }, id);
      items = [...result.items, ...items];
    }
    return { ...latest, items, nextCursor: result.nextCursor };
  }
  async function readHistory() {
    const oldestLoaded = history.at(-1)?.sequence;
    let result = await page("history", submissionHistoryPageSchema);
    const items = [...result.items];
    // Rebuild a continuous high-water window through every previously loaded item.
    // This bridges missed pages and refreshes older result/comparison summaries too.
    while (result.nextCursor && (items.length < historyDepth ||
      (oldestLoaded !== undefined && items.at(-1)!.sequence > oldestLoaded))) {
      result = await page("history", submissionHistoryPageSchema, { cursor: result.nextCursor });
      items.push(...result.items);
    }
    return { items: [...new Map(items.map((item) => [item.submissionId, item])).values()]
      .sort((a, b) => b.sequence - a.sequence), nextCursor: result.nextCursor };
  }
  async function refreshOnce() {
    const nextStatus = await post({ operation: "status", ...reference }, reviewStatusSchema);
    if (nextStatus.review.reviewId !== reference.reviewId || nextStatus.review.entryKey !== reference.entryKey) throw new Error("Status belongs to another review.");
    const [nextPages, nextThreads, nextEdits, nextHistory] = await Promise.all([
      all("pages", reviewPageListSchema), all("threads", threadPageSchema), all("edits", directEditPageSchema),
      readHistory(),
    ]);
    const nextContexts = new Map<string, Context>();
    await Promise.all(nextThreads.map(async (thread) => {
      const id = thread.thread.threadId;
      if (contexts.has(id) || thread.pendingMessageCount > 0) {
        nextContexts.set(id, await readContext(id, contexts.get(id)?.items.length ?? 1, thread.pendingMessageCount));
      }
    }));
    const nextSubmissions = new Map<string, Submission>();
    await Promise.all(nextHistory.items.map((item) => item.submissionId).map(async (id) => {
      nextSubmissions.set(id, await post({ operation: "submission", ...reference, submissionId: id }, submissionReadSchema));
    }));
    const confirmed = await post({ operation: "status", ...reference }, reviewStatusSchema);
    if (JSON.stringify(nextStatus) !== JSON.stringify(confirmed)) { refreshAgain = true; return; }
    if (disposed) return;
    review = nextStatus.review; status = nextStatus; pages = nextPages; edits = nextEdits;
    for (const thread of nextThreads) {
      const id = thread.thread.threadId;
      const fingerprint = JSON.stringify([thread.thread.version, thread.latestExchange, thread.pendingMessageCount]);
      if (fingerprints.has(id) && fingerprints.get(id) !== fingerprint) attention.add(id);
      fingerprints.set(id, fingerprint);
    }
    threads = nextThreads;
    for (const [id, value] of nextContexts) contexts.set(id, value);
    for (const [id, value] of nextSubmissions) submissions.set(id, value);
    history = nextHistory.items;
    historyCursor = nextHistory.nextCursor;
    selectionKnown = true;
    publish();
  }
  function refresh(): Promise<void> {
    if (refreshing) { refreshAgain = true; return refreshing; }
    loading = true; publish();
    refreshing = (async () => {
      do { refreshAgain = false; await refreshOnce(); } while (refreshAgain && !disposed);
    })().catch((cause) => { selectionKnown = false; fail(cause); throw cause; }).finally(() => { refreshing = null; loading = false; publish(); });
    return refreshing;
  }
  const draftEqual = (a: ConversationDraft, b: ConversationDraft) =>
    a.text === b.text && a.intent === b.intent && a.messageId === b.messageId && !a.composing;
  async function accept(pending: Pending) {
    const result = await post(pending.body, acceptedMutationSchema);
    if (result.receipt.reviewId !== reference.reviewId || result.receipt.entryKey !== reference.entryKey ||
        result.receipt.requestId !== pending.body.requestId || result.receipt.operation !== pending.body.operation) {
      throw new Error("Mutation receipt does not match this review and request.");
    }
    if (review) review = { ...review, version: result.receipt.value.reviewVersion };
    pending.accepted(result.receipt);
    if (pending.draftId) savingDrafts.delete(pending.draftId);
    uncertain = null;
    notice = `${pending.body.operation === "send" ? "Feedback sent" : pending.body.operation === "end" ? "Shared review ended" : "Saved"}.`;
    // Acceptance is independent of whether the subsequent read succeeds.
    try { await refresh(); } catch { notice += " Refresh failed; do not repeat accepted work."; }
    return result.receipt;
  }
  function mutate(operation: Mutation["operation"], fields: Record<string, unknown> = {}, accepted: Pending["accepted"] = () => {}, expectedVersion?: number, draftId?: string) {
    const task = serial.then(async () => {
      if (disposed) throw new Error("Review connection closed.");
      if (uncertain) throw new Error("Reconcile the unconfirmed request before another mutation.");
      if (!review) throw new Error("Review has not loaded.");
      const input = { operation, ...reference, requestId: (options.id ?? (() => crypto.randomUUID()))(),
        expectedVersion: expectedVersion ?? review.version, ...fields };
      const body = operation === "abandon" ? abandonRequestSchema.parse(input) : reviewerMutationSchema.parse(input);
      busy = true; error = ""; publish();
      const pending: Pending = { body, accepted, draftId, message: "Acceptance is unknown. Check the receipt or retry this exact request; a lookup miss is not rejection." };
      try { return await accept(pending); }
      catch (cause) {
        if (!(cause instanceof ApiError) || cause.status >= 500) uncertain = pending;
        fail(cause);
        if (!uncertain) { try { await refresh(); } catch { /* Visible refresh error is retained. */ } }
        throw cause;
      } finally { busy = false; publish(); }
    });
    serial = task.then(() => {}, () => {});
    return task;
  }
  async function saveDraft(id: string) {
    const draft = id === "new" ? newMessage?.draft : drafts.get(id);
    if (!writable() || !draft || draft.composing || !draft.text.trim() || savingDrafts.has(id)) return;
    savingDrafts.add(id);
    const saved = { ...draft }, target = newMessage;
    const operation = id === "new" ? "create-thread" : draft.messageId ? "update-message" : "reply";
    const fields = {
      body: saved.text, intent: saved.intent,
      ...(id === "new" && target ? { pageKey: target.pageKey, target: target.target } : { threadId: id }),
      ...(saved.messageId ? { messageId: saved.messageId, messageVersion: saved.messageVersion } : {}),
    };
    publish();
    try {
      await mutate(operation, fields, () => {
        const current = id === "new" ? newMessage?.draft : drafts.get(id);
        if (current === draft && draftEqual(draft, saved)) {
          if (id === "new") newMessage = null; else drafts.delete(id);
        } else if (current === draft && saved.messageVersion !== null) {
          draft.messageVersion = saved.messageVersion + 1;
        }
      }, undefined, id);
    } finally {
      if (uncertain?.draftId !== id) savingDrafts.delete(id);
      publish();
    }
  }
  async function send() {
    if (!writable() || busy || confirming || dispatching || note.composing) return;
    dispatching = true; publish();
    try {
      await options.barrier();
      await refresh();
      for (const thread of threads) {
        if (!thread.pendingMessageCount) continue;
        const context = await readContext(thread.thread.threadId, 1, thread.pendingMessageCount);
        contexts.set(thread.thread.threadId, context);
      }
      const selected = pendingSelection();
      if (!selected) throw new Error("Pending feedback selection is incomplete. Refresh the review before sending.");
      const sentNote = { ...note };
      if (status?.blockers.some((blocker) => blocker.targetKeys.some((key) => key === reference.entryKey || selected.pageKeys.includes(key)))) {
        throw new Error("Send is blocked by outstanding work on this entry or a selected page.");
      }
      if (!selected.messages.length && !selected.edits.length && !selected.overallNote) throw new Error("Select saved pending messages or edits, or write an overall note.");
      captureNotice = "";
      try { await options.baseline(); }
      catch (cause) { captureNotice = `Comparison baseline unavailable: ${cause instanceof Error ? cause.message : cause}. Feedback delivery is independent.`; publish(); }
      await mutate("send", {
        pageKeys: selected.pageKeys, messages: selected.messages, edits: selected.edits,
        ...(selected.overallNote ? { overallNote: selected.overallNote } : {}),
      }, () => { if (draftEqual(note, sentNote)) note = conversationDraft(); });
    } finally { dispatching = false; publish(); }
  }
  async function recordEdit(pageKey: string, contentInput: unknown) {
    let content = directEditContentSchema.parse(contentInput);
    const candidates = edits.filter((edit) => edit.pageKey === pageKey && edit.content.label === content.label && edit.content.kind === content.kind &&
      edit.content.before === content.before && edit.content.before_html === content.before_html);
    if (candidates.length > 1) throw new Error("This edit matches multiple pending records. Source identification is required.");
    const prior = candidates[0];
    const retained = [...edits.filter((edit) => edit.pageKey === pageKey),
      ...[...submissions.values()].flatMap((item) => item.submission.edits.filter((edit) => edit.pageKey === pageKey))]
      .flatMap((edit) => edit.content.staged_assets)
      .filter((asset) => content.before_html?.includes(asset.preview_src) || content.after_html?.includes(asset.preview_src));
    content = directEditContentSchema.parse({ ...content,
      staged_assets: [...new Map([...retained, ...content.staged_assets].map((asset) => [asset.id, asset])).values()] });
    return mutate("record-edit", { pageKey, content, ...(prior ? { editId: prior.editId, editVersion: prior.version } : {}) },
      (receipt) => { if (receipt.value.editId) lastRecorded.set(pageKey, receipt.value.editId); });
  }
  async function saveHtml(pageKey: string, html: string, expectedSourceHash: string) {
    const pending = edits.filter((edit) => edit.pageKey === pageKey && edit.source.state !== "saved");
    const edit = pending.find((item) => item.editId === lastRecorded.get(pageKey));
    if (!edit) throw new Error("HTML cannot be saved without an exact pending edit record.");
    const receipt = await mutate("save-edit", { pageKey, editId: edit.editId, editVersion: edit.version, html, expectedSourceHash });
    try {
      const exact = (await all("edits", directEditPageSchema)).find((item) => item.editId === edit.editId &&
        item.pageKey === pageKey && item.reviewId === reference.reviewId && item.version === edit.version);
      const current = await post({ operation: "read-page", ...reference, pageKey }, reviewPageSchema);
      if (!exact || current.page.pageKey !== pageKey || current.reviewId !== reference.reviewId) throw new Error("Exact saved edit or page is unavailable.");
      validateSaveEvidence(exact, current.page.sourceHash, current.savePolicy === "writable");
      if (exact.source.state !== "saved") throw new Error("Exact save evidence is unavailable.");
      return { hash: exact.source.evidence.sourceHash };
    } catch (cause) {
      throw new Error(`Source save accepted (${receipt.requestId}), but current source verification failed. Reload source; do not repeat the write. ${cause instanceof Error ? cause.message : cause}`);
    }
  }
  return {
    getSnapshot: store.getSnapshot, subscribe: store.subscribe, refresh, mutate, recordEdit, saveHtml,
    readingAnchor(id: string) { return readingAnchors.get(id); },
    rememberReadingAnchor(id: string, value: { messageId: string; offset: number }) {
      if (Number.isFinite(value.offset)) readingAnchors.set(id, value);
    },
    readingPosition(id: string, host: "feedback" | "focus") { return readingPositions.get(id)?.[host] ?? 0; },
    rememberReadingPosition(id: string, host: "feedback" | "focus", top: number) {
      if (!Number.isFinite(top) || top < 0) return;
      readingPositions.set(id, { feedback: 0, focus: 0, ...readingPositions.get(id), [host]: top });
    },
    reference, get review() { return review; }, get pages() { return pages; },
    get draftsPresent() { return draftCount() > 0; },
    report: fail,
    commands: {
      open(value = true) { open = value; publish(); },
      connected(value: boolean) { connected = value; publish(); },
      filter(kind: "open" | "resolved") { filters = { ...filters, [kind]: !filters[kind] }; publish(); },
      collapse(id: string) { if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id); publish(); },
      focus(id: string | null) {
        if (!id) revealFocusedThread();
        focusId = id; host = id ? "focus" : "feedback"; open = true; publish();
      },
      adjacent(id: string) {
        if (!threads.some((item) => item.thread.threadId === id)) throw new Error("Conversation is not in this review.");
        focusId = id; host = "adjacent"; open = true; collapsed.delete(id); publish();
      },
      fallback() {
        if (host !== "adjacent") return;
        revealFocusedThread();
        host = "feedback"; focusId = null; publish();
      },
      markRead(id: string) { attention.delete(id); publish(); },
      select(id: string, selected: boolean) { if (selected) excluded.delete(id); else excluded.add(id); publish(); },
      compose() { if (newMessage) { open = true; focusId = null; host = "compose"; publish(); } },
      begin(pageKey: string, target: ConversationTarget, contextual = false) {
        if (!writable()) return false;
        if (newMessage && (newMessage.draft.text || newMessage.draft.composing || savingDrafts.has("new"))) {
          throw new Error("Save or cancel the existing new-message draft first.");
        }
        newMessage = { pageKey, target, draft: conversationDraft() }; open = true; focusId = null; host = contextual ? "compose" : "feedback"; publish();
        return true;
      },
      reply(id: string) { if (writable() && !drafts.has(id)) { drafts.set(id, conversationDraft()); collapsed.delete(id); publish(); } },
      edit(message: ReviewerMessage) {
        if (!writable() || message.submissionId !== null) return;
        const current = drafts.get(message.threadId);
        if (current?.text) throw new Error("Save or cancel this thread's draft first.");
        drafts.set(message.threadId, { ...conversationDraft(), text: message.body, intent: message.intent,
          selectionStart: message.body.length, selectionEnd: message.body.length, messageId: message.messageId, messageVersion: message.version });
        publish();
      },
      update(id: string, value: Partial<ConversationDraft>) {
        const draft = id === "note" ? note : id === "new" ? newMessage?.draft : drafts.get(id);
        if (review?.state === "open" && draft) { Object.assign(draft, value); publish(); }
      },
      cancelDraft(id: string) {
        if (review?.state !== "open" || savingDrafts.has(id)) return;
        if (id === "new") newMessage = null; else drafts.delete(id);
        publish();
      },
      saveDraft, send, refresh,
      async earlier(id: string) {
        const current = contexts.get(id);
        if (!current) contexts.set(id, await readContext(id, 50));
        else if (!historyOpened.has(id) && current.items.length > displayExchanges(threads.find((thread) => thread.thread.threadId === id)!).length) {
          historyOpened.add(id); publish(); return;
        }
        else if (current.nextCursor) {
          const next = await page("context", contextPageSchema, { cursor: current.nextCursor }, id);
          contexts.set(id, { ...current, items: [...next.items, ...current.items], nextCursor: next.nextCursor });
        }
        historyOpened.add(id);
        publish();
      },
      historyEarlier() {
        if (historyLoading) return historyLoading;
        if (!historyCursor) return Promise.resolve();
        historyDepth = history.length + 50;
        historyLoading = refresh().finally(() => { historyLoading = null; });
        return historyLoading;
      },
      navigate: options.navigate, jump: options.jump,
      confirm(action: Confirmation["action"], id = "") {
        if (!review || busy || confirming || dispatching || uncertain) return;
        if (action !== "abandon" && !writable()) return;
        const thread = threads.find((item) => item.thread.threadId === id);
        const work = submissions.get(id)?.submission;
        if ((action === "resolve" || action === "delete") && drafts.get(id)?.text) throw new Error("Save or cancel this thread's local draft before changing its status.");
        confirmation = { action, id, version: action === "abandon" ? work?.version ?? 0 : review.version,
          description: action === "end" ? `End review ${review.reviewId} for every tab. Accepted source work continues. Saved-unsent items stay read-only here and never transfer to a new review. ${draftCount()} local drafts are not durable.`
            : action === "abandon" ? `Abandon submission ${id} in review ${review.reviewId}. Stop the old agent and check source before proceeding. This stops redelivery and releases exclusion; it cannot cancel external work or undo file writes.`
              : action === "revert" ? "Revert only source writes owned by this review. Exact saved-unsent edit records remain as source-pending feedback."
                : action === "delete" ? "Delete this never-submitted thread? Saved messages in it will be removed."
                  : `${thread?.thread.status === "resolved" ? "Reopen" : "Resolve"} this thread? Closing or collapsing a thread never resolves it.` };
        publish();
      },
      cancelConfirmation() { if (!busy && !confirming) { confirmation = null; publish(); } },
      async confirmAction() {
        const owned = confirmation;
        if (!owned || busy || confirming || dispatching || uncertain || !review) return;
        confirming = true; publish();
        try {
          if (owned.action === "end") {
            await options.barrier();
            await mutate("end", { confirmUnsentReadOnly: true }, () => { confirmation = null; }, owned.version);
          } else if (owned.action === "abandon") {
            await mutate("abandon", { submissionId: owned.id, confirmExternalWorkMayContinue: true, reason: owned.description },
              () => { confirmation = null; }, owned.version);
          } else if (owned.action === "revert") {
            await options.revert(); confirmation = null; publish();
          } else {
            if (drafts.get(owned.id)?.text) throw new Error("Save or cancel the local draft first.");
            const thread = threads.find((item) => item.thread.threadId === owned.id);
            await mutate(owned.action === "delete" ? "delete-thread" : "set-thread-status",
              { threadId: owned.id, ...(owned.action === "resolve" ? { status: thread?.thread.status === "open" ? "resolved" : "open" } : {}) },
              () => { confirmation = null; }, owned.version);
          }
        } finally { confirming = false; publish(); }
      },
      async reconcile(retry: boolean) {
        const pending = uncertain;
        if (!pending || busy) return;
        busy = true; publish();
        let retrying = false;
        try {
          const lookup = await post({ operation: "receipt", ...reference, requestId: pending.body.requestId }, receiptLookupSchema);
          if (lookup.state === "not-found" && !retry) {
            pending.message = "Receipt not found. Acceptance remains unknown; do not create a new request or repeat source work.";
            return;
          }
          retrying = true;
          await accept(pending);
        } catch (cause) {
          fail(cause);
          if (retrying && cause instanceof ApiError && cause.status < 500 && cause.status !== 401 && cause.status !== 403) {
            if (pending.draftId) savingDrafts.delete(pending.draftId);
            uncertain = null;
            notice = "The exact retry was rejected. Local conversation drafts are retained; inspect source separately before retrying a failed write.";
            try { await refresh(); } catch { /* The authoritative read error remains visible. */ }
          }
        }
        finally { busy = false; publish(); }
      },
    },
    dispose() { disposed = true; store.dispose(); },
  };
}
export type ConversationController = ReturnType<typeof createConversationController>;

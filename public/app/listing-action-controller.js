/*
 * Listing decisions are optimistic in the dashboard.  This controller owns
 * the transient request, hidden-row, and undo state so the feed only needs to
 * provide rendering and reconciliation callbacks.
 */

export function createListingActionController({
  api,
  getData,
  getItems,
  getFiltersKey,
  roleKey,
  isRoleFeedView,
  isSavedRoleView,
  applyOptimisticCounts,
  applyPayload,
  invalidate,
  removeRole,
  restoreRole,
  removeNotifications,
  ensureRolesLoaded,
  showToast,
}) {
  if (!api?.saveAction || !api?.undoAction) throw new Error("Listing action API is required");
  if (typeof roleKey !== "function") throw new Error("Listing action key resolver is required");

  const pending = new Set();
  const requests = new Map();
  const hidden = new Set();
  const undoStack = [];

  function remember(record, context = {}) {
    const existingIndex = undoStack.findIndex((item) => item.listingKey === record.listingKey);
    if (existingIndex >= 0) undoStack.splice(existingIndex, 1);
    const optimisticRole = context.role ?? record.optimisticRole ?? null;
    const optimisticFiltersKey = context.filtersKey ?? record.optimisticFiltersKey ?? null;
    const optimisticRoleIndex = Number.isInteger(context.index)
      ? context.index
      : Number.isInteger(record.optimisticRoleIndex)
        ? record.optimisticRoleIndex
        : null;
    undoStack.push({
      ...record,
      ...(optimisticRole
        ? { optimisticRole, optimisticFiltersKey, optimisticRoleIndex }
        : {}),
    });
    return undoStack.at(-1);
  }

  function forget(key) {
    const index = undoStack.findIndex((item) => item.listingKey === key);
    if (index >= 0) undoStack.splice(index, 1);
  }

  function visible(items) {
    return (Array.isArray(items) ? items : []).filter((role) => {
      const key = roleKey(role);
      return !pending.has(key) && !hidden.has(key);
    });
  }

  function canRestoreLocally(action) {
    return isRoleFeedView()
      && !isSavedRoleView()
      && Boolean(action?.optimisticRole)
      && action.optimisticFiltersKey === getFiltersKey();
  }

  async function save(input) {
    const {
      listingType,
      listingId,
      action,
      company,
      title,
      applicationUrl = "",
      postingUrl = "",
      jobId = "",
      location = "",
    } = input || {};
    const key = listingType && listingId ? `${listingType}:${listingId}` : "";
    if (!listingType || !listingId || !action || !company || !title || !getData() || !key || pending.has(key) || requests.has(key)) return null;

    const items = getItems() || [];
    const optimisticRoleIndex = items.findIndex((role) => roleKey(role) === key);
    const optimisticRole = optimisticRoleIndex >= 0 ? items[optimisticRoleIndex] : null;
    const actionRecord = remember({
      listingKey: key,
      listingType,
      listingId,
      action,
      company,
      title,
      createdAt: new Date().toISOString(),
    }, {
      role: optimisticRole,
      filtersKey: getFiltersKey(),
      index: optimisticRoleIndex,
    });

    pending.add(key);
    // Keep every decision suppressed until it is undone.  The server response
    // can arrive before its read-side cache has finished invalidating.
    hidden.add(key);
    applyOptimisticCounts(actionRecord, 1);
    removeRole(key);

    const successMessage = action === "applied" ? `Applied · ${company}` : `Hidden · ${title}`;
    showToast(successMessage, {
      label: "Undo",
      onClick: () => { void undoLast(); },
    });

    let requestPromise = null;
    try {
      requestPromise = api.saveAction({
        listingType,
        listingId,
        action,
        company,
        title,
        applicationUrl,
        postingUrl,
        jobId,
        location,
      });
      requests.set(key, requestPromise);
      const payload = await requestPromise;
      pending.delete(key);
      if (actionRecord.undoRequested) {
        // Undo already restored the local queue.  Do not paint committed
        // action counts while its DELETE is waiting behind this POST.
        invalidate();
        return payload;
      }
      invalidate();
      removeNotifications(key);
      applyPayload(payload);
      showToast(successMessage, {
        label: "Undo",
        onClick: () => { void undoLast(); },
      });
      // Reconcile in the background; it should not delay action feedback.
      void ensureRolesLoaded({ silent: true, skipMotion: true });
      return payload;
    } catch (error) {
      pending.delete(key);
      if (actionRecord.undoRequested) return null;
      if (action === "cant_fit") {
        // “Can't fit” is a local triage action. Keep the row hidden and let the
        // server catch up without surfacing a database/network error here.
        invalidate();
        removeNotifications(key);
        void ensureRolesLoaded({ silent: true, skipMotion: true });
        return null;
      }
      hidden.delete(key);
      forget(key);
      applyOptimisticCounts(actionRecord, -1);
      invalidate();
      if (optimisticRole) restoreRole(optimisticRole, optimisticRoleIndex);
      await ensureRolesLoaded({ silent: true, skipMotion: true });
      showToast(error?.message || "Could not save listing decision");
      return null;
    } finally {
      if (!actionRecord.undoRequested && requests.get(key) === requestPromise) requests.delete(key);
    }
  }

  function undoLast() {
    const action = undoStack.at(-1);
    if (!action) return null;
    forget(action.listingKey);
    action.undoRequested = true;
    const saveRequest = requests.get(action.listingKey);
    pending.delete(action.listingKey);
    hidden.delete(action.listingKey);
    applyOptimisticCounts(action, -1);
    invalidate();
    let restoredLocally = false;
    if (canRestoreLocally(action)) restoredLocally = restoreRole(action.optimisticRole, action.optimisticRoleIndex);
    showToast(`Restored · ${action.title}`);
    void reconcileUndone(action, saveRequest, restoredLocally);
    return action;
  }

  async function reconcileUndone(action, saveRequest, restoredLocally) {
    try {
      // Serialize the server undo behind the original mutation. A DELETE sent
      // before the POST can otherwise leave the action committed after restore.
      if (saveRequest) {
        try { await saveRequest; } catch { /* DELETE is still safe if POST failed. */ }
      }
      const payload = await api.undoAction(action.listingType, action.listingId);
      if (requests.get(action.listingKey) === saveRequest) requests.delete(action.listingKey);
      applyPayload(payload);
      void ensureRolesLoaded({ silent: true, skipMotion: true });
    } catch (error) {
      if (restoredLocally) {
        hidden.add(action.listingKey);
        removeRole(action.listingKey);
        applyOptimisticCounts(action, 1);
        action.undoRequested = false;
        remember(action);
      }
      showToast(error?.message || "Could not undo listing decision");
    } finally {
      if (requests.get(action.listingKey) === saveRequest) requests.delete(action.listingKey);
    }
  }

  return {
    save,
    undoLast,
    visible,
    isPending: (key) => pending.has(key),
    isHidden: (key) => hidden.has(key),
    hasUndo: () => undoStack.length > 0,
    snapshot: () => ({ pending: new Set(pending), hidden: new Set(hidden), undo: [...undoStack] }),
  };
}

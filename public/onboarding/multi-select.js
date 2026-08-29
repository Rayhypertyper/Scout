/* global document */

const MAX_VISIBLE_OPTIONS = 12;
let selectorInstanceCounter = 0;

function normalize(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().trim();
}

function textValue(value) {
  return value == null ? "" : String(value);
}

function idPart(value) {
  return textValue(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "selector";
}

export function createSelectorOptionId(instanceId, ordinal) {
  const index = Number.isFinite(ordinal) && ordinal > 0 ? Math.floor(ordinal) : 1;
  return `${idPart(instanceId)}-option-${index}`;
}

export function activeDescendantOptionId(activeKey, visibleKeys, idsByKey) {
  if (activeKey == null) return null;
  const key = textValue(activeKey);
  const visible = new Set((Array.isArray(visibleKeys) ? visibleKeys : []).map(textValue));
  if (!visible.has(key)) return null;
  const id = idsByKey instanceof Map ? idsByKey.get(key) : idsByKey?.[key];
  return id ? textValue(id) : null;
}

export function selectionAfterToggle(keys, key, maximum = Number.POSITIVE_INFINITY) {
  const current = [...new Set((Array.isArray(keys) ? keys : []).map(textValue))];
  const normalizedKey = textValue(key);
  if (current.includes(normalizedKey)) {
    return {
      keys: current.filter((candidate) => candidate !== normalizedKey),
      selected: false,
      changed: true,
      blocked: false,
    };
  }
  const limit = Number.isFinite(maximum) ? Math.max(0, Math.floor(maximum)) : Number.POSITIVE_INFINITY;
  if (current.length >= limit) return { keys: current, selected: false, changed: false, blocked: true };
  return { keys: [...current, normalizedKey], selected: true, changed: true, blocked: false };
}

export function nextActiveKey(keys, activeKey, direction) {
  const candidates = [...new Set((Array.isArray(keys) ? keys : []).map(textValue))];
  if (candidates.length === 0) return null;

  const current = activeKey == null ? -1 : candidates.indexOf(textValue(activeKey));
  if (direction === "first") return candidates[0];
  if (direction === "last") return candidates.at(-1) || null;
  if (direction === "previous") {
    return current < 0 ? candidates.at(-1) || null : candidates[Math.max(0, current - 1)] || null;
  }
  if (direction === "next") {
    return current < 0 ? candidates[0] : candidates[Math.min(current + 1, candidates.length - 1)];
  }
  return current < 0 ? candidates[0] : candidates[current] || null;
}

function removeIcon() {
  return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
}

function closestElement(target, selector) {
  return target && typeof target.closest === "function" ? target.closest(selector) : null;
}

export function createSearchMultiSelect({
  input,
  list,
  selectedList,
  options = [],
  keyForOption = (option) => option.value,
  labelForOption = (option) => option.label,
  detailForOption = () => "",
  emptyLabel = "No selections yet.",
  noResultsLabel = "No matching options.",
  emptyOptionsLabel = "No options available.",
  selectionContext = "selections",
  maximum = Number.POSITIVE_INFINITY,
  onChange = () => undefined,
}) {
  if (!input || !list || !selectedList) {
    throw new TypeError("Search multi-select requires an input, option list, and selected list.");
  }

  const maxSelections = Number.isFinite(maximum) ? Math.max(0, Math.floor(maximum)) : Number.POSITIVE_INFINITY;
  const instanceNumber = ++selectorInstanceCounter;
  const instanceId = `search-select-${instanceNumber}-${idPart(input.id || list.id || "options")}`;
  if (!list.id) list.id = `${instanceId}-list`;

  let selectedKeys = [];
  let activeKey = null;
  const optionIds = new Map();

  function optionKeyFor(option) {
    return textValue(keyForOption(option));
  }

  function normalizeOptions(nextOptions) {
    const seen = new Set();
    return (Array.isArray(nextOptions) ? nextOptions : []).filter((option) => {
      const key = optionKeyFor(option);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  let normalizedOptions = normalizeOptions(options);

  function optionForKey(key) {
    const normalizedKey = textValue(key);
    return normalizedOptions.find((option) => optionKeyFor(option) === normalizedKey) || null;
  }

  function selectedOptions() {
    return selectedKeys.map(optionForKey).filter(Boolean);
  }

  function labelFor(option) {
    return textValue(labelForOption(option));
  }

  function detailFor(option) {
    return textValue(detailForOption(option));
  }

  const status = document.createElement("p");
  status.className = "visually-hidden search-status";
  status.id = `${instanceId}-status`;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  selectedList.parentNode?.insertBefore(status, selectedList);

  const emptyMessage = document.createElement("p");
  emptyMessage.className = "search-empty";
  emptyMessage.setAttribute("aria-hidden", "true");
  emptyMessage.hidden = true;
  list.parentNode?.insertBefore(emptyMessage, list.nextSibling);

  const describedBy = new Set((input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
  describedBy.add(status.id);
  input.setAttribute("aria-describedby", [...describedBy].join(" "));
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-multiselectable", "true");

  function setStatus(message) {
    status.textContent = message;
  }

  function matchingOptions() {
    const query = normalize(input.value);
    return normalizedOptions.filter((option) => {
      const haystack = normalize(`${labelFor(option)} ${detailFor(option)}`);
      return !query || haystack.includes(query);
    });
  }

  function visibleOptions() {
    return matchingOptions().slice(0, MAX_VISIBLE_OPTIONS);
  }

  function isSelectedKey(key) {
    return selectedKeys.includes(textValue(key));
  }

  function isDisabledKey(key) {
    return !isSelectedKey(key)
      && Number.isFinite(maxSelections)
      && selectedKeys.length >= maxSelections;
  }

  function navigableOptions() {
    return visibleOptions().filter((option) => !isDisabledKey(optionKeyFor(option)));
  }

  function statusSummary() {
    const matching = matchingOptions();
    const selected = `${selectedKeys.length} selected.`;
    if (normalizedOptions.length === 0) return `${emptyOptionsLabel} ${selected}`;
    if (matching.length === 0) return `${noResultsLabel} ${selected}`;
    const shown = Math.min(matching.length, MAX_VISIBLE_OPTIONS);
    const count = `${matching.length} matching option${matching.length === 1 ? "" : "s"} available.`;
    const showing = matching.length > shown ? ` Showing first ${shown}.` : "";
    const maximumMessage = Number.isFinite(maxSelections)
      && selectedKeys.length >= maxSelections
      && normalizedOptions.some((option) => !isSelectedKey(optionKeyFor(option)))
      ? ` Maximum of ${maxSelections} selected.`
      : "";
    return `${count}${showing} ${selected}${maximumMessage}`;
  }

  function syncEmptyMessage() {
    const matching = matchingOptions();
    const shouldShow = !list.hidden && matching.length === 0;
    emptyMessage.hidden = !shouldShow;
    if (shouldShow) emptyMessage.textContent = normalizedOptions.length === 0 ? emptyOptionsLabel : noResultsLabel;
  }

  function syncActiveDescendant() {
    const nodes = [...list.querySelectorAll('[role="option"][data-option-key]')];
    const nodeByKey = new Map(nodes.map((node) => [node.dataset.optionKey, node]));
    const activeId = activeDescendantOptionId(activeKey, [...nodeByKey.keys()], nodeByKey);
    const active = activeId ? nodeByKey.get(activeKey) : null;
    if (!active || !activeId || active.getAttribute("aria-disabled") === "true") {
      activeKey = null;
      input.removeAttribute("aria-activedescendant");
      nodes.forEach((node) => node.classList.remove("is-active"));
      return;
    }
    nodes.forEach((node) => node.classList.toggle("is-active", node === active));
    input.setAttribute("aria-activedescendant", activeId);
  }

  function renderSelected() {
    selectedList.replaceChildren();
    if (selectedKeys.length === 0) {
      const empty = document.createElement("li");
      empty.className = "is-empty";
      empty.textContent = emptyLabel;
      selectedList.append(empty);
      return;
    }
    for (const key of selectedKeys) {
      const option = optionForKey(key);
      if (!option) continue;
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = labelFor(option);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.removeSelection = key;
      remove.setAttribute("aria-label", `Remove ${labelFor(option)} from ${selectionContext}`);
      remove.innerHTML = removeIcon();
      item.append(label, remove);
      selectedList.append(item);
    }
  }

  function renderOptions() {
    const wasOpen = !list.hidden;
    list.replaceChildren();
    const matching = matchingOptions();
    const visible = matching.slice(0, MAX_VISIBLE_OPTIONS);
    const visibleKeys = new Set(visible.map(optionKeyFor));
    if (activeKey !== null && !visibleKeys.has(activeKey)) activeKey = null;

    for (const [index, option] of visible.entries()) {
      const key = optionKeyFor(option);
      if (!optionIds.has(key)) optionIds.set(key, createSelectorOptionId(instanceId, optionIds.size + 1));
      const optionNode = document.createElement("div");
      const selected = isSelectedKey(key);
      const disabled = isDisabledKey(key);
      optionNode.className = "search-option";
      optionNode.id = optionIds.get(key);
      optionNode.dataset.optionKey = key;
      optionNode.setAttribute("role", "option");
      optionNode.setAttribute("aria-selected", String(selected));
      optionNode.setAttribute("aria-setsize", String(matching.length));
      optionNode.setAttribute("aria-posinset", String(index + 1));
      if (disabled) optionNode.setAttribute("aria-disabled", "true");
      const label = document.createElement("span");
      label.textContent = labelFor(option);
      const detail = document.createElement("small");
      detail.textContent = selected ? "Selected" : detailFor(option);
      optionNode.append(label, detail);
      list.append(optionNode);
    }

    syncActiveDescendant();
    if (!wasOpen) emptyMessage.hidden = true;
    syncEmptyMessage();
    setStatus(statusSummary());
  }

  function close() {
    list.hidden = true;
    emptyMessage.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    activeKey = null;
  }

  function open() {
    renderOptions();
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    syncEmptyMessage();
  }

  function update(nextKeys, announce = true, message = "") {
    selectedKeys = [...new Set((Array.isArray(nextKeys) ? nextKeys : []).map(textValue))]
      .filter((key) => optionForKey(key))
      .slice(0, maxSelections);
    renderSelected();
    renderOptions();
    if (announce) {
      if (message) setStatus(`${message} ${statusSummary()}`);
      onChange(selectedOptions());
    }
  }

  function maximumReachedMessage() {
    return Number.isFinite(maxSelections)
      ? `Maximum of ${maxSelections} selected. Remove a selection to choose another.`
      : "That option could not be selected.";
  }

  function toggleKey(key) {
    const option = optionForKey(key);
    if (!option) return false;
    const normalizedKey = optionKeyFor(option);
    const transition = selectionAfterToggle(selectedKeys, normalizedKey, maxSelections);
    if (!transition.changed) {
      setStatus(maximumReachedMessage());
      return false;
    }
    activeKey = normalizedKey;
    update(transition.keys, true, `${labelFor(option)} ${transition.selected ? "selected" : "removed"}.`);
    return true;
  }

  function focusIsInside(nextTarget) {
    if (!nextTarget || typeof nextTarget !== "object") return false;
    if (nextTarget === input) return true;
    if (typeof nextTarget.nodeType !== "number") return false;
    return list.contains(nextTarget) || selectedList.contains(nextTarget);
  }

  input.addEventListener("focus", open);
  input.addEventListener("focusout", (event) => {
    if (!focusIsInside(event.relatedTarget)) close();
  });
  input.addEventListener("input", () => {
    activeKey = null;
    open();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open();
      activeKey = nextActiveKey(
        navigableOptions().map(optionKeyFor),
        activeKey,
        event.key === "ArrowDown" ? "next" : "previous",
      );
      syncActiveDescendant();
      return;
    }
    if (!list.hidden && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      activeKey = nextActiveKey(
        navigableOptions().map(optionKeyFor),
        activeKey,
        event.key === "Home" ? "first" : "last",
      );
      syncActiveDescendant();
      return;
    }
    if (event.key === "Enter" && !list.hidden) {
      event.preventDefault();
      const key = activeKey ?? nextActiveKey(navigableOptions().map(optionKeyFor), null, "next");
      if (key !== null) {
        toggleKey(key);
        input.focus();
      }
    }
  });

  list.addEventListener("click", (event) => {
    const optionNode = closestElement(event.target, '[data-option-key]');
    if (!optionNode) return;
    const key = optionNode.dataset.optionKey;
    if (key == null) return;
    activeKey = key;
    toggleKey(key);
    input.focus();
  });

  list.addEventListener("pointerover", (event) => {
    const optionNode = closestElement(event.target, '[data-option-key]');
    if (!optionNode || optionNode.getAttribute("aria-disabled") === "true") return;
    activeKey = optionNode.dataset.optionKey || null;
    syncActiveDescendant();
  });

  list.addEventListener("focusout", (event) => {
    if (!focusIsInside(event.relatedTarget)) close();
  });

  selectedList.addEventListener("click", (event) => {
    const button = closestElement(event.target, "button[data-remove-selection]");
    if (!button) return;
    const key = button.dataset.removeSelection;
    if (key == null) return;
    const option = optionForKey(key);
    const message = option ? `${labelFor(option)} removed.` : "Selection removed.";
    update(selectedKeys.filter((candidate) => candidate !== key), true, message);
    input.focus();
  });

  selectedList.addEventListener("focusout", (event) => {
    if (!focusIsInside(event.relatedTarget)) close();
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target && (target === input || list.contains(target) || selectedList.contains(target))) return;
    close();
  });

  renderSelected();
  renderOptions();

  return {
    values: selectedOptions,
    toggle(value) {
      return toggleKey(value);
    },
    setOptions(nextOptions) {
      normalizedOptions = normalizeOptions(nextOptions);
      update(selectedKeys, false);
    },
    setValues(nextOptions) {
      update((Array.isArray(nextOptions) ? nextOptions : []).map(optionKeyFor), false);
    },
    focus() {
      input.focus();
    },
    close,
  };
}

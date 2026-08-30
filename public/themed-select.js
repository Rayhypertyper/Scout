/* global document, window, HTMLSelectElement, MutationObserver, Node, Event */

const instances = new Set();
let nextId = 0;

function nextElementId(prefix) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function selectLabel(select) {
  const label = select.closest("label");
  if (!label) return "Choose an option";
  const explicitLabel = label.getAttribute("aria-label")?.trim();
  if (explicitLabel) return explicitLabel;
  const labelNode = label.querySelector(".filter-label, .settings-field > span, .field-control > span, .menu-field > span");
  if (labelNode) return labelNode.textContent.replace(/\s+/g, " ").trim();
  const labelClone = label.cloneNode(true);
  labelClone.querySelector("select")?.remove();
  return (labelClone.textContent || "Choose an option").replace(/\s+/g, " ").trim();
}

function optionData(select) {
  return [...select.options]
    .filter((option) => !option.hidden)
    .map((option) => ({
      value: option.value,
      label: option.textContent.trim(),
      disabled: option.disabled,
      selected: option.selected,
    }));
}

function optionButtonDisabled(button) {
  return Boolean(button?.disabled) || button?.getAttribute("aria-disabled") === "true";
}

function nativeSelectValueDescriptor() {
  return Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
}

function closeOtherSelects(current) {
  instances.forEach((instance) => {
    if (instance !== current) instance.close({ restoreFocus: false });
  });
}

function enhanceSelect(select) {
  if (!(select instanceof HTMLSelectElement) || select.dataset.themedSelectEnhanced === "true") return null;

  const root = document.createElement("div");
  root.className = "themed-select";
  root.dataset.themedSelectRoot = "true";
  if (select.multiple) root.dataset.multiple = "true";
  if (select.closest(".sort-select")) root.dataset.align = "end";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "themed-select-trigger";
  trigger.id = nextElementId("themed-select-trigger");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", selectLabel(select));
  if (select.getAttribute("aria-describedby")) {
    trigger.setAttribute("aria-describedby", select.getAttribute("aria-describedby"));
  }

  const value = document.createElement("span");
  value.className = "themed-select-value";
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.classList.add("themed-select-chevron");
  chevron.setAttribute("viewBox", "0 0 24 24");
  chevron.setAttribute("fill", "none");
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML = '<path d="m7 10 5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />';
  trigger.append(value, chevron);

  const menu = document.createElement("div");
  menu.className = "themed-select-menu";
  menu.id = nextElementId("themed-select-menu");
  menu.setAttribute("role", "listbox");
  if (select.multiple) menu.setAttribute("aria-multiselectable", "true");
  menu.setAttribute("aria-label", selectLabel(select));
  menu.hidden = true;
  trigger.setAttribute("aria-controls", menu.id);

  const instance = {
    select,
    root,
    trigger,
    menu,
    value,
    optionButtons: [],
    open({ focus = true } = {}) {
      const options = optionData(select);
      if (select.disabled || !options.some((option) => !option.disabled)) return;
      closeOtherSelects(instance);
      instance.render();
      root.classList.add("is-open");
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      const selectedIndex = select.multiple
        ? options.findIndex((option) => option.selected)
        : select.selectedIndex;
      if (focus) instance.focusOption(selectedIndex >= 0 ? selectedIndex : 0);
    },
    close({ restoreFocus = false } = {}) {
      if (menu.hidden) return;
      menu.hidden = true;
      root.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-activedescendant");
      if (restoreFocus) trigger.focus();
    },
    focusOption(index) {
      const firstEnabled = instance.optionButtons.findIndex((button) => !optionButtonDisabled(button));
      if (firstEnabled < 0) return;
      let nextIndex = Math.max(0, Math.min(index, instance.optionButtons.length - 1));
      if (optionButtonDisabled(instance.optionButtons[nextIndex])) nextIndex = firstEnabled;
      const optionButton = instance.optionButtons[nextIndex];
      if (!optionButton) return;
      optionButton.focus();
      trigger.setAttribute("aria-activedescendant", optionButton.id);
    },
    moveOption(current, delta) {
      const enabled = instance.optionButtons
        .map((button, index) => ({ button, index }))
        .filter(({ button }) => !optionButtonDisabled(button));
      if (!enabled.length) return;
      const position = Math.max(0, enabled.findIndex(({ button }) => button === current));
      const next = enabled[(position + delta + enabled.length) % enabled.length];
      instance.focusOption(next.index);
    },
    choose(optionButton) {
      if (!optionButton || optionButtonDisabled(optionButton)) return;
      const nextValue = optionButton.dataset.value || "";
      if (select.multiple) {
        const options = [...select.options];
        const selectedOption = options.find((option) => option.value === nextValue);
        if (!selectedOption) return;
        const allValue = select.dataset.multiSelectAllValue;
        const allOption = allValue ? options.find((option) => option.value === allValue) : null;
        if (allOption && nextValue === allValue) {
          options.forEach((option) => { option.selected = option === allOption; });
        } else {
          selectedOption.selected = !selectedOption.selected;
          if (allOption) {
            allOption.selected = false;
            if (!options.some((option) => option !== allOption && option.selected)) allOption.selected = true;
          }
        }
        select.dispatchEvent(new Event("change", { bubbles: true }));
        instance.sync();
        if (!menu.hidden) {
          const nextIndex = instance.optionButtons.findIndex((button) => button.dataset.value === nextValue);
          instance.focusOption(nextIndex >= 0 ? nextIndex : 0);
        }
        return;
      }
      select.value = nextValue;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      instance.sync();
      instance.close({ restoreFocus: true });
    },
    render() {
      const options = optionData(select);
      menu.replaceChildren();
      instance.optionButtons = [];
      options.forEach((option) => {
        const optionButton = document.createElement(select.multiple ? "label" : "button");
        if (!select.multiple) optionButton.type = "button";
        optionButton.className = "themed-select-option";
        optionButton.id = nextElementId("themed-select-option");
        optionButton.setAttribute("role", "option");
        optionButton.dataset.value = option.value;
        optionButton.setAttribute("aria-selected", String(option.selected));
        if (select.multiple) {
          if (option.disabled) optionButton.setAttribute("aria-disabled", "true");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "themed-select-option-check";
          checkbox.checked = option.selected;
          checkbox.disabled = option.disabled;
          checkbox.tabIndex = -1;
          checkbox.setAttribute("aria-hidden", "true");
          const label = document.createElement("span");
          label.textContent = option.label || "Unnamed option";
          optionButton.append(checkbox, label);
          optionButton.addEventListener("click", (event) => {
            event.preventDefault();
            instance.choose(optionButton);
          });
        } else {
          optionButton.textContent = option.label || "Unnamed option";
          optionButton.disabled = option.disabled;
          optionButton.addEventListener("click", () => instance.choose(optionButton));
        }
        optionButton.addEventListener("keydown", (event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            instance.moveOption(optionButton, 1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            instance.moveOption(optionButton, -1);
          } else if (event.key === "Home") {
            event.preventDefault();
            instance.focusOption(0);
          } else if (event.key === "End") {
            event.preventDefault();
            instance.focusOption(instance.optionButtons.length - 1);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            instance.choose(optionButton);
          } else if (event.key === "Escape") {
            event.preventDefault();
            instance.close({ restoreFocus: true });
          } else if (event.key === "Tab") {
            instance.close({ restoreFocus: false });
          }
        });
        menu.append(optionButton);
        instance.optionButtons.push(optionButton);
      });
      if (!options.length) {
        const empty = document.createElement("p");
        empty.className = "themed-select-empty";
        empty.setAttribute("role", "status");
        empty.textContent = "No options available";
        menu.append(empty);
      }
    },
    sync() {
      const options = optionData(select);
      if (select.multiple) {
        const allValue = select.dataset.multiSelectAllValue;
        const allOption = allValue ? options.find((option) => option.value === allValue) : null;
        const selected = options.filter((option) => option.selected && option.value !== allValue);
        const selectedLabels = selected.map((option) => option.label || "Unnamed option");
        const summary = allOption?.selected
          ? allOption.label || "All options"
          : selectedLabels.length === 0
            ? "No options selected"
            : selectedLabels.length <= 2
              ? selectedLabels.join(", ")
              : `${selectedLabels.length} selected`;
        value.textContent = summary || "No options available";
        value.title = selectedLabels.length > 2 ? selectedLabels.join(", ") : summary;
      } else {
        const selected = options.find((option, index) => index === select.selectedIndex) || options[0];
        value.textContent = selected?.label || "No options available";
        value.title = selected?.label || "No options available";
      }
      trigger.disabled = select.disabled;
      if (menu.hidden === false) instance.render();
      else if (instance.optionButtons.length !== options.length) instance.render();
    },
  };

  const descriptor = nativeSelectValueDescriptor();
  if (descriptor?.get && descriptor?.set) {
    Object.defineProperty(select, "value", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() { return descriptor.get.call(this); },
      set(nextValue) {
        descriptor.set.call(this, nextValue);
        instance.sync();
      },
    });
  }

  select.dataset.themedSelectEnhanced = "true";
  select.classList.add("themed-select-native");
  select.hidden = true;
  select.setAttribute("aria-hidden", "true");
  select.tabIndex = -1;
  select.parentNode.insertBefore(root, select);
  root.append(select, trigger, menu);
  instances.add(instance);

  trigger.addEventListener("click", () => {
    if (menu.hidden) instance.open();
    else instance.close({ restoreFocus: true });
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (menu.hidden) instance.open({ focus: true });
      else instance.close({ restoreFocus: false });
    } else if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      instance.close({ restoreFocus: true });
    }
  });
  select.addEventListener("change", () => instance.sync());
  const observer = new MutationObserver(() => instance.sync());
  observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "label", "value", "selected", "hidden"] });
  instance.observer = observer;
  instance.render();
  instance.sync();
  return instance;
}

export function enhanceThemedSelects(root = document) {
  const selects = [];
  if (root instanceof HTMLSelectElement) selects.push(root);
  if (root.querySelectorAll) selects.push(...root.querySelectorAll("select"));
  selects.forEach(enhanceSelect);
  return selects;
}

export function refreshThemedSelects() {
  instances.forEach((instance) => instance.sync());
}

function initializeThemedSelects() {
  enhanceThemedSelects(document);
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Node)) return;
    instances.forEach((instance) => {
      if (!instance.root.contains(event.target)) instance.close({ restoreFocus: false });
    });
  });
  const observer = new MutationObserver((records) => {
    records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) enhanceThemedSelects(node);
    }));
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  window.refreshThemedSelects = refreshThemedSelects;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeThemedSelects, { once: true });
  else initializeThemedSelects();
}

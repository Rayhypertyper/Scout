/* global document */

(() => {
  "use strict";

  const billingButtons = [...document.querySelectorAll("[data-billing-toggle]")];
  const priceValues = [...document.querySelectorAll("[data-price]")];
  const priceUnits = [...document.querySelectorAll("[data-price-unit]")];
  const priceNotes = [...document.querySelectorAll("[data-price-note]")];

  if (!billingButtons.length) return;

  function setBillingInterval(interval) {
    billingButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.billingToggle === interval));
    });

    priceValues.forEach((price) => {
      price.textContent = price.dataset[interval] || price.textContent;
    });

    priceUnits.forEach((unit) => {
      unit.textContent = unit.dataset[interval] || unit.textContent;
    });

    priceNotes.forEach((note) => {
      note.textContent = note.dataset[interval] || note.textContent;
    });
  }

  billingButtons.forEach((button) => {
    button.addEventListener("click", () => setBillingInterval(button.dataset.billingToggle || "monthly"));
  });

  setBillingInterval("monthly");
})();

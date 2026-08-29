/* global window, document, requestAnimationFrame, fetch */

(() => {
  "use strict";

  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  const staticCapture = window.location.search.includes("static=1");
  if (staticCapture) document.documentElement.dataset.staticCapture = "true";
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;

  const nav = document.querySelector("[data-landing-nav]");
  const updateNav = () => nav?.classList.toggle("is-scrolled", window.scrollY > 24);
  updateNav();
  window.addEventListener("scroll", updateNav, { passive: true });

  const authGroup = document.querySelector("[data-landing-auth]");
  if (authGroup && !staticCapture) {
    fetch("/api/auth/session", { headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((session) => {
        if (!session?.ok || !session.authenticated) return;
        const account = document.createElement("a");
        account.className = "landing-nav-account";
        account.href = "/account";
        account.textContent = "Account";
        authGroup.replaceChildren(account);
      })
      .catch(() => {});
  }

  const filterButtons = [...document.querySelectorAll("[data-filter-step]")];
  const filterRoles = [...document.querySelectorAll("[data-filter-role]")];
  const filterCount = document.querySelector("[data-filter-count]");
  const filterSummary = document.querySelector("[data-filter-summary]");
  const countByStep = [842, 284, 96, 42, 18];
  let filterManualOverride = false;
  let filterSequenceStep = -1;
  const filterLabels = {
    country: "Canada",
    discipline: "software engineering",
    term: "Summer 2027",
    location: "remote or selected cities",
  };

  function setCount(nextValue) {
    if (!filterCount) return;
    const currentValue = Number(filterCount.textContent.replace(/[^0-9]/g, "")) || nextValue;
    if (!gsap || prefersReducedMotion) {
      filterCount.textContent = new Intl.NumberFormat().format(nextValue);
      return;
    }
    const counter = { value: currentValue };
    gsap.to(counter, {
      value: nextValue,
      duration: .38,
      ease: "power2.out",
      overwrite: true,
      onUpdate: () => { filterCount.textContent = new Intl.NumberFormat().format(Math.round(counter.value)); },
    });
  }

  function renderIllustrativeFilters() {
    const activeSteps = filterButtons
      .filter((button) => button.getAttribute("aria-pressed") === "true")
      .map((button) => button.dataset.filterStep);
    const visibleRoles = filterRoles.filter((role) => {
      const matches = String(role.dataset.match || "").split(/\s+/).filter(Boolean);
      return !activeSteps.length || matches.includes("all") || activeSteps.every((step) => matches.includes(step));
    });

    filterRoles.forEach((role) => {
      const visibleIndex = visibleRoles.indexOf(role);
      const visible = visibleIndex >= 0;
      role.setAttribute("aria-hidden", String(!visible));
      if (gsap && !prefersReducedMotion) {
        role.hidden = false;
        role.style.pointerEvents = visible ? "auto" : "none";
        gsap.to(role, {
          opacity: visible ? 1 : 0,
          scale: visible ? 1 : .97,
          y: (visible ? visibleIndex : Number(role.style.getPropertyValue("--row")) || 0) * 56,
          duration: .32,
          ease: "power2.out",
          overwrite: true,
        });
      } else if (prefersReducedMotion) {
        role.hidden = !visible;
        role.style.opacity = "";
        role.style.transform = "";
        role.style.pointerEvents = "";
      } else {
        role.hidden = !visible;
        role.style.opacity = visible ? "1" : "0";
        role.style.transform = `translateY(${(visible ? visibleIndex : Number(role.style.getPropertyValue("--row")) || 0) * 56}px)`;
        role.style.pointerEvents = visible ? "auto" : "none";
      }
    });

    setCount(countByStep[Math.min(activeSteps.length, countByStep.length - 1)]);
    if (filterSummary) {
      filterSummary.textContent = activeSteps.length
        ? `${new Intl.NumberFormat().format(countByStep[Math.min(activeSteps.length, countByStep.length - 1)])} illustrative roles after filtering for ${activeSteps.map((step) => filterLabels[step]).join(", ")}.`
        : "No illustrative filters selected.";
    }
  }

  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      filterManualOverride = true;
      const pressed = button.getAttribute("aria-pressed") === "true";
      button.setAttribute("aria-pressed", String(!pressed));
      renderIllustrativeFilters();
    });
  });
  renderIllustrativeFilters();

  const fragmentStage = document.querySelector("[data-fragment-stage]");
  const fragmentPhases = [...document.querySelectorAll("[data-fragment-phase]")];
  const fragmentIntakeStatus = document.querySelector("[data-fragment-intake-status]");
  const fragmentStatusLabels = ["Intake", "Checking", "Ready"];
  const recencyStage = document.querySelector("[data-recency-stage]");
  const recencyPhases = [...document.querySelectorAll("[data-recency-phase]")];
  const recencyStatus = document.querySelector("[data-recency-status]");
  const recencyStageLabel = document.querySelector("[data-recency-stage-label]");
  const recencyBoardSummary = document.querySelector("[data-recency-board-summary]");
  const compactRecency = window.matchMedia("(max-width: 780px)").matches;
  const handoffSection = document.querySelector("[data-handoff-section]");
  const handoffStage = document.querySelector("[data-handoff-stage]");
  const handoffSlides = [...document.querySelectorAll("[data-handoff-slide]")];
  const handoffChoices = [...document.querySelectorAll("[data-handoff-choice]")];
  const handoffPrevious = document.querySelector("[data-handoff-previous]");
  const handoffNext = document.querySelector("[data-handoff-next]");
  const handoffCurrent = document.querySelector("[data-handoff-current]");
  const handoffAnnouncer = document.querySelector("[data-handoff-announcer]");
  const handoffMarquee = document.querySelector("[data-handoff-marquee]");
  const handoffMarqueeWindow = handoffMarquee?.closest(".handoff-marquee-window");
  const handoffMarqueeToggle = document.querySelector("[data-handoff-marquee-toggle]");
  const compactHandoff = window.matchMedia("(max-width: 780px)").matches;
  const expandedHandoff = compactHandoff || prefersReducedMotion;
  let handoffIndex = 0;
  const recencyPhaseContent = [
    { status: "New source signal found", label: "Source detected just now", summary: "3 existing roles · 1 signal found" },
    { status: "Attaching source and location", label: "Context stays with the role", summary: "Source & first-seen time attached" },
    { status: "Newest-first feed ready", label: "Latest discovery at the top", summary: "4 recent roles · newest first" },
  ];

  function setFragmentPhase(nextPhase) {
    if (!fragmentStage || !fragmentPhases.length) return;
    const safePhase = Math.max(0, Math.min(fragmentPhases.length - 1, nextPhase));
    fragmentStage.dataset.phase = String(safePhase);
    fragmentPhases.forEach((phase, index) => {
      const active = index === safePhase;
      phase.classList.toggle("is-active", active);
      if (active) phase.setAttribute("aria-current", "step");
      else phase.removeAttribute("aria-current");
    });
    if (fragmentIntakeStatus) fragmentIntakeStatus.textContent = fragmentStatusLabels[safePhase];
  }

  function setRecencyPhase(nextPhase) {
    if (!recencyStage || !recencyPhases.length) return;
    const safePhase = Math.max(0, Math.min(recencyPhases.length - 1, nextPhase));
    const content = recencyPhaseContent[safePhase];
    recencyStage.dataset.phase = String(safePhase);
    recencyPhases.forEach((phase, index) => {
      const active = index === safePhase;
      phase.classList.toggle("is-active", active);
      if (active) phase.setAttribute("aria-current", "step");
      else phase.removeAttribute("aria-current");
    });
    if (recencyStatus) recencyStatus.textContent = content.status;
    if (recencyStageLabel) recencyStageLabel.textContent = content.label;
    if (recencyBoardSummary) recencyBoardSummary.textContent = content.summary;
  }

  function setHandoffSlide(nextIndex, { announce = false } = {}) {
    if (!handoffSlides.length) return;
    const safeIndex = Math.max(0, Math.min(handoffSlides.length - 1, nextIndex));
    handoffIndex = safeIndex;
    handoffSlides.forEach((slide, index) => {
      const active = index === safeIndex;
      slide.classList.toggle("is-active", active);
      if (expandedHandoff) {
        slide.setAttribute("aria-hidden", "false");
        slide.removeAttribute("tabindex");
      } else {
        slide.setAttribute("aria-hidden", String(!active));
        if (active) slide.removeAttribute("tabindex");
        else slide.setAttribute("tabindex", "-1");
      }
    });
    handoffChoices.forEach((choice, index) => choice.setAttribute("aria-pressed", String(index === safeIndex)));
    if (handoffPrevious) handoffPrevious.disabled = safeIndex === 0;
    if (handoffNext) handoffNext.disabled = safeIndex === handoffSlides.length - 1;
    if (handoffCurrent) handoffCurrent.textContent = String(safeIndex + 1).padStart(2, "0");
    if (announce && handoffAnnouncer) {
      handoffAnnouncer.textContent = `Showing ${handoffSlides[safeIndex]?.dataset.handoffLabel || "internship direction"}.`;
    }
  }

  function navigateToHandoffSlide(nextIndex) {
    const safeIndex = Math.max(0, Math.min(handoffSlides.length - 1, nextIndex));
    setHandoffSlide(safeIndex, { announce: true });
    if (expandedHandoff) {
      handoffSlides[safeIndex]?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "center" });
      return;
    }
    if (!handoffSection || staticCapture || !gsap || !ScrollTrigger) return;
    const scrollDistance = Math.max(0, handoffSection.offsetHeight - window.innerHeight);
    const progress = handoffSlides.length > 1 ? safeIndex / (handoffSlides.length - 1) : 0;
    window.scrollTo({ top: handoffSection.offsetTop + (scrollDistance * progress), behavior: "smooth" });
  }

  handoffChoices.forEach((choice, index) => {
    choice.addEventListener("click", () => navigateToHandoffSlide(index));
  });
  handoffPrevious?.addEventListener("click", () => navigateToHandoffSlide(handoffIndex - 1));
  handoffNext?.addEventListener("click", () => navigateToHandoffSlide(handoffIndex + 1));

  setFragmentPhase(0);
  setRecencyPhase(compactRecency || prefersReducedMotion || staticCapture ? 2 : 0);
  setHandoffSlide(0);

  if (!gsap || !ScrollTrigger || prefersReducedMotion || staticCapture) return;
  gsap.registerPlugin(ScrollTrigger);

  const lifecycleEvents = new window.AbortController();

  gsap.timeline({ defaults: { ease: "expo.out" } })
    .from(".landing-nav", { opacity: 0, yPercent: -18, duration: .38 })
    .from(".hero-title-line", { opacity: 0, yPercent: 28, stagger: .08, duration: .5 }, "<.08")
    .from(".hero-support > *", { opacity: 0, x: -14, stagger: .07, duration: .38 }, "<.06");

  const animationContext = gsap.context(() => {
    const fragmentMarquee = document.querySelector("[data-fragment-marquee]");
    if (fragmentMarquee) {
      const fragmentMarqueeLoop = gsap.to(fragmentMarquee, {
        xPercent: -50,
        duration: 24,
        ease: "none",
        repeat: -1,
        paused: true,
      });
      let fragmentMarqueeInView = false;
      const syncFragmentMarquee = () => {
        const shouldRun = fragmentMarqueeInView && !document.hidden;
        fragmentMarquee.classList.toggle("is-running", shouldRun);
        if (shouldRun) fragmentMarqueeLoop.play();
        else fragmentMarqueeLoop.pause();
      };
      const fragmentMarqueeTrigger = ScrollTrigger.create({
        trigger: ".fragment-section",
        start: "top bottom",
        end: "bottom top",
        onToggle: ({ isActive }) => {
          fragmentMarqueeInView = isActive;
          syncFragmentMarquee();
        },
      });
      fragmentMarqueeInView = fragmentMarqueeTrigger.isActive;
      syncFragmentMarquee();
      document.addEventListener("visibilitychange", syncFragmentMarquee, { signal: lifecycleEvents.signal });
    }

    if (handoffMarquee && handoffMarqueeToggle) {
      const handoffMarqueeLoop = gsap.to(handoffMarquee, {
        xPercent: -50,
        duration: 30,
        ease: "none",
        repeat: -1,
        paused: true,
      });
      let handoffMarqueeInView = false;
      let handoffMarqueePaused = false;
      let handoffMarqueeHoverPaused = false;
      const syncHandoffMarquee = () => {
        const shouldRun = handoffMarqueeInView && !handoffMarqueePaused && !handoffMarqueeHoverPaused && !document.hidden;
        handoffMarquee.classList.toggle("is-running", shouldRun);
        if (shouldRun) handoffMarqueeLoop.play();
        else handoffMarqueeLoop.pause();
      };
      handoffMarqueeToggle.hidden = false;
      handoffMarqueeToggle.addEventListener("click", () => {
        handoffMarqueePaused = !handoffMarqueePaused;
        handoffMarqueeToggle.setAttribute("aria-pressed", String(handoffMarqueePaused));
        handoffMarqueeToggle.textContent = handoffMarqueePaused ? "Play Motion" : "Pause Motion";
        syncHandoffMarquee();
      }, { signal: lifecycleEvents.signal });
      handoffMarqueeWindow?.addEventListener("pointerenter", () => {
        handoffMarqueeHoverPaused = true;
        syncHandoffMarquee();
      }, { signal: lifecycleEvents.signal });
      handoffMarqueeWindow?.addEventListener("pointerleave", () => {
        handoffMarqueeHoverPaused = false;
        syncHandoffMarquee();
      }, { signal: lifecycleEvents.signal });
      const handoffMarqueeTrigger = ScrollTrigger.create({
        trigger: handoffSection,
        start: "top bottom",
        end: "bottom top",
        onToggle: ({ isActive }) => {
          handoffMarqueeInView = isActive;
          syncHandoffMarquee();
        },
      });
      handoffMarqueeInView = handoffMarqueeTrigger.isActive;
      syncHandoffMarquee();
      document.addEventListener("visibilitychange", syncHandoffMarquee, { signal: lifecycleEvents.signal });
    }

    const isDesktopHero = !window.matchMedia("(max-width: 780px)").matches;
    if (isDesktopHero) {
      gsap.set(".hero-feed-center", { yPercent: 14, y: 15 });
      // Keep the initial cards just clear of the route endpoints; the final
      // rail position moves them a few pixels farther right.
      gsap.set(".hero-feed-roles", { xPercent: 9.8 });
    }

    const heroScrollTimeline = gsap.timeline({
      scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom bottom", scrub: .8 },
    })
      .to(".hero-copy", { scale: .92, transformOrigin: "left top", y: -18, duration: .34, ease: "none" }, 0)
      .from(".hero-feed-map", { opacity: .82, scale: .96, duration: .48, ease: "none" }, .04)
      .from(".hero-feed-route-paths", { opacity: .28, scale: .98, transformOrigin: "center", duration: .34, ease: "none" }, .12)
      .from(".hero-feed-route-dots", { opacity: .32, scale: .76, transformOrigin: "center", duration: .3, ease: "none" }, .16)
      .from(".hero-feed-source", { opacity: .68, x: -24, scale: .96, stagger: .04, duration: .42, ease: "none" }, .18)
      .from(".hero-feed-center", { opacity: .52, scale: .76, transformOrigin: "center", duration: .34, ease: "none" }, .34)
      .from(".hero-feed-role", { opacity: .68, x: 36, scale: .96, stagger: .035, duration: .44, ease: "none" }, .42)
      .from(".hero-feed-live-dot", { opacity: .35, scale: .4, transformOrigin: "center", stagger: .04, duration: .18, ease: "none" }, .68)
      .to(".hero-scroll-cue", { opacity: 0, y: -10, duration: .18, ease: "none" }, .08)
      .to(".hero-title-line", { y: -12, stagger: .04, duration: .22, ease: "none" }, .7);

    if (isDesktopHero) {
      heroScrollTimeline
        .to(".hero-feed-sources", { xPercent: 14.5, duration: .22, ease: "none" }, .78)
        // Match the source-side connector clearance at rest.
        .to(".hero-feed-roles", { xPercent: 15.5, duration: .22, ease: "none" }, .78)
        .to(".hero-feed-center", { scale: 1.18, transformOrigin: "center", duration: .22, ease: "none" }, .78);
    }

    if (!window.matchMedia("(max-width: 780px)").matches) {
      document.documentElement.classList.add("has-fragment-motion");
      gsap.timeline({
        scrollTrigger: {
          trigger: ".fragment-section",
          start: "top top",
          end: "bottom bottom",
          scrub: .85,
          onUpdate: ({ progress }) => setFragmentPhase(progress < .34 ? 0 : progress < .68 ? 1 : 2),
        },
      })
        .from(".fragment-copy", { opacity: .78, y: 20, duration: .18, ease: "none" }, 0)
        .from("[data-fragment-intake-rule]", { scaleY: 0, transformOrigin: "center top", duration: .3, ease: "none" }, .06)
        .to("[data-fragment-source]", {
          xPercent: 16,
          y: (index) => (1.5 - index) * 51,
          rotation: (index) => [1.2, -.8, .6, -1][index] || 0,
          scale: .92,
          stagger: .018,
          duration: .34,
          ease: "none",
        }, .18)
        .from("[data-fragment-intake]", { opacity: .58, scale: .76, transformOrigin: "center", duration: .24, ease: "none" }, .27)
        .to("[data-fragment-pulse]", { yPercent: 640, duration: .42, ease: "none" }, .3)
        .to("[data-fragment-source]", { opacity: .12, scale: .82, stagger: .012, duration: .2, ease: "none" }, .48)
        .from("[data-fragment-output]", { opacity: 0, x: -64, scale: .96, transformOrigin: "left center", stagger: .04, duration: .36, ease: "none" }, .47);
    }

    gsap.timeline({
      scrollTrigger: { trigger: ".scan-section", start: "top top", end: "bottom bottom", scrub: .75 },
    })
      .from(".scan-copy", { opacity: .76, y: 24, duration: .2, ease: "none" }, 0)
      .from("[data-scan-row]", { opacity: .56, x: 22, stagger: .07, duration: .5, ease: "none" }, .12)
      .to(".scan-beam", { xPercent: 455, duration: .72, ease: "none" }, .18);

    gsap.timeline({
      scrollTrigger: { trigger: ".filter-section", start: "top top", end: "bottom bottom", scrub: .75 },
    })
      .from(".filter-copy", { opacity: .76, y: 24, duration: .2, ease: "none" }, 0)
      .from(".filter-demo-head", { opacity: .76, y: 16, duration: .18, ease: "none" }, .1)
      .from(".demo-filter", { opacity: .72, y: 12, stagger: .04, duration: .26, ease: "none" }, .24)
      .from(".filter-results", { opacity: .76, y: 16, duration: .24, ease: "none" }, .46);

    if (!window.matchMedia("(max-width: 780px)").matches) {
      ScrollTrigger.create({
        trigger: ".filter-section",
        start: "top top",
        end: "bottom bottom",
        onUpdate: ({ progress }) => {
          if (filterManualOverride) return;
          const nextStep = progress < .14 ? 0 : progress < .34 ? 1 : progress < .54 ? 2 : progress < .74 ? 3 : 4;
          if (nextStep === filterSequenceStep) return;
          filterSequenceStep = nextStep;
          filterButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(index < nextStep)));
          renderIllustrativeFilters();
        },
      });
    }

    if (!compactRecency) {
      const recencyCards = [...document.querySelectorAll("[data-recency-card]")];
      const newestRecencyCard = recencyCards[0];
      const olderRecencyCards = recencyCards.slice(1);

      gsap.timeline({
        scrollTrigger: {
          trigger: ".recency-section",
          start: "top top",
          end: "bottom bottom",
          scrub: .8,
          onUpdate: ({ progress }) => setRecencyPhase(progress < .32 ? 0 : progress < .66 ? 1 : 2),
        },
      })
        .from(".recency-copy h2 span", { opacity: .82, y: 16, stagger: .05, duration: .2, ease: "none" }, 0)
        .from(".recency-copy > p, .recency-status", { opacity: .74, y: 12, stagger: .04, duration: .2, ease: "none" }, .06)
        .from(".recency-board", { opacity: .78, y: 22, scale: .99, transformOrigin: "center bottom", duration: .3, ease: "none" }, .08)
        .from(".recency-now-rule", { scaleY: 0, transformOrigin: "center top", duration: .42, ease: "none" }, .12)
        .fromTo("[data-recency-incoming]", { opacity: 0, x: -54 }, { opacity: 1, x: 0, duration: .2, ease: "none" }, .2)
        .to("[data-recency-incoming]", { opacity: 0, xPercent: 70, scale: .97, transformOrigin: "right center", duration: .18, ease: "none" }, .38)
        .from(newestRecencyCard, { opacity: 0, y: -48, scale: .97, transformOrigin: "center top", duration: .28, ease: "none" }, .58)
        .from(olderRecencyCards, {
          y: -69,
          scale: .995,
          transformOrigin: "center top",
          duration: .38,
          ease: "none",
        }, .59)
        .from(".recency-card-newest [data-recency-context]", { opacity: 0, x: -10, stagger: .035, duration: .2, ease: "none" }, .7)
        .from(".recency-board-foot", { opacity: .5, y: 8, duration: .16, ease: "none" }, .82);
    }

    if (!compactHandoff && handoffSection && handoffStage && handoffSlides.length) {
      document.documentElement.classList.add("has-handoff-motion");
      const handoffVisuals = handoffSlides.map((slide) => slide.querySelector(".handoff-slide-visual"));
      gsap.set(handoffSlides.slice(1), { autoAlpha: 0, scale: .94 });
      gsap.set(handoffSlides[0], { autoAlpha: 1, scale: 1 });

      gsap.timeline({
        scrollTrigger: {
          trigger: handoffSection,
          start: "top top",
          end: "bottom bottom",
          scrub: .8,
          pin: handoffStage,
          pinSpacing: false,
          anticipatePin: 1,
          onUpdate: ({ progress }) => setHandoffSlide(progress < .32 ? 0 : progress < .66 ? 1 : 2),
        },
      })
        .from(".handoff-copy h2 > span", { y: 24, stagger: .04, duration: .16, ease: "none" }, 0)
        .fromTo(".handoff-inline-image", { opacity: .75, scale: .8 }, { opacity: 1, scale: 1, duration: .24, ease: "none" }, .02)
        .from(".handoff-copy > p, .handoff-choices", { y: 14, stagger: .04, duration: .2, ease: "none" }, .04)
        .fromTo(handoffVisuals[0], { opacity: .72, scale: .8 }, { opacity: 1, scale: 1, duration: .28, ease: "none" }, .02)
        .to(handoffSlides[0], { autoAlpha: 0, scale: .96, duration: .16, ease: "none" }, .26)
        .to(handoffVisuals[0], { opacity: .2, scale: 1.04, duration: .18, ease: "none" }, .26)
        .fromTo(handoffSlides[1], { autoAlpha: 0, scale: .94 }, { autoAlpha: 1, scale: 1, duration: .09, ease: "none" }, .32)
        .fromTo(handoffVisuals[1], { opacity: .3, scale: .8 }, { opacity: 1, scale: 1, duration: .25, ease: "none" }, .32)
        .to(handoffSlides[1], { autoAlpha: 0, scale: .96, duration: .16, ease: "none" }, .61)
        .to(handoffVisuals[1], { opacity: .2, scale: 1.04, duration: .18, ease: "none" }, .61)
        .fromTo(handoffSlides[2], { autoAlpha: 0, scale: .94 }, { autoAlpha: 1, scale: 1, duration: .09, ease: "none" }, .68)
        .fromTo(handoffVisuals[2], { opacity: .3, scale: .8 }, { opacity: 1, scale: 1, duration: .26, ease: "none" }, .68);
    } else if (compactHandoff && handoffSlides.length) {
      handoffSlides.forEach((slide) => {
        const visual = slide.querySelector(".handoff-slide-visual");
        if (!visual) return;
        gsap.fromTo(visual, { opacity: .5, scale: .88 }, {
          opacity: 1,
          scale: 1,
          ease: "none",
          scrollTrigger: { trigger: slide, start: "top bottom", end: "center 62%", scrub: .55 },
        });
      });
    }

  });

  document.fonts?.ready?.then(() => requestAnimationFrame(() => ScrollTrigger.refresh()));
  window.addEventListener("pagehide", () => {
    lifecycleEvents.abort();
    animationContext.revert();
    document.documentElement.classList.remove("has-handoff-motion");
  }, { once: true });
})();

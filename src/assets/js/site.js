/* Site JS — copy buttons, mobile nav, TOC, task list persistence,
   FAQ accordion transform, scroll-spy, service worker registration. */
(function () {
  "use strict";

  // -------------------------- Mobile nav toggle --------------------------
  const navToggle = document.querySelector("[data-nav-toggle]");
  const primaryNav = document.getElementById("primary-nav");
  if (navToggle && primaryNav) {
    navToggle.addEventListener("click", () => {
      const open = primaryNav.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", String(open));
    });
    // Close menu on link click (mobile)
    primaryNav.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => {
        if (window.matchMedia("(max-width: 880px)").matches) {
          primaryNav.classList.remove("is-open");
          navToggle.setAttribute("aria-expanded", "false");
        }
      })
    );
  }

  // -------------------------- Codeblock copy buttons --------------------------
  document.querySelectorAll(".codeblock").forEach((block) => {
    const btn = block.querySelector(".codeblock__copy");
    const code = block.querySelector("pre code");
    if (!btn || !code) return;
    btn.addEventListener("click", async () => {
      const text = code.innerText;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "absolute";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        const old = btn.textContent;
        btn.textContent = "Copied!";
        btn.classList.add("is-copied");
        setTimeout(() => {
          btn.textContent = old;
          btn.classList.remove("is-copied");
        }, 1600);
      } catch (e) {
        btn.textContent = "Copy failed";
        setTimeout(() => (btn.textContent = "Copy"), 1600);
      }
    });
  });

  // -------------------------- Task list persistence --------------------------
  // markdown-it-task-lists outputs <li class="task-list-item"><input ...><label ...>...
  // Enable interactivity + persist state per URL path.
  const tlKey = "tl::" + location.pathname;
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(tlKey) || "{}");
  } catch (_) {
    saved = {};
  }
  const tlItems = document.querySelectorAll(".article li.task-list-item input[type=\"checkbox\"]");
  tlItems.forEach((cb, idx) => {
    cb.disabled = false;
    cb.removeAttribute("disabled");
    cb.dataset.tlIdx = String(idx);
    if (saved[idx] === true) {
      cb.checked = true;
      cb.closest("li").classList.add("is-checked");
    }
    cb.addEventListener("change", () => {
      cb.closest("li").classList.toggle("is-checked", cb.checked);
      saved[idx] = cb.checked;
      try {
        localStorage.setItem(tlKey, JSON.stringify(saved));
      } catch (_) {}
    });
  });

  // -------------------------- FAQ accordion transform --------------------------
  // For any <h2|h3> whose text contains "FAQ" or "Frequently Asked",
  // convert the following H3-question / paragraph-answer pairs into <details>.
  function transformFaqSection() {
    const article = document.querySelector(".article");
    if (!article) return;
    const headings = article.querySelectorAll("h2, h3");
    headings.forEach((h) => {
      const text = (h.textContent || "").trim().toLowerCase();
      if (!/(faq|frequently asked)/.test(text)) return;
      // Gather siblings until next same-or-higher heading
      const wrap = document.createElement("div");
      wrap.className = "faq-section";
      let node = h.nextElementSibling;
      const collected = [];
      const stopAt = ["H1", "H2"].includes(h.tagName) ? ["H1", "H2"] : ["H1", "H2", "H3"];
      while (node && !stopAt.includes(node.tagName)) {
        collected.push(node);
        node = node.nextElementSibling;
      }
      // Group Q (h3/h4 or bold p) → answer(s) until next Q
      let current = null;
      let details = null;
      collected.forEach((el) => {
        const isQuestion =
          (el.tagName === "H3" || el.tagName === "H4") ||
          (el.tagName === "P" && el.children.length === 1 && el.children[0].tagName === "STRONG");
        if (isQuestion) {
          details = document.createElement("details");
          details.className = "faq";
          const summary = document.createElement("summary");
          summary.textContent = el.textContent;
          details.appendChild(summary);
          wrap.appendChild(details);
          current = details;
        } else if (current) {
          current.appendChild(el.cloneNode(true));
        } else {
          wrap.appendChild(el.cloneNode(true));
        }
      });
      if (collected.length > 0) {
        collected.forEach((el) => el.remove());
        h.after(wrap);
      }
    });
  }
  transformFaqSection();

  // -------------------------- TOC sidebar (built from H2s) --------------------------
  const tocEl = document.querySelector("[data-toc]");
  if (tocEl) {
    const article = document.querySelector(".article");
    const ul = tocEl.querySelector("ul");
    const items = article ? article.querySelectorAll("h2[id]") : [];
    if (items && items.length >= 2) {
      items.forEach((h) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = "#" + h.id;
        a.textContent = h.textContent.replace(/^\d+\.\s*/, "");
        a.dataset.tocLink = h.id;
        li.appendChild(a);
        ul.appendChild(li);
      });
      tocEl.hidden = false;

      // Scroll spy
      const linksById = {};
      tocEl.querySelectorAll("a[data-toc-link]").forEach((a) => {
        linksById[a.dataset.tocLink] = a;
      });
      const obs = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const id = entry.target.id;
            const link = linksById[id];
            if (!link) return;
            if (entry.isIntersecting) {
              tocEl.querySelectorAll("a.is-current").forEach((x) => x.classList.remove("is-current"));
              link.classList.add("is-current");
            }
          });
        },
        { rootMargin: "-30% 0px -65% 0px", threshold: 0 }
      );
      items.forEach((h) => obs.observe(h));
    }
  }

  // -------------------------- Service worker --------------------------
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
})();

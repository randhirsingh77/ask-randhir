/* Ask Randhir — one dependency-free chat component, two modes.
 *
 *   widget mode: a launcher button on the portfolio opens the chat as a
 *                popup panel (native <dialog>, ~75dvh). It is NOT a page.
 *   page mode:   the same component rendered full-screen as the
 *                standalone page served by the Worker at / and /chat.
 *
 * Config (first match wins):
 *   API URL:  window.ASK_RANDHIR_API  >  data-api on this script tag  >  "/api/chat"
 *   Mode:     data-mode on this script tag ("widget" | "page")  >  "widget"
 *
 * Answers are rendered with textContent only — never as HTML — so model
 * output can never inject markup into the host page.
 */
(function () {
  "use strict";

  // AVATAR: avatar.jpg next to this file is the illustrated avatar;
  // avatar-greet.mp4 is its silent animated version, shown in the header.
  var AVATAR_FILE = "avatar.jpg";
  var GREET_VIDEO_FILE = "avatar-greet.mp4";

  var scriptEl = document.currentScript;
  var base = scriptEl ? scriptEl.src.replace(/[^/]*$/, "") : "";
  var API_URL =
    window.ASK_RANDHIR_API ||
    (scriptEl && scriptEl.getAttribute("data-api")) ||
    "/api/chat";
  var MODE = (scriptEl && scriptEl.getAttribute("data-mode")) || "widget";
  var AVATAR_URL = base + AVATAR_FILE;
  var CONTACT_EMAIL = "rs6201849307@gmail.com";

  var STARTERS = [
    "What are his main skills?",
    "Tell me about the Foodie project",
    "How can I contact him?",
  ];

  // WhatsApp-style greeting: the messages arrive one by one, with the
  // typing dots in between, the first time the chat is opened.
  var GREETING = [
    "Hi there! 👋",
    "I'm Ask Randhir — Randhir's AI assistant.",
    "Ask me anything about his skills, his projects like Foodie and the LMS, or how to contact him. Just type below 👇",
  ];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildChat(onClose) {
    var root = el("div", "ar-chat");

    var head = el("div", "ar-head");
    var avatar = el("video", "ar-avatar");
    avatar.muted = true;
    avatar.loop = true;
    avatar.autoplay = true;
    avatar.playsInline = true;
    avatar.poster = AVATAR_URL;
    avatar.src = base + GREET_VIDEO_FILE;
    var titles = el("div", "ar-titles");
    titles.appendChild(el("p", "ar-title", "Ask Randhir"));
    titles.appendChild(
      el("p", "ar-sub", "AI assistant — his skills, projects & experience")
    );
    head.appendChild(avatar);
    head.appendChild(titles);
    if (onClose) {
      var closeBtn = el("button", "ar-close", "×");
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Close chat");
      closeBtn.addEventListener("click", onClose);
      head.appendChild(closeBtn);
    }
    root.appendChild(head);

    var log = el("div", "ar-messages");
    log.setAttribute("role", "log");
    log.setAttribute("aria-live", "polite");
    log.setAttribute("aria-label", "Conversation");
    root.appendChild(log);

    var starters = el("div", "ar-starters");
    STARTERS.forEach(function (q) {
      var b = el("button", "ar-starter", q);
      b.type = "button";
      b.addEventListener("click", function () {
        send(q);
      });
      starters.appendChild(b);
    });
    root.appendChild(starters);

    var form = el("form", "ar-form");
    var input = el("textarea", "ar-input");
    input.rows = 1;
    input.placeholder = "Ask about Randhir…";
    input.setAttribute("aria-label", "Your question");
    input.maxLength = 800;
    var sendBtn = el("button", "ar-send", "Send");
    sendBtn.type = "submit";
    form.appendChild(input);
    form.appendChild(sendBtn);
    root.appendChild(form);

    root.appendChild(
      el(
        "p",
        "ar-note",
        "AI answers can be wrong — for anything important, email " +
          CONTACT_EMAIL +
          "."
      )
    );

    var history = [];
    var busy = false;

    function addMessage(role, text) {
      var row = el("div", "ar-msg ar-msg-" + role);
      if (role === "assistant") {
        var img = el("img", "ar-msg-avatar");
        img.src = AVATAR_URL;
        img.alt = "";
        row.appendChild(img);
      }
      row.appendChild(el("div", "ar-bubble", text));
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
      return row;
    }

    function typingEl() {
      var t = el("div", "ar-typing");
      t.setAttribute("role", "status");
      t.setAttribute("aria-label", "Typing");
      for (var i = 0; i < 3; i++) t.appendChild(el("span", "ar-dot"));
      return t;
    }

    var greetingStarted = false;
    var greetingTimers = [];
    var greetingTyping = null;

    function cancelGreeting() {
      greetingTimers.forEach(clearTimeout);
      greetingTimers = [];
      if (greetingTyping) {
        greetingTyping.remove();
        greetingTyping = null;
      }
      greetingStarted = true;
    }

    function startGreeting() {
      if (greetingStarted) return;
      greetingStarted = true;
      var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) {
        GREETING.forEach(function (m) {
          addMessage("assistant", m);
        });
        return;
      }
      var i = 0;
      function next() {
        if (i >= GREETING.length) return;
        greetingTyping = typingEl();
        log.appendChild(greetingTyping);
        log.scrollTop = log.scrollHeight;
        greetingTimers.push(
          setTimeout(function () {
            if (greetingTyping) greetingTyping.remove();
            greetingTyping = null;
            addMessage("assistant", GREETING[i]);
            i++;
            if (i < GREETING.length) greetingTimers.push(setTimeout(next, 400));
          }, 800)
        );
      }
      next();
    }

    function send(text) {
      var content = (text != null ? text : input.value).trim();
      if (!content || busy) return;
      busy = true;
      sendBtn.disabled = true;
      if (text == null) input.value = "";
      history.push({ role: "user", content: content });
      addMessage("user", content);
      cancelGreeting();
      var typing = typingEl();
      log.appendChild(typing);
      log.scrollTop = log.scrollHeight;

      fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-6) }),
      })
        .then(function (res) {
          return res.json().catch(function () {
            return {};
          });
        })
        .then(function (body) {
          var answer =
            body.answer ||
            body.message ||
            "Something went wrong — please try again, or email Randhir directly at " +
              CONTACT_EMAIL +
              ".";
          history.push({ role: "assistant", content: answer });
          addMessage("assistant", answer);
        })
        .catch(function () {
          addMessage(
            "assistant",
            "I can't reach the assistant right now — please try again in a moment, or email Randhir directly at " +
              CONTACT_EMAIL +
              "."
          );
        })
        .finally(function () {
          typing.remove();
          busy = false;
          sendBtn.disabled = false;
        });
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      send();
    });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        send();
      }
    });

    return { root: root, input: input, startGreeting: startGreeting };
  }

  if (MODE === "page") {
    var mount =
      document.getElementById("ask-randhir-root") || document.body;
    var pageChat = buildChat(null);
    mount.appendChild(pageChat.root);
    pageChat.startGreeting();
    return;
  }

  // ---- widget mode ----
  var launcher = el("button", "ar-launcher");
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Chat with Randhir's assistant");
  var lImg = el("img", "ar-launcher-avatar");
  lImg.src = AVATAR_URL;
  lImg.alt = "";
  launcher.appendChild(lImg);
  document.body.appendChild(launcher);

  var dialog = el("dialog", "ar-dialog");
  dialog.setAttribute("aria-label", "Ask Randhir — chat");
  var chat = buildChat(function () {
    dialog.close();
  });
  dialog.appendChild(chat.root);
  document.body.appendChild(dialog);

  // Peek greeting: shortly after the page loads, the avatar character
  // pops OUT of the launcher circle — bigger — plays its (silent) wave,
  // then settles back into the circle. Once per page load.
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var peek = el("video", "ar-peek");
  peek.muted = true;
  peek.loop = true;
  peek.playsInline = true;
  peek.preload = "auto";
  peek.poster = AVATAR_URL;
  peek.src = base + GREET_VIDEO_FILE;
  peek.setAttribute("aria-hidden", "true");
  document.body.appendChild(peek);
  var peekInTimer = null;
  var peekOutTimer = null;
  function hidePeek() {
    if (peekInTimer) clearTimeout(peekInTimer);
    if (peekOutTimer) clearTimeout(peekOutTimer);
    peek.classList.remove("ar-peek-show");
  }
  if (!reduceMotion) {
    peekInTimer = setTimeout(function () {
      peek.classList.add("ar-peek-show");
      var p = peek.play();
      if (p && p.catch) p.catch(function () {});
      peekOutTimer = setTimeout(hidePeek, 5200);
    }, 1200);
  }

  // Greeting teaser: a little WhatsApp-style bubble that pops in beside
  // the launcher shortly after the page loads, so the avatar greets the
  // visitor before they even open the chat. Once per page load.
  var teaser = el("div", "ar-teaser");
  teaser.appendChild(
    el("span", "ar-teaser-text", "Hi there! 👋 I'm Randhir's AI assistant — tap to chat")
  );
  var teaserClose = el("button", "ar-teaser-close", "×");
  teaserClose.type = "button";
  teaserClose.setAttribute("aria-label", "Dismiss greeting");
  teaser.appendChild(teaserClose);
  document.body.appendChild(teaser);
  var teaserTimer = setTimeout(function () {
    teaser.classList.add("ar-teaser-show");
  }, 1600);
  function hideTeaser() {
    clearTimeout(teaserTimer);
    teaser.classList.remove("ar-teaser-show");
  }
  teaserClose.addEventListener("click", function (ev) {
    ev.stopPropagation();
    hideTeaser();
  });
  teaser.addEventListener("click", openChat);

  function openChat() {
    if (!dialog.open) {
      hideTeaser();
      hidePeek();
      dialog.showModal();
      launcher.classList.add("ar-launcher-hidden");
      chat.startGreeting();
      // Auto-focus is helpful with a real keyboard; on touch devices it
      // would summon the on-screen keyboard uninvited.
      if (window.matchMedia("(pointer: fine)").matches) chat.input.focus();
    }
  }
  launcher.addEventListener("click", openChat);
  dialog.addEventListener("close", function () {
    launcher.classList.remove("ar-launcher-hidden");
    launcher.focus(); // return focus to the launcher
  });
})();

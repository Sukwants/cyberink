(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = { user: null, csrfToken: "", messages: [], selectedId: null, detail: null, filter: "all", search: "" };
  let toastTimer;
  let detailVersion = 0;
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function notify(message, isError = false) {
    const toast = $("toast");
    toast.textContent = message; toast.classList.toggle("error", isError); toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
  }
  function messageError(error) { return error instanceof Error ? error.message : "操作未完成，请稍后重试"; }
  async function api(path, options = {}) {
    const headers = { ...options.headers };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.method && !["GET", "HEAD"].includes(options.method) && state.csrfToken) headers["X-CSRF-Token"] = state.csrfToken;
    const response = await fetch(path, { ...options, headers, credentials: "same-origin", body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && state.user) showLogin();
      throw new Error(data.error || "请求失败，请稍后重试");
    }
    return data;
  }
  function showLogin() {
    state.user = null; state.csrfToken = ""; state.messages = []; state.selectedId = null; state.detail = null; detailVersion++;
    $("login-screen").hidden = false; $("mail-screen").hidden = true;
    if ($("compose-dialog").open) $("compose-dialog").close();
  }
  function showMailbox(data) {
    state.user = data.user; state.csrfToken = data.csrfToken;
    const name = data.user.email.split("@")[0];
    $("user-name").textContent = name; $("user-email").textContent = data.user.email;
    $("user-avatar").textContent = name.slice(0, 1).toUpperCase();
    $("compose-from").value = data.user.mailboxes?.[0]?.address || data.user.email;
    $("login-screen").hidden = true; $("mail-screen").hidden = false;
    $("password").value = ""; $("login-error").textContent = "";
    emptyDetail(); void refreshMessages();
  }
  function formattedDate(value, full = false) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    if (full) return date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
    const today = new Date();
    return date.toDateString() === today.toDateString() ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  }
  function sender(message) { return message.fromName || message.fromAddress || "未知发件人"; }
  function emptyDetail() {
    const container = $("message-detail");
    const empty = element("div", "detail-empty");
    const icon = element("span", "empty-envelope", "✉"); icon.setAttribute("aria-hidden", "true");
    empty.append(icon, element("h2", "", "为下一封来信，留一点空间"), element("p", "", "选择一封邮件，在这里查看完整内容"));
    container.replaceChildren(empty);
    document.querySelector(".mail-workspace").classList.remove("detail-open");
  }
  function renderMessages() {
    const filtered = state.messages.filter((message) => {
      if (state.filter === "unread" && message.isRead) return false;
      return [message.fromName, message.fromAddress, message.subject, message.textBody].filter(Boolean).join(" ").toLowerCase().includes(state.search.toLowerCase());
    });
    const list = $("message-list"); list.replaceChildren();
    $("total-count").textContent = String(state.messages.length);
    $("unread-badge").textContent = String(state.messages.filter((message) => !message.isRead).length);
    if (!filtered.length) {
      const empty = element("div", "list-empty");
      empty.append(element("span", "", "✉"), element("div", "", state.search ? "没有找到相关邮件" : state.filter === "unread" ? "所有来信，都已读过" : "收件箱还是空的"), element("div", "", state.search ? "试试其他关键词" : "新的来信会在这里出现"));
      list.append(empty); return;
    }
    for (const message of filtered) {
      const card = element("button", "message-card");
      card.type = "button"; card.classList.toggle("unread", !message.isRead); card.classList.toggle("selected", message.id === state.selectedId);
      card.setAttribute("aria-label", (message.isRead ? "" : "未读，") + sender(message) + "：" + (message.subject || "（无主题）"));
      card.setAttribute("aria-pressed", String(message.id === state.selectedId));
      const heading = element("div", "message-card-heading");
      heading.append(element("span", "message-sender", sender(message)), element("time", "message-date", formattedDate(message.createdAt)));
      card.append(heading, element("h3", "message-subject", message.subject || "（无主题）"), element("p", "message-preview", message.textBody || "发至 " + (message.toAddress || state.user.email)));
      card.addEventListener("click", () => { void openMessage(message.id); }); list.append(card);
    }
  }
  async function refreshMessages() {
    const button = $("refresh-button"); button.disabled = true;
    try {
      const data = await api("/api/inbox");
      state.messages = data.messages;
      renderMessages();
      if (state.selectedId && !state.messages.some((message) => message.id === state.selectedId)) {
        state.selectedId = null; state.detail = null; emptyDetail();
      }
    } catch (error) { notify(messageError(error), true); }
    finally { button.disabled = false; }
  }
  async function openMessage(id) {
    const version = ++detailVersion; state.selectedId = id; renderMessages();
    try {
      const data = await api("/api/messages/" + encodeURIComponent(id));
      if (version !== detailVersion || !state.user) return;
      state.detail = data.message;
      if (!data.message.isRead) {
        await api("/api/messages/" + encodeURIComponent(id), { method: "PATCH", body: { isRead: true } });
        if (version !== detailVersion) return;
        data.message.isRead = true;
        const cached = state.messages.find((message) => message.id === id); if (cached) cached.isRead = true;
      }
      renderMessages(); renderDetail(data.message);
      document.querySelector(".mail-workspace").classList.add("detail-open");
    } catch (error) {
      if (version === detailVersion) { state.selectedId = null; renderMessages(); notify(messageError(error), true); }
    }
  }
  function actionButton(label, className, handler) {
    const button = element("button", "button " + className, label); button.type = "button"; button.addEventListener("click", handler); return button;
  }
  function renderDetail(message) {
    const container = $("message-detail"); container.replaceChildren();
    const actions = element("div", "detail-actions"); const left = element("div", "detail-actions-left");
    left.append(actionButton("← 返回", "mobile-back", () => { document.querySelector(".mail-workspace").classList.remove("detail-open"); }));
    const unread = actionButton(message.isRead ? "标为未读" : "标为已读", "", async () => {
      unread.disabled = true;
      try {
        await api("/api/messages/" + encodeURIComponent(message.id), { method: "PATCH", body: { isRead: !message.isRead } });
        message.isRead = !message.isRead;
        const cached = state.messages.find((entry) => entry.id === message.id); if (cached) cached.isRead = message.isRead;
        renderMessages(); renderDetail(message); notify(message.isRead ? "已标为已读" : "已标为未读");
      } catch (error) { notify(messageError(error), true); unread.disabled = false; }
    });
    left.append(unread);
    actions.append(left, actionButton("删除邮件", "delete-button", async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try {
        await api("/api/messages/" + encodeURIComponent(message.id), { method: "DELETE" });
        state.messages = state.messages.filter((entry) => entry.id !== message.id); state.selectedId = null; state.detail = null; detailVersion++;
        emptyDetail(); renderMessages(); notify("邮件已删除");
      } catch (error) { notify(messageError(error), true); button.disabled = false; }
    }));
    const senderLine = element("div", "sender-line");
    senderLine.append(element("span", "avatar", sender(message).slice(0, 1).toUpperCase()));
    const info = element("div", "sender-info");
    info.append(element("strong", "", sender(message)), element("small", "", message.fromAddress || ""), element("small", "", "收件人：" + (message.toAddress || state.user.email)));
    senderLine.append(info, element("time", "detail-date", formattedDate(message.createdAt, true)));
    container.append(actions, element("h2", "detail-title", message.subject || "（无主题）"), senderLine, element("div", "message-body", message.textBody || "此邮件没有纯文本正文。"));
    if (message.attachments && message.attachments.length) {
      const section = element("section", "attachments"); section.append(element("h3", "", "附件 · " + message.attachments.length));
      for (const attachment of message.attachments) {
        const link = element("a", "attachment-link", attachment.filename || "未命名附件");
        link.href = "/api/attachments/" + encodeURIComponent(attachment.id); link.setAttribute("download", "");
        link.append(element("small", "", attachment.size < 1024 ? attachment.size + " B" : (attachment.size / 1024).toFixed(1) + " KB")); section.append(link);
      }
      container.append(section);
    }
  }
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; $("login-error").textContent = "";
    try { showMailbox(await api("/api/login", { method: "POST", body: { email: $("email").value.trim(), password: $("password").value } })); }
    catch (error) { $("login-error").textContent = messageError(error); }
    finally { button.disabled = false; }
  });
  $("logout-button").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST" }); showLogin(); }
    catch (error) { notify(messageError(error), true); }
  });
  $("refresh-button").addEventListener("click", () => { void refreshMessages(); });
  $("inbox-nav").addEventListener("click", () => { document.querySelector(".mail-workspace").classList.remove("detail-open"); void refreshMessages(); });
  $("search").addEventListener("input", (event) => { state.search = event.target.value; renderMessages(); });
  for (const filter of ["all", "unread"]) {
    $("filter-" + filter).addEventListener("click", () => {
      state.filter = filter;
      for (const value of ["all", "unread"]) { $("filter-" + value).classList.toggle("active", value === filter); $("filter-" + value).setAttribute("aria-pressed", String(value === filter)); }
      renderMessages();
    });
  }
  $("compose-button").addEventListener("click", () => { $("compose-error").textContent = ""; $("compose-dialog").showModal(); $("compose-to").focus(); });
  $("close-compose").addEventListener("click", () => { $("compose-dialog").close(); });
  $("compose-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = $("send-button"); button.disabled = true; $("compose-error").textContent = "";
    try {
      const result = await api("/api/send", { method: "POST", body: { from: $("compose-from").value, to: [$("compose-to").value.trim()], subject: $("compose-subject").value, text: $("compose-text").value } });
      if (result.status !== "sent") {
        const statuses = { pending: "发送尚未完成，请勿重复提交", temp_failed: "发送服务器暂时拒绝了邮件", permanent_failed: "发送服务器拒绝了邮件，请检查收件人", unknown: "发送结果尚未确认，请勿重复提交" };
        throw new Error((statuses[result.status] || "邮件未确认发送成功") + "。记录编号：" + result.id);
      }
      $("compose-to").value = ""; $("compose-subject").value = ""; $("compose-text").value = ""; $("compose-dialog").close(); notify("邮件已成功提交至发送服务器");
    } catch (error) { $("compose-error").textContent = messageError(error); }
    finally { button.disabled = false; }
  });
  void api("/api/me").then(showMailbox).catch(() => { showLogin(); });
})();

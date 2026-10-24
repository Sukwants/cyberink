(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = {
    user: null, csrfToken: "", folder: "inbox", messages: { inbox: [], sent: [] },
    selectedId: null, detail: null, filter: "all", search: "",
    limits: { maxMessageBytes: 10 * 1024 * 1024, maxAttachments: 10, maxAttachmentBytes: 10 * 1024 * 1024 },
    attachments: [], sendUncertain: null,
  };
  let toastTimer;
  let sessionVersion = 0;
  let listVersion = 0;
  let detailVersion = 0;
  let composeVersion = 0;
  let attachmentSequence = 0;
  let sending = false;

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
    const version = sessionVersion;
    const headers = { ...options.headers };
    const multipart = options.body instanceof FormData;
    if (options.body !== undefined && !multipart) headers["Content-Type"] = "application/json";
    if (options.method && !["GET", "HEAD"].includes(options.method) && state.csrfToken) headers["X-CSRF-Token"] = state.csrfToken;
    const response = await fetch(path, {
      ...options, headers, credentials: "same-origin",
      body: options.body === undefined ? undefined : multipart ? options.body : JSON.stringify(options.body),
    });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && state.user && version === sessionVersion) showLogin();
      const error = new Error(data.error || "请求失败，请稍后重试");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function resetCompose() {
    composeVersion++;
    state.attachments = []; state.sendUncertain = null; sending = false;
    $("compose-form").reset();
    $("compose-from").value = state.user?.mailboxes?.[0]?.address || state.user?.email || "";
    $("compose-error").textContent = "";
    $("compose-status-actions").hidden = true;
    $("send-button").disabled = false;
    $("add-attachments").disabled = false;
    $("new-compose").disabled = false; $("check-send-status").disabled = false;
    for (const id of ["compose-to", "compose-subject", "compose-text"]) $(id).readOnly = false;
    renderComposeAttachments();
  }
  function showLogin() {
    sessionVersion++; listVersion++; detailVersion++;
    state.user = null; state.csrfToken = ""; state.messages = { inbox: [], sent: [] };
    state.folder = "inbox"; state.selectedId = null; state.detail = null; state.search = ""; state.filter = "all";
    $("search").value = "";
    resetCompose();
    $("login-screen").hidden = false; $("mail-screen").hidden = true;
    if ($("compose-dialog").open) $("compose-dialog").close();
  }
  function showMailbox(data) {
    sessionVersion++; listVersion++; detailVersion++;
    state.user = data.user; state.csrfToken = data.csrfToken;
    state.folder = "inbox"; state.messages = { inbox: [], sent: [] }; state.selectedId = null; state.detail = null;
    state.filter = "all"; state.search = ""; $("search").value = "";
    if (data.limits && Number.isSafeInteger(data.limits.maxMessageBytes) && data.limits.maxMessageBytes > 0) state.limits.maxMessageBytes = data.limits.maxMessageBytes;
    if (data.limits && Number.isSafeInteger(data.limits.maxAttachments) && data.limits.maxAttachments >= 0) state.limits.maxAttachments = data.limits.maxAttachments;
    state.limits.maxAttachmentBytes = data.limits && Number.isSafeInteger(data.limits.maxAttachmentBytes) && data.limits.maxAttachmentBytes > 0
      ? data.limits.maxAttachmentBytes : state.limits.maxMessageBytes;
    const name = data.user.email.split("@")[0];
    $("user-name").textContent = name; $("user-email").textContent = data.user.email;
    $("user-avatar").textContent = name.slice(0, 1).toUpperCase();
    resetCompose();
    $("login-screen").hidden = true; $("mail-screen").hidden = false;
    $("password").value = ""; $("login-error").textContent = "";
    updateFolderControls(); emptyDetail(); renderMessages(); void refreshMessages();
  }
  function formattedDate(value, full = false) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    if (full) return date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
    const today = new Date();
    return date.toDateString() === today.toDateString() ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  }
  function sizeLabel(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }
  function sender(message) { return message.fromName || message.fromAddress || message.from || "未知发件人"; }
  function recipients(message) { return Array.isArray(message.to) ? message.to.join(", ") : message.toAddress || ""; }
  function currentMessages() { return state.messages[state.folder]; }
  function detailIsCurrent(context) {
    return Boolean(state.user) && context.session === sessionVersion && context.folder === state.folder && context.version === detailVersion && context.id === state.selectedId;
  }
  function updateCounts() {
    $("unread-badge").textContent = String(state.messages.inbox.filter((message) => !message.isRead).length);
    $("sent-badge").textContent = String(state.messages.sent.length);
    $("sent-badge").hidden = state.messages.sent.length === 0;
    $("total-count").textContent = String(currentMessages().length);
  }
  function updateFolderControls() {
    const sent = state.folder === "sent";
    $("folder-title").textContent = sent ? "已发送" : "收件箱";
    $("search").placeholder = sent ? "搜索收件人、主题…" : "搜索发件人、主题…";
    $("search").setAttribute("aria-label", sent ? "搜索收件人或主题" : "搜索发件人或主题");
    $("filter-all").textContent = sent ? "发送成功" : "全部邮件";
    $("filter-unread").hidden = sent;
    for (const folder of ["inbox", "sent"]) {
      $(folder + "-nav").classList.toggle("active", folder === state.folder);
      $(folder + "-nav").setAttribute("aria-pressed", String(folder === state.folder));
    }
    for (const filter of ["all", "unread"]) {
      const active = sent ? filter === "all" : state.filter === filter;
      $("filter-" + filter).classList.toggle("active", active);
      $("filter-" + filter).setAttribute("aria-pressed", String(active));
    }
    updateCounts();
  }
  function emptyDetail() {
    const empty = element("div", "detail-empty");
    const icon = element("span", "empty-envelope", "✉"); icon.setAttribute("aria-hidden", "true");
    empty.append(
      icon,
      element("h2", "", state.folder === "sent" ? "每一次沟通，都有迹可循" : "为下一封来信，留一点空间"),
      element("p", "", state.folder === "sent" ? "选择一封已发送邮件，查看内容和附件" : "选择一封邮件，在这里查看完整内容"),
    );
    $("message-detail").replaceChildren(empty);
    document.querySelector(".mail-workspace").classList.remove("detail-open");
  }
  function switchFolder(folder) {
    if (!state.user) return;
    if (state.folder !== folder) {
      listVersion++; detailVersion++;
      state.folder = folder; state.selectedId = null; state.detail = null; state.search = "";
      $("search").value = ""; emptyDetail();
    } else {
      document.querySelector(".mail-workspace").classList.remove("detail-open");
    }
    updateFolderControls(); renderMessages(); void refreshMessages();
  }
  function renderMessages() {
    const sent = state.folder === "sent";
    const query = state.search.toLowerCase();
    const filtered = currentMessages().filter((message) => {
      if (!sent && state.filter === "unread" && message.isRead) return false;
      const fields = sent ? [recipients(message), message.subject] : [message.fromName, message.fromAddress, message.subject];
      return fields.filter(Boolean).join(" ").toLowerCase().includes(query);
    });
    const list = $("message-list"); list.replaceChildren(); updateCounts();
    if (!filtered.length) {
      const empty = element("div", "list-empty");
      const title = state.search ? "没有找到相关邮件" : sent ? "还没有已发送邮件" : state.filter === "unread" ? "所有来信，都已读过" : "收件箱还是空的";
      const hint = state.search ? "试试其他关键词" : sent ? "发送服务器确认接收的邮件会出现在这里" : "新的来信会在这里出现";
      empty.append(element("span", "", sent ? "↗" : "✉"), element("div", "", title), element("div", "", hint));
      list.append(empty); return;
    }
    for (const message of filtered) {
      const card = element("button", "message-card"); card.type = "button";
      card.classList.toggle("unread", !sent && !message.isRead);
      card.classList.toggle("selected", message.id === state.selectedId);
      const correspondent = sent ? recipients(message) || "未知收件人" : sender(message);
      card.setAttribute("aria-label", (!sent && !message.isRead ? "未读，" : "") + (sent ? "发给 " : "") + correspondent + "：" + (message.subject || "（无主题）"));
      card.setAttribute("aria-pressed", String(message.id === state.selectedId));
      const heading = element("div", "message-card-heading");
      heading.append(element("span", "message-sender", (sent ? "发给 " : "") + correspondent), element("time", "message-date", formattedDate(message.createdAt)));
      card.append(heading, element("h3", "message-subject", message.subject || "（无主题）"), element("p", "message-preview", sent ? "发自 " + message.from : message.textBody || "发至 " + (message.toAddress || state.user.email)));
      card.addEventListener("click", () => { void openMessage(message.id); }); list.append(card);
    }
  }
  async function refreshMessages() {
    if (!state.user) return;
    const version = ++listVersion;
    const session = sessionVersion;
    const folder = state.folder;
    const button = $("refresh-button"); button.disabled = true;
    try {
      const data = await api(folder === "sent" ? "/api/sent" : "/api/inbox");
      if (version !== listVersion || session !== sessionVersion || folder !== state.folder || !state.user) return;
      state.messages[folder] = data.messages;
      renderMessages();
      if (state.selectedId && !data.messages.some((message) => message.id === state.selectedId)) {
        detailVersion++; state.selectedId = null; state.detail = null; emptyDetail();
      }
    } catch (error) {
      if (version === listVersion && session === sessionVersion && folder === state.folder) notify(messageError(error), true);
    } finally {
      if (version === listVersion) button.disabled = false;
    }
  }
  async function openMessage(id) {
    const context = { version: ++detailVersion, session: sessionVersion, folder: state.folder, id };
    state.selectedId = id; renderMessages();
    try {
      const data = await api((context.folder === "sent" ? "/api/outbound/" : "/api/messages/") + encodeURIComponent(id));
      if (!detailIsCurrent(context)) return;
      state.detail = data.message;
      if (context.folder === "inbox" && !data.message.isRead) {
        await api("/api/messages/" + encodeURIComponent(id), { method: "PATCH", body: { isRead: true } });
        if (context.session !== sessionVersion || !state.user) return;
        const cached = state.messages.inbox.find((message) => message.id === id); if (cached) cached.isRead = true;
        updateCounts();
        if (!detailIsCurrent(context)) return;
        data.message.isRead = true;
      }
      renderMessages(); renderDetail(data.message, context);
      document.querySelector(".mail-workspace").classList.add("detail-open");
    } catch (error) {
      if (detailIsCurrent(context)) { state.selectedId = null; renderMessages(); notify(messageError(error), true); }
    }
  }
  function actionButton(label, className, handler) {
    const button = element("button", "button " + className, label);
    button.type = "button"; button.addEventListener("click", handler); return button;
  }
  function renderDetail(message, context) {
    const sent = context.folder === "sent";
    const container = $("message-detail"); container.replaceChildren();
    const actions = element("div", "detail-actions"); const left = element("div", "detail-actions-left");
    left.append(actionButton("← 返回", "mobile-back", () => { document.querySelector(".mail-workspace").classList.remove("detail-open"); }));
    actions.append(left);
    if (sent) {
      actions.append(element("span", "sent-state", "✓ 发送服务器已接收"));
    } else {
      const unread = actionButton(message.isRead ? "标为未读" : "标为已读", "", async () => {
        unread.disabled = true;
        try {
          const isRead = !message.isRead;
          await api("/api/messages/" + encodeURIComponent(message.id), { method: "PATCH", body: { isRead } });
          if (context.session !== sessionVersion || !state.user) return;
          message.isRead = isRead;
          const cached = state.messages.inbox.find((entry) => entry.id === message.id); if (cached) cached.isRead = isRead;
          updateCounts();
          if (detailIsCurrent(context)) { renderMessages(); renderDetail(message, context); }
          notify(isRead ? "已标为已读" : "已标为未读");
        } catch (error) {
          if (context.session === sessionVersion) { notify(messageError(error), true); unread.disabled = false; }
        }
      });
      left.append(unread);
      actions.append(actionButton("删除邮件", "delete-button", async (event) => {
        const button = event.currentTarget; button.disabled = true;
        try {
          await api("/api/messages/" + encodeURIComponent(message.id), { method: "DELETE" });
          if (context.session !== sessionVersion || !state.user) return;
          state.messages.inbox = state.messages.inbox.filter((entry) => entry.id !== message.id); updateCounts();
          if (detailIsCurrent(context)) {
            detailVersion++; state.selectedId = null; state.detail = null; emptyDetail(); renderMessages();
          }
          notify("邮件已删除");
        } catch (error) {
          if (context.session === sessionVersion) { notify(messageError(error), true); button.disabled = false; }
        }
      }));
    }
    const senderLine = element("div", "sender-line");
    senderLine.append(element("span", "avatar", sender(message).slice(0, 1).toUpperCase()));
    const info = element("div", "sender-info");
    info.append(element("strong", "", sender(message)));
    if (!sent) info.append(element("small", "", message.fromAddress || ""));
    info.append(element("small", "", "收件人：" + (recipients(message) || state.user.email)));
    senderLine.append(info, element("time", "detail-date", formattedDate(message.createdAt, true)));
    container.append(actions, element("h2", "detail-title", message.subject || "（无主题）"), senderLine, element("div", "message-body", (sent ? message.text : message.textBody) || "此邮件没有纯文本正文。"));
    if (message.attachments?.length) {
      const section = element("section", "attachments"); section.append(element("h3", "", "附件 · " + message.attachments.length));
      for (const attachment of message.attachments) {
        const link = element("a", "attachment-link", attachment.filename || "未命名附件");
        link.href = (sent ? "/api/outbound/attachments/" : "/api/attachments/") + encodeURIComponent(attachment.id);
        link.setAttribute("download", ""); link.append(element("small", "", sizeLabel(attachment.size))); section.append(link);
      }
      container.append(section);
    }
  }

  function attachmentBytes() { return state.attachments.reduce((total, item) => total + item.file.size, 0); }
  function compositionEstimate() {
    const bytes = new TextEncoder().encode($("compose-text").value + $("compose-subject").value).byteLength;
    const encodedFiles = state.attachments.reduce((total, item) => total + Math.ceil(item.file.size / 3) * 4 * 1.03 + 512, 0);
    return { raw: bytes + attachmentBytes(), estimated: Math.ceil(bytes * 1.4 + encodedFiles + 1024) };
  }
  function renderComposeAttachments() {
    const list = $("compose-attachment-list"); list.replaceChildren();
    const bytes = attachmentBytes();
    $("attachment-total").textContent = state.attachments.length ? state.attachments.length + " / " + state.limits.maxAttachments + " 个 · " + sizeLabel(bytes) : state.limits.maxAttachments === 0 ? "附件已禁用" : "最多 " + state.limits.maxAttachments + " 个附件";
    $("attachment-limits").textContent = (state.limits.maxAttachments === 0 ? "附件已禁用，可发送文本邮件。" : "") + "单个附件上限 " + sizeLabel(state.limits.maxAttachmentBytes) + "；邮件含编码后大小上限 " + sizeLabel(state.limits.maxMessageBytes) + "。附件显示原始大小，最终由服务器核验。";
    const cannotAdd = sending || Boolean(state.sendUncertain) || state.limits.maxAttachments === 0;
    $("add-attachments").disabled = cannotAdd; $("compose-attachments").disabled = cannotAdd;
    for (const item of state.attachments) {
      const row = element("li");
      const name = element("span", "upload-filename", item.file.name); name.title = item.file.name;
      const remove = element("button", "icon-button remove-attachment", "×"); remove.type = "button";
      remove.disabled = sending || Boolean(state.sendUncertain); remove.setAttribute("aria-label", "移除附件 " + item.file.name);
      remove.addEventListener("click", () => {
        if (sending || state.sendUncertain) return;
        state.attachments = state.attachments.filter((entry) => entry.id !== item.id);
        renderComposeAttachments();
      });
      row.append(name, element("span", "upload-size", sizeLabel(item.file.size)), remove); list.append(row);
    }
    const estimate = compositionEstimate();
    const oversized = state.attachments.find((item) => item.file.size > state.limits.maxAttachmentBytes);
    $("attachment-warning").textContent = oversized
      ? "附件“" + oversized.file.name + "”超过单个附件上限 " + sizeLabel(state.limits.maxAttachmentBytes) + "，请移除此附件。"
      : estimate.raw > state.limits.maxMessageBytes
      ? "附件与正文的原始大小已超过邮件上限，请减少内容。"
      : state.attachments.length && estimate.estimated > state.limits.maxMessageBytes
        ? "按编码粗略估算约 " + sizeLabel(estimate.estimated) + "，可能超过上限，建议减少附件。"
        : "";
  }
  function setComposeBusy(busy) {
    sending = busy;
    $("send-button").disabled = busy || Boolean(state.sendUncertain);
    $("add-attachments").disabled = busy || Boolean(state.sendUncertain) || state.limits.maxAttachments === 0;
    $("new-compose").disabled = busy;
    $("check-send-status").disabled = busy;
    for (const id of ["compose-to", "compose-subject", "compose-text"]) $(id).readOnly = busy || Boolean(state.sendUncertain);
    renderComposeAttachments();
  }
  function setUncertain(id, status, explanation) {
    state.sendUncertain = { id, status };
    $("compose-error").textContent = explanation;
    $("compose-status-actions").hidden = false;
    $("check-send-status").textContent = id ? "核查发送状态" : "查看已发送";
    $("send-button").disabled = true;
  }
  function deliveryError(result) {
    const statuses = {
      pending: "发送尚未完成，请勿重复提交",
      temp_failed: "发送服务器暂时拒绝了邮件，可核查原因后手动重试",
      permanent_failed: "发送服务器拒绝了邮件，请检查收件人或附件",
      unknown: "发送结果尚未确认，请勿重复提交",
    };
    return (statuses[result.status] || "邮件未确认发送成功") + "。记录编号：" + result.id;
  }
  function completeSend() {
    resetCompose(); $("compose-dialog").close();
    switchFolder("sent"); notify("邮件已成功提交至发送服务器，可在已发送中查看");
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const version = ++sessionVersion;
    const button = event.submitter; button.disabled = true; $("login-error").textContent = "";
    try {
      const data = await api("/api/login", { method: "POST", body: { email: $("email").value.trim(), password: $("password").value } });
      if (version === sessionVersion) showMailbox(data);
    } catch (error) {
      if (version === sessionVersion) $("login-error").textContent = messageError(error);
    } finally { button.disabled = false; }
  });
  $("logout-button").addEventListener("click", async () => {
    const version = sessionVersion; const button = $("logout-button"); button.disabled = true;
    try { await api("/api/logout", { method: "POST" }); if (version === sessionVersion) showLogin(); }
    catch (error) { if (version === sessionVersion) notify(messageError(error), true); }
    finally { button.disabled = false; }
  });
  $("refresh-button").addEventListener("click", () => { void refreshMessages(); });
  $("inbox-nav").addEventListener("click", () => { switchFolder("inbox"); });
  $("sent-nav").addEventListener("click", () => { switchFolder("sent"); });
  $("search").addEventListener("input", (event) => { state.search = event.target.value; renderMessages(); });
  for (const filter of ["all", "unread"]) {
    $("filter-" + filter).addEventListener("click", () => {
      if (state.folder === "sent") return;
      state.filter = filter; updateFolderControls(); renderMessages();
    });
  }
  $("compose-button").addEventListener("click", () => {
    $("compose-dialog").showModal();
    if (!state.sendUncertain) $("compose-error").textContent = "";
    renderComposeAttachments(); $("compose-to").focus();
  });
  $("close-compose").addEventListener("click", () => { $("compose-dialog").close(); });
  $("add-attachments").addEventListener("click", () => { if (!sending && !state.sendUncertain && state.limits.maxAttachments > 0) $("compose-attachments").click(); });
  $("compose-attachments").addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []); event.target.value = "";
    if (sending || state.sendUncertain || !files.length) return;
    if (state.limits.maxAttachments === 0) {
      $("attachment-warning").textContent = "附件已禁用，可直接发送文本邮件。"; return;
    }
    const oversized = files.find((file) => file.size > state.limits.maxAttachmentBytes);
    if (oversized) {
      $("attachment-warning").textContent = "附件“" + oversized.name + "”超过单个附件上限 " + sizeLabel(state.limits.maxAttachmentBytes) + "，已保留原有选择。"; return;
    }
    if (state.attachments.length + files.length > state.limits.maxAttachments) {
      $("attachment-warning").textContent = "最多只能添加 " + state.limits.maxAttachments + " 个附件，已保留原有选择。"; return;
    }
    for (const file of files) state.attachments.push({ id: ++attachmentSequence, file });
    renderComposeAttachments();
  });
  $("compose-text").addEventListener("input", renderComposeAttachments);
  $("compose-subject").addEventListener("input", renderComposeAttachments);
  $("new-compose").addEventListener("click", () => { if (!sending) { resetCompose(); $("compose-to").focus(); } });
  $("check-send-status").addEventListener("click", async () => {
    const uncertain = state.sendUncertain;
    if (!uncertain || sending) return;
    if (!uncertain.id) {
      $("compose-dialog").close(); switchFolder("sent");
      notify("请核对收件人、主题和时间；记录尚未出现时，也请勿直接重复发送。", true); return;
    }
    const version = composeVersion; const session = sessionVersion;
    $("check-send-status").disabled = true;
    try {
      const result = await api("/api/outbound/" + encodeURIComponent(uncertain.id));
      if (version !== composeVersion || session !== sessionVersion || !state.user) return;
      if (result.message.status === "sent") { completeSend(); return; }
      $("compose-error").textContent = deliveryError(result.message);
      if (!["pending", "unknown"].includes(result.message.status)) {
        state.sendUncertain = null; $("compose-status-actions").hidden = true; setComposeBusy(false);
      }
    } catch (error) {
      if (version === composeVersion && session === sessionVersion) $("compose-error").textContent = "无法核查发送结果，请勿重复提交。记录编号：" + uncertain.id + "。" + messageError(error);
    } finally {
      if (version === composeVersion) $("check-send-status").disabled = false;
    }
  });
  $("compose-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending || state.sendUncertain || !state.user) return;
    if (state.attachments.some((item) => item.file.size > state.limits.maxAttachmentBytes)) {
      $("compose-error").textContent = "存在超过单个附件上限 " + sizeLabel(state.limits.maxAttachmentBytes) + " 的文件，请移除后再发送。"; return;
    }
    if (state.attachments.length > state.limits.maxAttachments || compositionEstimate().raw > state.limits.maxMessageBytes) {
      $("compose-error").textContent = "附件数量或邮件大小超过限制，请减少内容后再发送。"; return;
    }
    const session = sessionVersion; const version = composeVersion;
    $("compose-error").textContent = ""; setComposeBusy(true);
    const fields = { from: $("compose-from").value, to: [$("compose-to").value.trim()], subject: $("compose-subject").value, text: $("compose-text").value };
    let body = fields;
    if (state.attachments.length) {
      body = new FormData();
      body.append("from", fields.from); body.append("to", JSON.stringify(fields.to));
      body.append("subject", fields.subject); body.append("text", fields.text);
      for (const item of state.attachments) body.append("attachments", item.file, item.file.name);
    }
    try {
      const result = await api("/api/send", { method: "POST", body });
      if (session !== sessionVersion || version !== composeVersion || !state.user) return;
      if (result.status === "sent") { completeSend(); return; }
      const explanation = deliveryError(result);
      if (["pending", "unknown"].includes(result.status)) setUncertain(result.id, result.status, explanation);
      else $("compose-error").textContent = explanation;
    } catch (error) {
      if (session !== sessionVersion || version !== composeVersion || !state.user) return;
      if (!error.status || error.status >= 500) {
        setUncertain(null, "unknown", "未能确认发送结果，邮件可能已经提交。请先核查已发送和服务器记录，避免重复发送。" + messageError(error));
      } else $("compose-error").textContent = messageError(error);
    } finally {
      if (session === sessionVersion && version === composeVersion) setComposeBusy(false);
    }
  });
  const initialSession = sessionVersion;
  renderComposeAttachments();
  void api("/api/me").then((data) => {
    if (sessionVersion === initialSession) showMailbox(data);
  }).catch(() => { if (sessionVersion === initialSession) showLogin(); });
})();

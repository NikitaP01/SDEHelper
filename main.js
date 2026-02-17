(function () {
  const statusEl = document.getElementById("status");
  const gridEl = document.getElementById("grid");
  const inputEl = document.getElementById("memeRoot");
  const btnLoad = document.getElementById("btnLoad");
  const btnClear = document.getElementById("btnClear");
  const btnDiag = document.getElementById("btnDiag");

  const LAST_PATH_KEY = "sdehelper_last_meme_path";
  inputEl.value = localStorage.getItem(LAST_PATH_KEY) || "D:\\Мемасы\\Мемы";

  function setStatus(text) {
    statusEl.textContent = text;
    try { console.log("[SDEHelper]", text); } catch (e) {}
  }

  // ===== CEP Bridge =====
  const cs = new CSInterface();
  const evalQueue = [];
  let evalInFlight = false;
  let jsxLoaded = false;
  let jsxLoading = false;
  const jsxWaiters = [];

  function jsxEscapePath(p) {
    // Для строки JSX: экранируем обратные слэши и кавычки
    return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function flushJSXWaiters(result) {
    while (jsxWaiters.length) {
      const cb = jsxWaiters.shift();
      try { cb(result); } catch (e) { console.log("[SDEHelper] waiter error", e); }
    }
  }

  function pumpEvalQueue() {
    if (evalInFlight || evalQueue.length === 0) return;
    evalInFlight = true;
    const task = evalQueue.shift();
    const timeoutMs = task.timeoutMs || 8000;
    let done = false;

    setStatus("JSX call → " + task.label);
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      console.warn("[SDEHelper] evalScript TIMEOUT", task.label, task.script);
      setStatus("TIMEOUT: " + task.label);
      task.cb("TIMEOUT");
      evalInFlight = false;
      pumpEvalQueue();
    }, timeoutMs);

    cs.evalScript(task.script, (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      console.log("[SDEHelper] evalScript OK", task.label, result);
      task.cb(typeof result === "string" ? result : String(result));
      evalInFlight = false;
      pumpEvalQueue();
    });
  }

  function queuedEvalScript(script, cb, opts) {
    const options = opts || {};
    evalQueue.push({
      script,
      cb: cb || function () {},
      label: options.label || script,
      timeoutMs: options.timeoutMs || 8000
    });
    pumpEvalQueue();
  }

  // Грузим JSX из файла один раз и проверяем, что функции существуют
  function ensureJSXLoaded(cb) {
    if (jsxLoaded) return cb("OK");
    jsxWaiters.push(cb);
    if (jsxLoading) return;
    jsxLoading = true;

    try {
      const extPath = cs.getSystemPath(SystemPath.EXTENSION);
      const jsxPath = extPath + "/jsx/hostscript.jsx";
      const p = jsxEscapePath(jsxPath);

      setStatus("Загружаю JSX: " + jsxPath);
      queuedEvalScript('$.evalFile("' + p + '")', (loadRes) => {
        queuedEvalScript("typeof SDE_InsertMeme + '|' + typeof SDE_Ping", (types) => {
          const ok = types === "function|function";
          jsxLoaded = ok;
          jsxLoading = false;
          if (!ok) {
            const msg = "JSX не загружен корректно: " + types + " / " + loadRes;
            setStatus(msg);
            flushJSXWaiters("ERROR: " + msg);
            return;
          }
          setStatus("JSX загружен: " + types);
          flushJSXWaiters("OK");
        }, { label: "typeof SDE_InsertMeme/SDE_Ping" });
      }, { label: "$.evalFile(hostscript.jsx)", timeoutMs: 10000 });
    } catch (e) {
      jsxLoading = false;
      const msg = "Ошибка loadJSX: " + e.toString();
      setStatus(msg);
      flushJSXWaiters("ERROR: " + msg);
    }
  }

  function pingPremiere() {
    queuedEvalScript("app.version", function (v) {
      if (!v || v === "TIMEOUT") return setStatus("Premiere не ответил на app.version");
      setStatus("Связь с Premiere OK. Версия: " + v);
      ensureJSXLoaded(function (res) {
        if (res !== "OK") setStatus(res);
      });
    }, { label: "app.version", timeoutMs: 5000 });
  }

  pingPremiere();

  // ===== Node.js (для чтения папок) =====
  let fs, path;
  let childProcess;
  try {
    fs = window.require("fs");
    path = window.require("path");
    childProcess = window.require("child_process");
  } catch (e) {}

  function copyTextFallback(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  function offerManualInsertFallback(cachedPathWin, reason) {
    const why = reason ? ("(" + reason + ")") : "";
    const copied = copyTextFallback(cachedPathWin);

    if (childProcess && process && process.platform === "win32") {
      try {
        childProcess.exec('explorer /select,"' + cachedPathWin.replace(/"/g, '\\"') + '"');
      } catch (e) {}
    }

    if (copied) {
      setStatus("Bridge недоступен " + why + ". Путь скопирован — вставь/перетащи мем в Premiere вручную.");
    } else {
      setStatus("Bridge недоступен " + why + ". Открыл файл в Explorer — перетащи мем в Premiere вручную.");
    }
  }

  function clearGrid() { gridEl.innerHTML = ""; }

  function toFileUrl(winPath) {
    const p = winPath.replace(/\\/g, "/");
    return encodeURI("file:///" + p);
  }

  function scanMp4(root) {
    const result = [];
    function walk(dir) {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) walk(full);
        else if (it.isFile() && it.name.toLowerCase().endsWith(".mp4")) result.push(full);
      }
    }
    walk(root);
    return result;
  }

  // Вставка мемов: передаём путь в ASCII (encodeURIComponent), чтобы кириллица не ломала evalScript
  function insertMemeToPremiere(filePath) {
    if (!fs || !path) {
      setStatus("Node.js недоступен — не могу копировать файл в кэш.");
      return;
    }

    const os = window.require("os");
    const crypto = window.require("crypto");

    const cacheDir = path.join(os.tmpdir(), "SDEHelperCache");
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) {}

    const ext = (path.extname(filePath) || ".mp4").toLowerCase();
    const hash = crypto.createHash("md5").update(filePath + Date.now()).digest("hex").slice(0, 10);
    const cachedPathWin = path.join(cacheDir, "meme_" + hash + ext);

    setStatus("Копирую мем в кэш...");

    fs.copyFile(filePath, cachedPathWin, (err) => {
      if (err) {
        setStatus("Ошибка копирования в кэш: " + err.message);
        return;
      }

      // Важно: передавать путь со слэшами — Premiere/ExtendScript любит так больше
      const cachedPath = cachedPathWin.replace(/\\/g, "/");

      ensureJSXLoaded((loadRes) => {
        if (loadRes !== "OK") return setStatus(loadRes);

        // 1) Проверяем, что JSX вообще отвечает на нашу функцию
        setStatus("Ping JSX...");
        queuedEvalScript("SDE_Ping()", (pong) => {
          setStatus("Ping ответ: " + pong);
          if (pong !== "PONG") return;

          // 2) Вставка (путь передаём безопасно через JSON.stringify)
          setStatus("Вставляю в таймлайн...");
          const call = "SDE_InsertMeme(" + JSON.stringify(cachedPath) + ")";
          queuedEvalScript(call, (res) => {
            setStatus("Ответ Premiere: " + (res === "" ? "(пусто)" : res));
          }, { label: "SDE_InsertMeme", timeoutMs: 15000 });
        }, { label: "SDE_Ping", timeoutMs: 5000 });
      });
    });
  }

  function addCard(filePath) {
    const fileName = filePath.split("\\").pop();

    const card = document.createElement("div");
    card.className = "card";
    card.title = "Клик: вставить в таймлайн (плейхед, V2)";

    const wrap = document.createElement("div");
    wrap.className = "thumbWrap";

    const vid = document.createElement("video");
    vid.src = toFileUrl(filePath);
    vid.muted = true;
    vid.loop = true;
    vid.playsInline = true;
    vid.preload = "metadata";

    card.addEventListener("mouseenter", () => { try { vid.play(); } catch (e) {} });
    card.addEventListener("mouseleave", () => { try { vid.pause(); } catch (e) {} });

    wrap.appendChild(vid);

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = fileName;

    card.appendChild(wrap);
    card.appendChild(title);
    gridEl.appendChild(card);

    card.addEventListener("click", () => insertMemeToPremiere(filePath));
    return card;
  }

  // ===== Buttons =====
  btnClear.addEventListener("click", () => {
    clearGrid();
    setStatus("Очищено.");
  });

  btnDiag.addEventListener("click", runBridgeDiagnostics);

  btnDiag.addEventListener("click", runBridgeDiagnostics);

  btnDiag.addEventListener("click", runBridgeDiagnostics);

  btnLoad.addEventListener("click", () => {
    const root = inputEl.value.trim();
    if (!root) return setStatus("Укажи путь к папке с мемами.");

    localStorage.setItem(LAST_PATH_KEY, root);

    if (!fs) return setStatus("Node.js недоступен — не могу читать папки.");

    clearGrid();
    setStatus("Сканирую папки...");

    let files = [];
    try {
      files = scanMp4(root);
    } catch (e) {
      return setStatus("Ошибка чтения папки: " + e.message);
    }

    const LIMIT = 120;
    const show = files.slice(0, LIMIT);

    setStatus(`Найдено мемов: ${files.length}. Показано: ${show.length}`);
    show.forEach(addCard);
  });

})();

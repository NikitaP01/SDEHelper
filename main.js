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

    console.log("[SDEHelper] evalScript call", task.label, task.script);
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      console.warn("[SDEHelper] evalScript TIMEOUT", task.label, task.script);
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

  function isEvalFailure(result) {
    if (!result) return true;
    return result === "TIMEOUT" || /^EvalScript error\./i.test(result) || /^ERROR:/i.test(result);
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
      const checkTypes = () => {
        queuedEvalScript("typeof SDE_InsertMeme + '|' + typeof SDE_Ping", (types) => {
          const ok = types === "function|function";
          jsxLoaded = ok;
          jsxLoading = false;
          if (!ok) {
            const msg = "JSX не загружен корректно: " + types;
            setStatus(msg);
            flushJSXWaiters("ERROR: " + msg);
            return;
          }
          setStatus("JSX загружен: " + types);
          flushJSXWaiters("OK");
        }, { label: "typeof SDE_InsertMeme/SDE_Ping", timeoutMs: 5000 });
      };

      // Если ScriptPath уже загрузил JSX, не вызываем $.evalFile лишний раз.
      queuedEvalScript("typeof SDE_InsertMeme + '|' + typeof SDE_Ping", (typesBefore) => {
        if (typesBefore === "function|function") {
          jsxLoaded = true;
          jsxLoading = false;
          setStatus("JSX уже загружен: " + typesBefore);
          flushJSXWaiters("OK");
          return;
        }

        const loadCall = '(function(){try{var f=File("' + p + '"); if(!f.exists){return "ERROR: JSX file not found";} $.evalFile(f); return "OK";}catch(e){return "ERROR: " + e.toString();}})()';
        queuedEvalScript(loadCall, (loadRes) => {
          if (isEvalFailure(loadRes)) {
            jsxLoading = false;
            const msg = "Не удалось загрузить JSX: " + loadRes;
            setStatus(msg);
            flushJSXWaiters("ERROR: " + msg);
            return;
          }
          checkTypes();
        }, { label: "$.evalFile(hostscript.jsx)", timeoutMs: 12000 });
      }, { label: "check JSX exports", timeoutMs: 5000 });
    } catch (e) {
      jsxLoading = false;
      const msg = "Ошибка loadJSX: " + e.toString();
      setStatus(msg);
      flushJSXWaiters("ERROR: " + msg);
    }
  }

  function pingPremiere(attempt) {
    const tryNum = attempt || 1;

    // Сначала быстрый probe движка ExtendScript.
    queuedEvalScript("$.engineName", function (engine) {
      if (!engine || engine === "TIMEOUT") {
        if (tryNum < 3) {
          setStatus("Нет ответа от ExtendScript (попытка " + tryNum + "), повтор...");
          return setTimeout(() => pingPremiere(tryNum + 1), 700);
        }
        return setStatus("Premiere не ответил на ExtendScript probe");
      }

      // Не блокируем старт панели на app.version: в некоторых сборках/состояниях он зависает.
      setStatus("Связь с Premiere OK (engine: " + engine + ")");
      ensureJSXLoaded(function (res) {
        if (res !== "OK") setStatus(res);
      });
    }, { label: "$.engineName", timeoutMs: 3500 });
  }

  pingPremiere();

  function runBridgeDiagnostics() {
    const started = Date.now();
    const report = [];

    function step(label, script, timeoutMs, next) {
      const t0 = Date.now();
      queuedEvalScript(script, (res) => {
        const ms = Date.now() - t0;
        const line = `[${label}] ${res} (${ms}ms)`;
        report.push(line);
        console.log("[SDEHelper][diag]", line);
        if (next) next(res);
      }, { label: `diag:${label}`, timeoutMs });
    }

    setStatus("Диагностика bridge запущена...");
    step("1+1", "1+1", 2000, () => {
      step("engine", "$.engineName", 3500, () => {
        step("typeof SDE_Ping", "typeof SDE_Ping", 3500, () => {
          step("SDE_Ping()", "SDE_Ping()", 5000, () => {
            const total = Date.now() - started;
            setStatus("Диагностика завершена за " + total + "ms. Подробности в Console.");
            console.log("[SDEHelper][diag] full report:\n" + report.join("\n"));
          });
        });
      });
    });
  }

  // ===== Node.js (для чтения папок) =====
  let fs, path;
  try {
    fs = window.require("fs");
    path = window.require("path");
  } catch (e) {}

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

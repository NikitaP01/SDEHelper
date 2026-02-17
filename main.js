(function () {
  const statusEl = document.getElementById("status");
  const gridEl = document.getElementById("grid");
  const inputEl = document.getElementById("memeRoot");
  const btnLoad = document.getElementById("btnLoad");
  const btnClear = document.getElementById("btnClear");

  const LAST_PATH_KEY = "sdehelper_last_meme_path";
  inputEl.value = localStorage.getItem(LAST_PATH_KEY) || "D:\\Мемасы\\Мемы";

  function setStatus(text) {
    statusEl.textContent = text;
    try { console.log("[SDEHelper]", text); } catch (e) {}
  }

  // ===== CEP Bridge =====
  const cs = new CSInterface();

  function jsxEscapePath(p) {
    // Для строки JSX: экранируем обратные слэши и кавычки
    return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // Грузим JSX из файла и проверяем, что функция существует
  function loadJSX() {
    try {
      const extPath = cs.getSystemPath(SystemPath.EXTENSION);
      const jsxPath = extPath + "/jsx/hostscript.jsx";

      setStatus("Загружаю JSX: " + jsxPath);

      cs.evalScript("app.version", (v) => {
        if (!v) return setStatus("Premiere не ответил на app.version (evalScript не работает)");

        const p = jsxEscapePath(jsxPath);
        cs.evalScript('$.evalFile("' + p + '")', () => {
          cs.evalScript("typeof SDE_InsertMeme", (t) => {
            setStatus("JSX: typeof SDE_InsertMeme = " + t);
          });
        });
      });
    } catch (e) {
      setStatus("Ошибка loadJSX: " + e.toString());
    }
  }

  function pingPremiere() {
    cs.evalScript("app.version", function (v) {
      setStatus("Связь с Premiere OK. Версия: " + v);
      loadJSX();
    });
  }

  pingPremiere();

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

      // 1) Проверяем, что JSX вообще отвечает на нашу функцию
      setStatus("Ping JSX...");
      cs.evalScript("SDE_Ping()", (pong) => {
        setStatus("Ping ответ: " + pong);

        // 2) Вставка (путь передаём безопасно через JSON.stringify)
        setStatus("Вставляю в таймлайн...");

        let gotReply = false;
        const timer = setTimeout(() => {
          if (!gotReply) setStatus("Нет ответа от Premiere на SDE_InsertMeme (скорее всего зависает importFiles).");
        }, 6000);

        const call = "SDE_InsertMeme(" + JSON.stringify(cachedPath) + ")";
        cs.evalScript(call, (res) => {
          gotReply = true;
          clearTimeout(timer);
          setStatus("Ответ Premiere: " + (res === "" ? "(пусто)" : res));
        });
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

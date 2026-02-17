/* hostscript.jsx */

function SDE_Ping() {
    try {
        return "PONG";
    } catch (e) {
        return "ERROR: " + e.toString();
    }
}

// Возвращает строку "OK" или текст ошибки
function SDE_InsertMemeAtSelectionEnd(filePath) {
    try {
        if (!filePath || typeof filePath !== "string") return "ERROR: пустой путь";
        var f = new File(filePath);
        if (!f.exists) return "ERROR: файл не найден: " + filePath;

        if (!app.project) return "Нет проекта";
        var seq = app.project.activeSequence;
        if (!seq) return "Нет активной Sequence (открой таймлайн)";

        // 1) Находим выделенные клипы на таймлайне (обычно выделяешь один)
        var selected = seq.getSelection();
        if (!selected || selected.length < 1) return "Ничего не выделено на таймлайне";

        // Берём первый выделенный элемент
        var clip = selected[0];

        // 2) Конец выделенного клипа (в секундах)
        // clip.end — это Time object
        var insertTime = clip.end;

        // 3) Импортируем мем в проект (в текущий insertion bin)
        var bin = app.project.getInsertionBin();
        var ok = app.project.importFiles([filePath], 1, bin, 0);
        if (!ok) return "Не смог импортировать файл";

        // 4) Берём последний импортированный item
        if (!bin.children || bin.children.numItems < 1) return "bin пуст после импорта";
        var item = bin.children[bin.children.numItems - 1];
        if (!item) return "Не найден item после импорта";

        // 5) Вставляем на V2
        var vTrack = seq.videoTracks[1];
        if (!vTrack) return "Нет дорожки V2 (создай V2 на таймлайне)";

        vTrack.insertClip(item, insertTime);

        return "OK";
    } catch (e) {
        return "ERROR: " + e.toString();
    }
}

function SDE_InsertMeme(filePath) {
    return SDE_InsertMemeAtSelectionEnd(filePath);
}

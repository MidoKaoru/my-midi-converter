import { processMidiData } from './midi-core.js';

// ★★★ アプリケーション状態管理 ★★★
const MidiApp = (() => {
    let sectionCounter = 0;

    // セクション追加
    function addSection() {
        sectionCounter++;
        const container = document.getElementById('sectionContainer');
        const div = document.createElement('div');
        div.className = 'section-item';
        div.id = `section-${sectionCounter}`;
        div.innerHTML = `
            <button class="remove-btn" onclick="MidiApp.removeSection('section-${sectionCounter}')">削除</button>
            <strong>📍 セクション ${sectionCounter}</strong><br>
            <input type="number" placeholder="開始" min="1" class="section-start"> 〜
            <input type="number" placeholder="終了" min="1" class="section-end"> 小節目<br>
            <div style="margin-top: 8px;">
                <label style="margin-right: 10px;">
                    <input type="radio" name="section_${sectionCounter}" value="regular" checked>
                    8分
                </label>
                <label>
                    <input type="radio" name="section_${sectionCounter}" value="half">
                    16分
                </label>
            </div>
        `;
        container.appendChild(div);
    }

    // セクション削除
    function removeSection(id) {
        document.getElementById(id)?.remove();
    }

    // 一括設定
    function setAllSections(mode) {
        document.querySelectorAll('.section-item input[type="radio"]').forEach(radio => {
            if (radio.value === mode) radio.checked = true;
        });
    }

    // セクション情報を収集
    function getSections() {
        const sections = [];
        document.querySelectorAll('.section-item').forEach(item => {
            const start = parseInt(item.querySelector('.section-start').value);
            const end = parseInt(item.querySelector('.section-end').value);
            const mode = item.querySelector('input[type="radio"]:checked').value;
            
            if (!isNaN(start) && !isNaN(end) && start <= end) {
                sections.push({ start, end, mode });
            }
        });
        return sections;
    }

    return { addSection, removeSection, setAllSections, getSections };
})();

// グローバルに公開（HTML の onclick から呼び出すため）
window.MidiApp = MidiApp;

// ★★★ UI イベントハンドラ ★★★
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const statusMsg = document.getElementById('status');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) processFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) processFile(e.target.files[0]);
});

// ★★★ ファイル処理（セクション対応版） ★★★
async function processFile(file) {
    if (!file.name.toLowerCase().endsWith('.mid') && !file.name.toLowerCase().endsWith('.midi')) {
        showStatus('red', 'エラー：.mid ファイルを選択してください。');
        fileInput.value = '';
        return;
    }

    showStatus('#007bff', '変換中...');

    try {
        const defaultMode = document.querySelector('input[name="defaultShuffleType"]:checked').value;
        const sections = MidiApp.getSections();

        // ★ セクション設定の検証
        if (sections.length > 0) {
            // 範囲の重複チェック
            for (let i = 0; i < sections.length; i++) {
                for (let j = i + 1; j < sections.length; j++) {
                    const a = sections[i], b = sections[j];
                    if (!(a.end < b.start || b.end < a.start)) {
                        showStatus('red', `エラー：セクション ${i+1} と ${j+1} の範囲が重複しています。`);
                        fileInput.value = '';
                        return;
                    }
                }
            }
        }

        // ★ 変換実行（セクション情報を渡す）
        const processedMidi = await processMidiData(file, defaultMode, sections);
        
        const midiArray = processedMidi.toArray();
        const blob = new Blob([midiArray], { type: "audio/midi" });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement("a");
        const baseName = file.name.replace(/\.mid(i)?$/i, '');
        a.href = url;
        a.download = `${baseName}_even.mid`; 
        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            fileInput.value = '';
        }, 100);

        showStatus('green', `変換完了！「_even.mid」のダウンロードが開始されました。`);
    } catch (error) {
        console.error(error);
        showStatus('red', 'エラーが発生しました: ' + error.message);
        fileInput.value = '';
    }
}

function showStatus(color, message) {
    statusMsg.style.color = color;
    statusMsg.innerText = message;
    statusMsg.style.backgroundColor = color === 'red' ? '#fff2f2' : color === 'green' ? '#f2fff2' : 'transparent';
}
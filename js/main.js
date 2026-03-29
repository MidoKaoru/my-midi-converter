import { processMidiData } from './midi-core.js';

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

async function processFile(file) {
    if (!file.name.toLowerCase().endsWith('.mid') && !file.name.toLowerCase().endsWith('.midi')) {
        showStatus('red', 'エラー：.mid ファイルを選択してください。');
        fileInput.value = '';
        return;
    }

    showStatus('#007bff', '変換中...');

    try {
        // ▼ 選択されているラジオボタンの値（'regular' か 'half'）を取得
        const shuffleType = document.querySelector('input[name="shuffleType"]:checked').value;

        // ▼ 第2引数として shuffleType を渡す
        const processedMidi = await processMidiData(file, shuffleType);
        
        const midiArray = processedMidi.toArray();
        const blob = new Blob([midiArray], { type: "audio/midi" });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement("a");
        const baseName = file.name.replace(/\.mid(i)?$/i, '');
        // ファイル名も分かりやすく分岐
        const suffix = (shuffleType === 'half') ? '_even_half' : '_even';
        a.href = url;
        a.download = `${baseName}${suffix}.mid`; 
        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            fileInput.value = '';
        }, 100);

        showStatus('green', `変換完了！「${suffix}.mid」のダウンロードが開始されました。`);
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
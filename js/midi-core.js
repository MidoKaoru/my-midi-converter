import { parseMidi, writeMidi } from 'https://esm.sh/midi-file';

export async function processMidiData(file, shuffleType) {
    const arrayBuffer = await file.arrayBuffer();
    const originalUint8 = new Uint8Array(arrayBuffer);

    // ==========================================
    // 【第1フェーズ：抽出】
    // ==========================================
    const originalParsed = parseMidi(originalUint8);
    const originalKeySignatures = [];
    
    originalParsed.tracks.forEach(track => {
        track.forEach(event => {
            if (event.type === 'keySignature') {
                originalKeySignatures.push({ ...event, deltaTime: 0 });
            }
        });
    });

    // ==========================================
    // 【第2フェーズ：変換 (Tone.js)】
    // ==========================================
    const midi = new window.Midi(arrayBuffer);
    const PPQ = midi.header.ppq;
    const RES = (shuffleType === 'half') ? PPQ / 2 : PPQ;
    const tolerance = RES * 0.08; 

    function quantizeTick(tick) {
        const beat = Math.floor(tick / RES);
        let relTick = tick % RES;
        
        if (relTick >= RES - tolerance) return (beat + 1) * RES;
        if (relTick <= tolerance) return beat * RES;

        const trip1 = Math.round(RES / 3);
        const trip2 = Math.round(RES * 2 / 3);
        const half  = Math.round(RES / 2);

        if (Math.abs(relTick - trip1) <= tolerance || Math.abs(relTick - trip2) <= tolerance || Math.abs(relTick - half) <= tolerance) {
            return beat * RES + half;
        }

        const subGrid = RES / 4; 
        const snappedRelTick = Math.round(relTick / subGrid) * subGrid;
        return beat * RES + snappedRelTick;
    }

    midi.tracks.forEach(track => {
        const beats = {};
        track.notes.forEach(note => {
            const beatIndex = Math.floor(note.ticks / RES);
            if (!beats[beatIndex]) beats[beatIndex] = [];
            beats[beatIndex].push(note);
        });

        const protectedBeats = new Set();
        const trip1 = Math.round(RES / 3);

        for (const beatIndex in beats) {
            const positions = [];
            beats[beatIndex].forEach(note => {
                const relTick = note.ticks % RES;
                if (!positions.some(p => Math.abs(p - relTick) <= tolerance)) {
                    positions.push(relTick);
                }
            });

            const hasTrip1 = positions.some(p => Math.abs(p - trip1) <= tolerance);
            if (hasTrip1 || positions.length >= 3) {
                protectedBeats.add(parseInt(beatIndex));
            }
        }

        track.notes.forEach(note => {
            const beatIndex = Math.floor(note.ticks / RES);
            if (protectedBeats.has(beatIndex)) return; 

            const originalStartTick = note.ticks;
            const originalEndTick = note.ticks + note.durationTicks;

            const newStartTick = quantizeTick(originalStartTick);
            const newEndTick = quantizeTick(originalEndTick);

            note.ticks = newStartTick;
            
            const rawDuration = newEndTick - newStartTick;
            const durationGrid = PPQ / 4; 
            const quantizedDuration = Math.round(rawDuration / durationGrid) * durationGrid;
            note.durationTicks = Math.max(durationGrid, quantizedDuration); 
        });
    });

    // Tone.jsの仕様による空トラック生成を抑制するためのクリーンアップ
    midi.header.keySignatures = [];
    delete midi.header.name;
    midi.tracks.forEach(track => delete track.name);
    midi.tracks = midi.tracks.filter(track => track.notes.length > 0);

    const toneExportedUint8 = midi.toArray();


    // ==========================================
    // 【第3フェーズ：修復と統合 (パッチ当て)】
    // ==========================================
    const finalParsed = parseMidi(toneExportedUint8);

    // 1. キー情報の注入
    if (originalKeySignatures.length > 0 && finalParsed.tracks.length > 0) {
        finalParsed.tracks[0] = [...originalKeySignatures, ...finalParsed.tracks[0]];
    }

    // 2. Track 0 (マスタートラック) と Track 1 (最初の楽器) をマージするヘルパー関数
    function mergeTracks(track1, track2) {
        // deltaTime を「絶対時間(ticks)」に変換して計算しやすくする
        let time1 = 0;
        const abs1 = track1.map(e => { time1 += e.deltaTime; return { ...e, _abs: time1 }; });
        let time2 = 0;
        const abs2 = track2.map(e => { time2 += e.deltaTime; return { ...e, _abs: time2 }; });

        // 末尾のEnd of Trackイベントを一旦取り除く
        const filtered1 = abs1.filter(e => e.type !== 'endOfTrack');
        const filtered2 = abs2.filter(e => e.type !== 'endOfTrack');

        // 2つのトラックのイベントをマージして、時間順に並び替える
        const merged = [...filtered1, ...filtered2].sort((a, b) => {
            if (a._abs !== b._abs) return a._abs - b._abs;
            // 時間が同じ場合は、テンポなどのメタイベントを音符より前に置く
            const aIsNote = ('channel' in a) ? 1 : 0;
            const bIsNote = ('channel' in b) ? 1 : 0;
            return aIsNote - bIsNote; 
        });

        // 並び替えた後、最後に1つだけEnd of Trackを付け直す
        const maxTime = merged.length > 0 ? merged[merged.length - 1]._abs : Math.max(time1, time2);
        merged.push({ type: 'endOfTrack', deltaTime: 0, _abs: maxTime });

        // 絶対時間を再び「待機時間(deltaTime)」に計算し直す
        let current = 0;
        return merged.map(e => {
            const dt = e._abs - current;
            current = e._abs;
            delete e._abs; // 作業用のプロパティを消す
            return { ...e, deltaTime: dt };
        });
    }

    // もしトラックが2つ以上ある場合、マスタートラック(0)と最初の楽器(1)を結合する
    if (finalParsed.tracks.length >= 2) {
        finalParsed.tracks[0] = mergeTracks(finalParsed.tracks[0], finalParsed.tracks[1]);
        // 結合して空っぽになったTrack 1を配列から削除する
        finalParsed.tracks.splice(1, 1);
    }

    const finalUint8 = new Uint8Array(writeMidi(finalParsed));

    return {
        toArray: () => finalUint8
    };
}